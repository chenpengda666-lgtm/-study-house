import { DurableObject } from "cloudflare:workers";

// Upload sessions plus blob storage, built on Durable Objects so no paid
// product (R2) is required.
//
// FileStore holds metadata; each file's bytes live in its own BlobStore object,
// which spreads storage across objects and keeps any single object far from its
// 1 GB cap.
//
// Transfers are deliberately chopped into small RPC calls. This runtime's
// Durable Object RPC drops an argument object entirely when one of its fields
// carries a very large string, so a part is written as several bounded chunks
// rather than one big payload. The same limit is why nothing relies on query
// parameters, custom headers, or URL sub-paths reaching the object: all three
// are stripped or rewritten in transit.

const MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1 GiB
const PART_SIZE = 2 * 1024 * 1024; // 2 MiB per part; fewer parts means fewer round trips
const CHUNK_SIZE = 256 * 1024; // base64 chars per RPC call
const MAX_PARTS = 4096;

function newFileId() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const SIZE = 8192;
  let bin = "";
  for (let i = 0; i < bytes.length; i += SIZE) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + SIZE));
  }
  return btoa(bin);
}

function jsonOut(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// BlobStore: part bytes for a single file.
// ---------------------------------------------------------------------------

export class BlobStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        part_no    INTEGER NOT NULL,
        chunk_idx  INTEGER NOT NULL,
        start_off  INTEGER NOT NULL DEFAULT 0,
        end_off    INTEGER NOT NULL DEFAULT 0,
        bytes      BLOB    NOT NULL,
        size       INTEGER NOT NULL,
        PRIMARY KEY (part_no, chunk_idx)
      );
    `);
    // start_off/end_off are reserved for a future offset-indexed read path.
    // They are not maintained: parts arrive in upload order rather than file
    // order, so a running-total offset would silently misplace data.
    const cols = new Set(
      this.sql.exec(`PRAGMA table_info(chunks)`).toArray().map((r) => r.name),
    );
    if (!cols.has("start_off")) {
      this.sql.exec(`ALTER TABLE chunks ADD COLUMN start_off INTEGER NOT NULL DEFAULT 0`);
    }
    if (!cols.has("end_off")) {
      this.sql.exec(`ALTER TABLE chunks ADD COLUMN end_off INTEGER NOT NULL DEFAULT 0`);
    }
  }

  async putPartChunk({ partNumber, chunkIndex, chunkBase64 }) {
    const n = Number(partNumber);
    const idx = Number(chunkIndex);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PARTS) return { error: "bad_part_number" };
    if (!Number.isInteger(idx) || idx < 0) return { error: "bad_chunk_index" };
    if (typeof chunkBase64 !== "string" || !chunkBase64) return { error: "empty_chunk" };

    let buf;
    try {
      buf = base64ToBytes(chunkBase64);
    } catch {
      return { error: "bad_base64" };
    }
    if (buf.byteLength === 0) return { error: "empty_chunk" };

    this.sql.exec(
      `INSERT OR REPLACE INTO chunks (part_no, chunk_idx, bytes, size) VALUES (?, ?, ?, ?)`,
      n,
      idx,
      buf,
      buf.byteLength,
    );
    const row = this.sql
      .exec(`SELECT COUNT(DISTINCT part_no) AS parts FROM chunks`)
      .toArray()[0];
    return { ok: true, size: buf.byteLength, parts: Number(row?.parts ?? 0) };
  }

  async stat() {
    const row = this.sql
      .exec(`SELECT COUNT(DISTINCT part_no) AS parts, COALESCE(SUM(size), 0) AS used FROM chunks`)
      .toArray()[0];
    return { parts: Number(row?.parts ?? 0), used: Number(row?.used ?? 0) };
  }

  async purge() {
    const row = this.sql.exec(`SELECT COUNT(*) AS cnt FROM chunks`).toArray()[0];
    this.sql.exec(`DELETE FROM chunks`);
    return { ok: true, removed: Number(row?.cnt ?? 0) };
  }

  // Returns a whole part as ordered base64 chunks. Whole-part granularity keeps
  // the caller free of offset bookkeeping: a part is at most ~1.4 MB of base64,
  // which is a fine unit to hand back in one call.
  async getPart({ partNumber }) {
    const n = Number(partNumber);
    const rows = this.sql
      .exec(`SELECT bytes FROM chunks WHERE part_no = ? ORDER BY chunk_idx`, n)
      .toArray();
    if (rows.length === 0) return { ok: false };
    return {
      ok: true,
      chunks: rows.map((r) =>
        bytesToBase64(r.bytes instanceof ArrayBuffer ? new Uint8Array(r.bytes) : r.bytes),
      ),
    };
  }

  // Reads an exact byte window from this object's storage. Parts are read whole
  // and sliced here: computing offsets from a running total would break because
  // parts arrive in upload order, not file order. A part is at most ~2.8 MB of
  // base64, which is a fine unit to fetch.
  async readWindow({ offset, length }) {
    const start = Math.max(0, Number(offset) || 0);
    const want = Math.max(1, Number(length) || 1);
    const firstPart = Math.floor(start / PART_SIZE) + 1;
    const lastPart = Math.floor((start + want - 1) / PART_SIZE) + 1;

    const out = [];
    let skip = start - (firstPart - 1) * PART_SIZE;
    let remaining = want;

    for (let n = firstPart; n <= lastPart && remaining > 0; n++) {
      const res = await this.getPart({ partNumber: n });
      if (!res.ok || !res.chunks?.length) break;

      for (const b64 of res.chunks) {
        let view = base64ToBytes(b64);
        if (skip > 0) {
          if (view.byteLength <= skip) {
            skip -= view.byteLength;
            continue;
          }
          view = view.subarray(skip);
          skip = 0;
        }
        if (view.byteLength > remaining) view = view.subarray(0, remaining);
        out.push(bytesToBase64(view));
        remaining -= view.byteLength;
        if (remaining <= 0) break;
      }
      skip = 0;
    }

    return { ok: true, chunks: out };
  }
}

// ---------------------------------------------------------------------------
// FileStore: upload sessions and file metadata.
// ---------------------------------------------------------------------------

export class FileStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.sql = ctx.storage.sql;

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS uploads (
        upload_id  TEXT PRIMARY KEY,
        channel    TEXT NOT NULL,
        actor_id   TEXT NOT NULL,
        nick       TEXT NOT NULL,
        name       TEXT NOT NULL,
        mime       TEXT NOT NULL,
        bytes      INTEGER NOT NULL,
        sig        TEXT,
        received   INTEGER NOT NULL DEFAULT 0,
        status     TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_uploads_created ON uploads(created_at);`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_uploads_sig ON uploads(sig);`);

    const cols = new Set(this.sql.exec(`PRAGMA table_info(uploads)`).toArray().map((r) => r.name));
    if (!cols.has("channel")) this.sql.exec(`ALTER TABLE uploads ADD COLUMN channel TEXT`);
    if (!cols.has("received")) this.sql.exec(`ALTER TABLE uploads ADD COLUMN received INTEGER DEFAULT 0`);
  }

  #blobFor(channel) {
    // Must come from the BlobStore binding: obtaining the stub through the
    // FileStore binding yields a FileStore receiver, which has no blob methods.
    return this.env.BLOB_STORE.get(this.env.BLOB_STORE.idFromName(`blob:${channel}`));
  }

  #roomStub() {
    return this.env.CHAT_ROOMS.get(this.env.CHAT_ROOMS.idFromName("main"));
  }

  async #capacity() {
    return (await this.#roomStub().fetch(new Request("https://room.internal/capacity"))).json();
  }

  async #recordInRoom(payload) {
    const res = await this.#roomStub().fetch(
      new Request("https://room.internal/record", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
    return res.json();
  }

  async initSession() {
    const current = await this.ctx.storage.getAlarm();
    if (current == null) await this.ctx.storage.setAlarm(Date.now() + 6 * 3600_000);
    return { ok: true };
  }

  async createUpload(params) {
    const actorId = params?.actorId;
    const nick = params?.nick;
    const name = params?.name;
    const mime = params?.mime;
    const sig = params?.sig;
    const size = Number(params?.bytes) || 0;

    if (!Number.isFinite(size) || size <= 0) return { error: "bad_size" };
    if (size > MAX_FILE_BYTES) {
      return { error: "too_large", max: MAX_FILE_BYTES, maxFileBytes: MAX_FILE_BYTES };
    }

    const quota = await this.#capacity();
    if (quota?.usedBytes + size > quota?.quotaBytes) {
      return {
        error: "quota_exceeded",
        usedBytes: quota.usedBytes,
        quotaBytes: quota.quotaBytes,
        remainingBytes: quota.remainingBytes,
        maxFileBytes: MAX_FILE_BYTES,
      };
    }

    const signature = typeof sig === "string" && sig.length >= 8 && sig.length <= 64 ? sig : null;

    if (signature) {
      const done = this.sql
        .exec(
          `SELECT upload_id, channel, name, mime, bytes FROM uploads
           WHERE sig = ? AND status = 'done' ORDER BY created_at DESC LIMIT 1`,
          signature,
        )
        .toArray()[0];
      if (done) {
        const recorded = await this.#recordInRoom({
          actorId,
          nick,
          fileId: done.upload_id,
          storeChannel: done.channel,
          name: done.name,
          mime: done.mime,
          bytes: done.bytes,
        });
        if (!recorded?.error) {
          return {
            fileId: done.upload_id,
            uploadId: done.upload_id,
            deduped: true,
            complete: true,
            total: done.bytes,
            message: recorded.msg,
          };
        }
      }

      const open = this.sql
        .exec(
          `SELECT upload_id, channel, bytes FROM uploads
           WHERE sig = ? AND status = 'open' AND bytes = ? ORDER BY created_at DESC LIMIT 1`,
          signature,
          size,
        )
        .toArray()[0];
      if (open) {
        const stat = await this.#blobFor(open.channel).stat();
        return {
          fileId: open.upload_id,
          uploadId: open.upload_id,
          resumed: true,
          partSize: PART_SIZE,
          chunkSize: CHUNK_SIZE,
          total: size,
          received: stat.parts ?? 0,
          maxFileBytes: MAX_FILE_BYTES,
        };
      }
    }

    const fileId = newFileId();
    const channel = newFileId().slice(0, 32);
    this.sql.exec(
      `INSERT INTO uploads (upload_id, channel, actor_id, nick, name, mime, bytes, sig, received, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'open', ?)`,
      fileId,
      channel,
      String(actorId ?? "anon"),
      String(nick ?? "").slice(0, 24),
      String(name ?? "file").slice(0, 160),
      String(mime ?? "application/octet-stream").slice(0, 120),
      size,
      signature,
      Date.now(),
    );

    return {
      fileId,
      uploadId: fileId,
      channel,
      partSize: PART_SIZE,
      chunkSize: CHUNK_SIZE,
      total: size,
      received: 0,
      maxFileBytes: MAX_FILE_BYTES,
      maxParts: MAX_PARTS,
    };
  }

  // Two shapes are used on purpose:
  //   * RPC with a single small object argument, which is reliable here.
  //   * The object's fetch handler with a JSON body, for payloads too large to
  //     cross RPC (a big string in an argument object makes the whole argument
  //     vanish), and for multi-field calls (multiple RPC parameters get
  //     collapsed in this runtime, shifting every value).
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/part" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body) {
        const raw = await request.text().catch(() => "");
        return jsonOut({ error: "bad_json", len: raw.length }, 400);
      }
      const res = await this.putPartChunk({
        uploadId: body.uploadId,
        partNumber: Number(body.partNumber),
        chunkIndex: Number(body.chunkIndex),
        chunkBase64: body.chunkBase64,
      });
      return jsonOut(res, res.error ? 400 : 200);
    }
    return new Response("not found", { status: 404 });
  }

  async putPartChunk({ uploadId, partNumber, chunkIndex, chunkBase64 }) {
    const rec = this.sql
      .exec(`SELECT channel, status FROM uploads WHERE upload_id = ?`, String(uploadId ?? ""))
      .toArray()[0];
    // The session is gone: it was wiped, expired, or abandoned. Report it as a
    // distinct state so the client can restart the upload instead of failing.
    if (!rec) return { error: "session_lost", restart: true };
    if (rec.status !== "open") return { error: "upload_closed" };

    const n = Number(partNumber);
    const idx = Number(chunkIndex);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PARTS) return { error: "bad_part_number" };
    if (!Number.isInteger(idx) || idx < 0) return { error: "bad_chunk_index" };
    if (typeof chunkBase64 !== "string" || !chunkBase64) return { error: "empty_chunk" };

    const put = await this.#blobFor(rec.channel).putPartChunk({
      partNumber: n,
      chunkIndex: idx,
      chunkBase64,
    });
    if (put.error) return put;

    this.sql.exec(`UPDATE uploads SET received = ? WHERE upload_id = ?`, put.parts ?? 0, uploadId);
    return { ok: true, size: put.size, parts: put.parts };
  }

  async partStat({ uploadId }) {
    const rec = this.sql
      .exec(`SELECT channel FROM uploads WHERE upload_id = ?`, String(uploadId ?? ""))
      .toArray()[0];
    if (!rec) return { error: "unknown_upload" };
    return { ok: true, ...(await this.#blobFor(rec.channel).stat()) };
  }

  async completeUpload(uploadId) {
    const rec = this.sql
      .exec(
        `SELECT upload_id, channel, actor_id, nick, name, mime, bytes, status FROM uploads WHERE upload_id = ?`,
        String(uploadId ?? ""),
      )
      .toArray()[0];
    if (!rec) return { error: "unknown_upload" };
    if (rec.status === "done") return { error: "already_completed" };

    const stat = await this.#blobFor(rec.channel).stat();
    if (!stat.parts) return { error: "no_parts" };

    const expected = Math.ceil(Number(rec.bytes) / PART_SIZE);
    if (stat.parts < expected) {
      return { error: "incomplete", received: stat.parts, expected };
    }

    this.sql.exec(`UPDATE uploads SET status = 'done', received = ? WHERE upload_id = ?`, stat.parts, uploadId);

    const recorded = await this.#recordInRoom({
      actorId: rec.actor_id,
      nick: rec.nick,
      fileId: uploadId,
      storeChannel: rec.channel,
      name: rec.name,
      mime: rec.mime,
      bytes: stat.used,
    });

    return { ok: true, uploadId, size: stat.used, parts: stat.parts, message: recorded?.msg ?? null };
  }

  async abortUpload(uploadId) {
    const rec = this.sql
      .exec(`SELECT channel FROM uploads WHERE upload_id = ?`, String(uploadId ?? ""))
      .toArray()[0];
    if (!rec) return { error: "unknown_upload" };
    try {
      await this.#blobFor(rec.channel).purge();
    } catch {
      /* already gone, which is the desired end state */
    }
    this.sql.exec(`UPDATE uploads SET status = 'aborted' WHERE upload_id = ?`, uploadId);
    return { ok: true };
  }

  // Reports the byte layout for a whole-part read, used by the download route.
  async readPart({ uploadId, partNumber, chunkFrom, chunkCount }) {
    const rec = this.sql
      .exec(`SELECT channel, status FROM uploads WHERE upload_id = ?`, String(uploadId ?? ""))
      .toArray()[0];
    if (!rec) return { error: "not_found" };
    if (rec.status !== "done") return { error: "not_ready" };
    const res = await this.#blobFor(rec.channel).getPart({ partNumber, chunkFrom, chunkCount });
    if (!res.ok) return { error: "part_missing" };
    return { ok: true, chunks: res.chunks, next: res.next, more: res.more };
  }

  // Reads an exact byte window starting at an arbitrary offset. Parts are read
  // whole and sliced here, so the caller never deals with part boundaries.
  async readWindow({ uploadId, offset, length }) {
    const rec = this.sql
      .exec(`SELECT channel, status FROM uploads WHERE upload_id = ?`, String(uploadId ?? ""))
      .toArray()[0];
    if (!rec) return { error: "not_found" };
    if (rec.status !== "done") return { error: "not_ready" };

    const start = Math.max(0, Number(offset) || 0);
    const want = Math.max(1, Number(length) || 1);
    const firstPart = Math.floor(start / PART_SIZE) + 1;
    const lastPart = Math.floor((start + want - 1) / PART_SIZE) + 1;

    const out = [];
    let skip = start - (firstPart - 1) * PART_SIZE;
    let remaining = want;

    for (let n = firstPart; n <= lastPart && remaining > 0; n++) {
      const res = await this.#blobFor(rec.channel).getPart({ partNumber: n });
      if (!res.ok || !res.chunks?.length) break;

      for (const b64 of res.chunks) {
        let view = base64ToBytes(b64);
        if (skip > 0) {
          if (view.byteLength <= skip) {
            skip -= view.byteLength;
            continue;
          }
          view = view.subarray(skip);
          skip = 0;
        }
        if (view.byteLength > remaining) view = view.subarray(0, remaining);
        out.push(bytesToBase64(view));
        remaining -= view.byteLength;
        if (remaining <= 0) break;
      }

      skip = 0;
    }

    return { ok: true, chunks: out };
  }

  // Clears one blob channel's bytes. Used by delete and by the full wipe.
  async deleteBlob({ channel }) {
    const ch = String(channel ?? "");
    if (!/^[a-f0-9]{16,64}$/.test(ch)) return { error: "bad_channel" };
    try {
      const res = await this.#blobFor(ch).purge();
      return { ok: true, removed: res.removed ?? 0 };
    } catch (err) {
      return { error: "blob_error", detail: String(err?.message ?? err).slice(0, 200) };
    }
  }

  // Wipes upload sessions and reclaims the given blob channels. Called by the
  // full-wipe path, which already knows every channel from the file index.
  async clearAll({ channels = [] } = {}) {
    const rows = this.sql.exec(`SELECT COUNT(*) AS cnt FROM uploads`).toArray()[0];
    this.sql.exec(`DELETE FROM uploads`);

    let purged = 0;
    for (const channel of channels) {
      const res = await this.deleteBlob({ channel });
      if (res.ok) purged++;
    }
    return { ok: true, uploads: Number(rows?.cnt ?? 0), blobs: purged };
  }

  // Abandoned sessions have their partial bytes reclaimed after a day.
  async alarm() {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const stale = this.sql
      .exec(`SELECT upload_id, channel FROM uploads WHERE status = 'open' AND created_at < ?`, cutoff)
      .toArray();
    for (const row of stale) {
      try {
        await this.#blobFor(row.channel).purge();
      } catch {
        /* ignore */
      }
    }
    if (stale.length) {
      this.sql.exec(`UPDATE uploads SET status = 'aborted' WHERE status = 'open' AND created_at < ?`, cutoff);
    }
    this.sql.exec(`DELETE FROM uploads WHERE status != 'open' AND created_at < ?`, Date.now() - 7 * 86400_000);
    await this.ctx.storage.setAlarm(Date.now() + 6 * 3600_000);
  }
}
