import { DurableObject } from "cloudflare:workers";

// One Durable Object instance per chat room. All storage is SQLite-backed,
// which is the only backend available on the Workers Free plan.

const MSG_MAX = 2000;
const NICK_MAX = 24;
const FILE_MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB, bounded by the 1 GB per-object cap
const RATE_WINDOW_S = 60;

// Bytes live in Durable Objects, whose Free plan allowance is 5 GB per account
// (measured in decimal GB). Keep headroom so an upload can never push the
// account against a hard wall, and warn well before that.
const QUOTA_BYTES = 4 * 1000 * 1000 * 1000;
const QUOTA_WARN_RATIO = 0.8;

// [bucket, limit within one window of RATE_WINDOW_S seconds]
const LIMITS = {
  msg: 20,
  upload: 10,
  download: 60,
  search: 30,
  delete: 20,
  notice: 10,
};

const ANON = "\u533f\u540d";

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.sql = ctx.storage.sql;

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        room       TEXT    NOT NULL,
        actor_id   TEXT    NOT NULL,
        nick       TEXT    NOT NULL,
        kind       TEXT    NOT NULL,
        body       TEXT,
        file_id    TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_msg_room_id ON messages(room, id);`);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS files (
        file_id       TEXT PRIMARY KEY,
        r2_key        TEXT    NOT NULL,
        orig_name     TEXT    NOT NULL,
        mime          TEXT    NOT NULL,
        bytes         INTEGER NOT NULL,
        sha256        TEXT,
        uploader_id   TEXT    NOT NULL,
        uploader_nick TEXT    NOT NULL,
        download_count INTEGER NOT NULL DEFAULT 0,
        status        TEXT    NOT NULL DEFAULT 'ready',
        created_at    INTEGER NOT NULL
      );
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_files_created ON files(created_at DESC);`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_files_sha ON files(sha256);`);

    // Added after the first release, so existing tables get the columns too.
    const fileCols = new Set(this.sql.exec(`PRAGMA table_info(files)`).toArray().map((r) => r.name));
    if (!fileCols.has("deleted_by")) this.sql.exec(`ALTER TABLE files ADD COLUMN deleted_by TEXT`);
    if (!fileCols.has("deleted_at")) this.sql.exec(`ALTER TABLE files ADD COLUMN deleted_at INTEGER`);
    // Which blob channel object holds this file's bytes, so delete can clear it.
    if (!fileCols.has("store_channel")) this.sql.exec(`ALTER TABLE files ADD COLUMN store_channel TEXT`);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        rl_key   TEXT NOT NULL,
        bucket   TEXT NOT NULL,
        window_s INTEGER NOT NULL,
        count    INTEGER NOT NULL,
        reset_at INTEGER NOT NULL,
        PRIMARY KEY (rl_key, bucket)
      );
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
    `);

    // Hibernation keeps idle sockets free: no wall-clock duration is billed
    // while the object is evicted, which is what makes the free tier workable.
    // Note: this lives on the DurableObjectState, not on storage.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(JSON.stringify({ t: "ping" }), JSON.stringify({ t: "pong" })),
    );
  }

  // ---------------------------------------------------------------- storage

  #takeLimit(scopeKey, bucket, cost = 1) {
    const limit = LIMITS[bucket] ?? 30;
    const now = Math.floor(Date.now() / 1000);
    const row = this.sql
      .exec(`SELECT count, reset_at FROM rate_limits WHERE rl_key = ? AND bucket = ?`, scopeKey, bucket)
      .toArray()[0];

    if (!row || row.reset_at <= now) {
      this.sql.exec(
        `INSERT INTO rate_limits (rl_key, bucket, window_s, count, reset_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(rl_key, bucket) DO UPDATE SET count = ?, reset_at = ?`,
        scopeKey,
        bucket,
        RATE_WINDOW_S,
        cost,
        now + RATE_WINDOW_S,
        cost,
        now + RATE_WINDOW_S,
      );
      return { ok: true, remaining: limit - cost };
    }

    if (row.count + cost > limit) {
      return { ok: false, retryAfter: Math.max(1, row.reset_at - now), limit };
    }

    this.sql.exec(`UPDATE rate_limits SET count = count + ? WHERE rl_key = ? AND bucket = ?`, cost, scopeKey, bucket);
    return { ok: true, remaining: limit - row.count - cost };
  }

  #lastId() {
    const row = this.sql.exec(`SELECT COALESCE(MAX(id), 0) AS id FROM messages`).toArray()[0];
    return row?.id ?? 0;
  }

  // Storage totals for the cabinet header. Tombstones carry no bytes, so this
  // sum tracks real occupancy rather than the size of the transcript.
  #capacity() {
    const row = this.sql
      .exec(
        `SELECT COALESCE(SUM(bytes), 0) AS used, COUNT(*) AS cnt
         FROM files WHERE status = 'ready'`,
      )
      .toArray()[0];
    const used = Number(row?.used ?? 0);
    return {
      usedBytes: used,
      quotaBytes: QUOTA_BYTES,
      remainingBytes: Math.max(0, QUOTA_BYTES - used),
      fileCount: Number(row?.cnt ?? 0),
      warn: used >= QUOTA_BYTES * QUOTA_WARN_RATIO,
      full: used >= QUOTA_BYTES,
      maxFileBytes: FILE_MAX_BYTES,
    };
  }

  #putMessage({ actorId, nick, kind, body, fileId }) {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO messages (room, actor_id, nick, kind, body, file_id, created_at)
       VALUES ('main', ?, ?, ?, ?, ?, ?)`,
      actorId,
      nick,
      kind,
      body ?? null,
      fileId ?? null,
      now,
    );
    const row = this.sql
      .exec(
        `SELECT id, actor_id, nick, kind, body, file_id, created_at
         FROM messages WHERE id = last_insert_rowid()`,
      )
      .toArray()[0];
    return {
      id: row.id,
      actorId: row.actor_id,
      nick: row.nick,
      kind: row.kind,
      body: row.body,
      fileId: row.file_id,
      at: row.created_at,
    };
  }

  #hydrateMessages(rows) {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.file_id).filter(Boolean);
    const files = new Map();
    for (const id of ids) {
      const f = this.sql
        .exec(
          `SELECT file_id, orig_name, mime, bytes, download_count, status
           FROM files WHERE file_id = ?`,
          id,
        )
        .toArray()[0];
      if (f) {
        files.set(f.file_id, {
          id: f.file_id,
          name: f.orig_name,
          mime: f.mime,
          bytes: f.bytes,
          downloads: f.download_count,
          // Deleted files keep their message so the transcript stays readable,
          // but the card renders as unavailable instead of 404ing on click.
          deleted: f.status !== "ready",
        });
      }
    }
    return rows.map((r) => ({
      id: r.id,
      actorId: r.actor_id,
      nick: r.nick,
      kind: r.kind,
      body: r.body,
      file: r.file_id ? files.get(r.file_id) ?? null : null,
      at: r.created_at,
    }));
  }

  #queryMessages({ since, limit, q }) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    if (q) {
      // File messages carry no body, so the searchable text falls back to the
      // joined filename, which is what users actually type when hunting a file.
      const rows = this.sql
        .exec(
          `SELECT m.id, m.actor_id, m.nick, m.kind, m.body, m.file_id, m.created_at
           FROM messages m
           LEFT JOIN files f ON f.file_id = m.file_id
           WHERE COALESCE(m.body, '') LIKE ? OR COALESCE(f.orig_name, '') LIKE ?
           ORDER BY m.id DESC LIMIT ?`,
          `%${q}%`,
          `%${q}%`,
          lim,
        )
        .toArray();
      return this.#hydrateMessages(rows).reverse();
    }

    const cursor = Number(since) || 0;
    if (cursor <= 0) {
      // No cursor means "catch me up": newest N in chronological order, which
      // is what a fresh client needs rather than the oldest rows in the room.
      const recent = this.sql
        .exec(
          `SELECT id, actor_id, nick, kind, body, file_id, created_at
           FROM messages ORDER BY id DESC LIMIT ?`,
          lim,
        )
        .toArray();
      return this.#hydrateMessages(recent).reverse();
    }

    const rows = this.sql
      .exec(
        `SELECT id, actor_id, nick, kind, body, file_id, created_at
         FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?`,
        cursor,
        lim,
      )
      .toArray();
    return this.#hydrateMessages(rows);
  }

  #broadcast(message, excludeIds = []) {
    const payload = JSON.stringify(message);
    const skip = new Set(excludeIds);
    let sent = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (skip.has(ws.deserializeAttachment()?.connId)) continue;
      // Sockets that died without a clean teardown can still be listed here,
      // so skip them rather than logging a send failure on every broadcast.
      if (ws.readyState !== 1) continue;
      try {
        ws.send(payload);
        sent++;
      } catch (err) {
        // A systematic failure here would otherwise be invisible, because the
        // message is already persisted by the time we broadcast it.
        console.error("broadcast send failed", String(err?.message ?? err));
      }
    }
    return sent;
  }

  // ------------------------------------------------------------------- RPC

  async initSession({ actorId, nick }) {
    return { actorId, nick, lastId: this.#lastId() };
  }

  async sendText({ actorId, nick, text, ip }) {
    const body = String(text ?? "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .trim();
    if (!body) return { error: "empty" };
    if (body.length > MSG_MAX) return { error: "too_long", max: MSG_MAX };

    const rl = this.#takeLimit(`ip:${ip}`, "msg");
    if (!rl.ok) return { error: "rate_limited", retryAfter: rl.retryAfter, scope: "msg" };

    const msg = this.#putMessage({
      actorId,
      nick: String(nick ?? ANON).slice(0, NICK_MAX),
      kind: "text",
      body,
    });
    const delivered = this.#broadcast({ t: "msg", msg });
    await this.#keepAlive();
    return { msg, delivered };
  }

  // Retracts a message for everyone, with no time limit and no ownership check.
  //
  // Both omissions are deliberate. This build has no accounts, so "did you send
  // this" is not answerable — the same reasoning that lets any visitor delete
  // any file applies here. A time window would be theatre: anyone who wanted a
  // message gone could simply retract it within the window. Rate limiting is
  // what actually matters, so it shares the delete bucket.
  async recallMessage({ messageId, ip, nick }) {
    const id = Number(messageId);
    if (!Number.isInteger(id) || id <= 0) return { error: "bad_id" };

    const rl = this.#takeLimit(`ip:${ip}`, "delete");
    if (!rl.ok) return { error: "rate_limited", retryAfter: rl.retryAfter, scope: "delete" };

    const row = this.sql
      .exec(`SELECT id, kind FROM messages WHERE id = ?`, id)
      .toArray()[0];
    if (!row) return { error: "not_found" };

    this.sql.exec(`DELETE FROM messages WHERE id = ?`, id);

    // The file itself is left alone. Retracting a card from the conversation is
    // not a request to destroy the file, which lives in the cabinet
    // independently and is removed from there.
    this.#broadcast({ t: "msgrecalled", id, by: String(nick ?? "").slice(0, NICK_MAX) });
    await this.#keepAlive();

    return { ok: true, id, kind: row.kind };
  }

  async recordUpload({ actorId, nick, fileId, r2Key, storeChannel, name, mime, bytes, sha256, ip }) {
    const size = Number(bytes) || 0;
    if (size <= 0 || size > FILE_MAX_BYTES) {
      return { error: "bad_size", max: FILE_MAX_BYTES };
    }
    const rl = this.#takeLimit(`ip:${ip}`, "upload");
    if (!rl.ok) return { error: "rate_limited", retryAfter: rl.retryAfter, scope: "upload" };

    // Refuse rather than overrun the free allotment: exceeding the quota is
    // billed, and the user gets a clear message instead of a surprise.
    const cap = this.#capacity();
    if (cap.usedBytes + size > cap.quotaBytes) {
      return {
        error: "quota_exceeded",
        usedBytes: cap.usedBytes,
        quotaBytes: cap.quotaBytes,
        remainingBytes: cap.remainingBytes,
        maxFileBytes: cap.maxFileBytes,
      };
    }

    const safeName =
      String(name ?? "file")
        .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
        .slice(0, 160) || "file";
    const safeMime = String(mime ?? "application/octet-stream").slice(0, 120);
    const safeNick = String(nick ?? ANON).slice(0, NICK_MAX);
    const now = Date.now();

    this.sql.exec(
      `INSERT INTO files (file_id, r2_key, store_channel, orig_name, mime, bytes, sha256, uploader_id, uploader_nick, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)
       ON CONFLICT(file_id) DO NOTHING`,
      fileId,
      r2Key,
      storeChannel ?? null,
      safeName,
      safeMime,
      size,
      sha256 ?? null,
      actorId,
      safeNick,
      now,
    );

    const msg = this.#putMessage({ actorId, nick: safeNick, kind: "file", fileId });
    const file = { id: fileId, name: safeName, mime: safeMime, bytes: size, downloads: 0 };
    const outbound = { ...msg, file };
    const delivered = this.#broadcast({ t: "msg", msg: outbound });
    await this.#keepAlive();
    return { msg: outbound, delivered, capacity: this.#capacity() };
  }

  async history({ since = 0, limit = 50, q = null, ip }) {
    if (q) {
      const rl = this.#takeLimit(`ip:${ip}`, "search");
      if (!rl.ok) return { error: "rate_limited", retryAfter: rl.retryAfter, scope: "search" };
    }
    const msgs = this.#queryMessages({ since, limit, q });
    return { msgs, lastId: this.#lastId() };
  }

  async takeDownload({ fileId, ip }) {
    const file = this.sql
      .exec(
        `SELECT file_id, r2_key, store_channel, orig_name, mime, bytes, download_count, status
         FROM files WHERE file_id = ?`,
        fileId,
      )
      .toArray()[0];
    if (!file) return { error: "not_found" };
    if (file.status !== "ready") return { error: "deleted" };

    const rl = this.#takeLimit(`ip:${ip}`, "download");
    if (!rl.ok) return { error: "rate_limited", retryAfter: rl.retryAfter, scope: "download" };

    this.sql.exec(`UPDATE files SET download_count = download_count + 1 WHERE file_id = ?`, fileId);
    return {
      file: {
        id: file.file_id,
        key: file.r2_key,
        channel: file.store_channel,
        name: file.orig_name,
        mime: file.mime,
        bytes: file.bytes,
        downloads: file.download_count + 1,
      },
    };
  }

  // ---------------------------------------------------------------- clearing

  // Wipes the transcript, the file index, and the stored bytes. Upload sessions
  // live in FileStore, so those are cleared separately by the caller.
  // Clears the chat transcript only.
  //
  // Files and their stored bytes are deliberately left alone: wiping the
  // conversation should not destroy files that people may still want, and the
  // transcript is recoverable from context while a deleted file is not. Files
  // are removed individually from the cabinet, or not at all.
  async clearAll(params) {
    // ip defaults so a maintenance caller that omits it still gets the limit.
    const scope = params && typeof params === "object" ? String(params.ip ?? "maintenance") : "maintenance";
    const rl = this.#takeLimit(`ip:${scope}`, "delete");
    if (!rl.ok) return { error: "rate_limited", retryAfter: rl.retryAfter, scope: "delete" };

    const msgRow = this.sql.exec(`SELECT COUNT(*) AS cnt FROM messages`).toArray()[0];
    this.sql.exec(`DELETE FROM messages`);

    this.#broadcast({ t: "cleared" });
    await this.#keepAlive();

    return { ok: true, messages: Number(msgRow?.cnt ?? 0) };
  }

  async capacity() {
    return this.#capacity();
  }

  // A single shared notice shown at the top of the room. Stored in the same
  // key/value table the keep-alive uses, so no extra migration is needed.
  async getNotice() {
    const row = this.sql.exec(`SELECT v FROM meta WHERE k = 'notice'`).toArray()[0];
    return { ok: true, notice: row?.v ?? "" };
  }

  async setNotice({ text, actorId, nick, ip }) {
    const rl = this.#takeLimit(`ip:${ip}`, "notice");
    if (!rl.ok) return { error: "rate_limited", retryAfter: rl.retryAfter, scope: "notice" };

    // Newlines would break the single-line layout, and the cap keeps it a
    // notice rather than a second chat channel.
    const clean = String(text ?? "")
      .replace(/[\r\n]+/g, " ")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 200);

    this.sql.exec(
      `INSERT INTO meta (k, v) VALUES ('notice', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      clean,
    );

    this.#broadcast({ t: "notice", notice: clean, by: String(nick ?? "").slice(0, NICK_MAX) });
    await this.#keepAlive();
    return { ok: true, notice: clean };
  }

  async listFiles({ limit = 50, q = null }) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const rows = q
      ? this.sql
          .exec(
            `SELECT file_id, orig_name, mime, bytes, uploader_nick, download_count, created_at
             FROM files WHERE status = 'ready' AND orig_name LIKE ?
             ORDER BY created_at DESC LIMIT ?`,
            `%${q}%`,
            lim,
          )
          .toArray()
      : this.sql
          .exec(
            `SELECT file_id, orig_name, mime, bytes, uploader_nick, download_count, created_at
             FROM files WHERE status = 'ready'
             ORDER BY created_at DESC LIMIT ?`,
            lim,
          )
          .toArray();
    return {
      files: rows.map((r) => ({
        id: r.file_id,
        name: r.orig_name,
        mime: r.mime,
        bytes: r.bytes,
        uploader: r.uploader_nick,
        downloads: r.download_count,
        at: r.created_at,
      })),
      capacity: this.#capacity(),
    };
  }

  // Marks a file deleted and reports which channel holds its bytes. The row is
  // kept so the chat transcript still shows that something was there.
  async deleteFile({ fileId, actorId, nick, ip }) {
    // A rate limit bucket also covers the destructive "clear everything" action.
    const rl = this.#takeLimit(`ip:${ip}`, "delete");
    if (!rl.ok) return { error: "rate_limited", retryAfter: rl.retryAfter, scope: "delete" };

    const file = this.sql
      .exec(
        `SELECT file_id, r2_key, store_channel, orig_name, bytes, status FROM files WHERE file_id = ?`,
        fileId,
      )
      .toArray()[0];
    if (!file) return { error: "not_found" };
    // Already tombstoned: report success so a repeated click is harmless rather
    // than surfacing an error for a state the user asked for anyway.
    if (file.status !== "ready") {
      return {
        ok: true,
        fileId,
        name: file.orig_name,
        bytes: 0,
        storeChannel: null,
        alreadyDeleted: true,
        delivered: 0,
      };
    }

    // Zeroing bytes frees the space in the cabinet total immediately; the size
    // shown before deletion already told the user how big it was.
    this.sql.exec(
      `UPDATE files SET status = 'deleted', deleted_by = ?, deleted_at = ?, bytes = 0 WHERE file_id = ?`,
      `actor:${actorId}`,
      Date.now(),
      fileId,
    );

    const delivered = this.#broadcast({
      t: "filedeleted",
      fileId,
      by: String(nick ?? "").slice(0, NICK_MAX),
    });
    await this.#keepAlive();

    return {
      ok: true,
      fileId,
      name: file.orig_name,
      bytes: file.bytes,
      r2Key: file.r2_key,
      storeChannel: file.store_channel,
      delivered,
    };
  }

  // Reclaims the bytes for files deleted a while ago. The row stays as a
  // tombstone holding only name and size, so the transcript keeps showing that
  // something was there and never silently drops the card.
  async purgeDeleted({ limit = 200 }) {
    const rows = this.sql
      .exec(
        `SELECT file_id, r2_key, store_channel, bytes, orig_name FROM files
         WHERE status = 'deleted' ORDER BY deleted_at ASC LIMIT ?`,
        Math.min(Math.max(Number(limit) || 200, 1), 1000),
      )
      .toArray();
    if (rows.length === 0) return { purged: 0, bytes: 0, keys: [] };

    const bytes = rows.reduce((sum, r) => sum + (r.bytes || 0), 0);
    const keys = rows.map((r) => ({
      key: r.r2_key,
      fileId: r.file_id,
      name: r.orig_name,
      channel: r.store_channel,
    }));
    for (const row of rows) {
      this.sql.exec(
        `UPDATE files SET status = 'purged', r2_key = '', store_channel = NULL, sha256 = NULL WHERE file_id = ?`,
        row.file_id,
      );
    }
    return { purged: rows.length, bytes, keys };
  }

  // -------------------------------------------------------------- websocket

  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // Storage figures, used by FileStore to enforce the upload quota.
    if (parts[0] === "capacity") {
      return new Response(JSON.stringify(this.#capacity()), {
        headers: { "content-type": "application/json" },
      });
    }

    if (parts[0] === "record" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body) {
        return new Response(JSON.stringify({ error: "bad_json" }), { status: 400 });
      }
      const res = await this.recordUpload({
        actorId: body.actorId,
        nick: body.nick,
        fileId: body.fileId,
        r2Key: `do:${body.storeChannel}`,
        storeChannel: body.storeChannel,
        name: body.name,
        mime: body.mime,
        bytes: body.bytes,
        sha256: null,
        ip: body.actorId,
      });
      return new Response(JSON.stringify(res), {
        status: res.error ? 400 : 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const actorId = url.searchParams.get("a") || "anon";
    const nick = (url.searchParams.get("n") || ANON).slice(0, NICK_MAX);
    const connId = url.searchParams.get("c") || actorId;
    // The client IP travels in from the Worker because the object cannot see
    // the original request. It is the rate-limit key; actorId is not usable for
    // that because /api/session hands out fresh ones to anyone for free.
    const connIp = url.searchParams.get("ip") || "unknown";

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // acceptWebSocket (not server.accept) is what enables hibernation.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ actorId, nick, connId, ip: connIp });

    const recent = this.#queryMessages({
      since: Number(url.searchParams.get("since")) || 0,
      limit: 50,
    });
    const onlineNow = this.ctx.getWebSockets().length;
    try {
      server.send(JSON.stringify({ t: "hello", actorId, nick, lastId: this.#lastId(), recent, online: onlineNow }));
    } catch {
      /* the client may have gone before the handshake completed */
    }

    this.#broadcast({ t: "presence", online: onlineNow });

    // A socket that was just accepted cannot reliably receive the broadcast
    // above, so the count is repeated to this client shortly after. Without
    // this, a freshly connected client can briefly display a stale number.
    try {
      setTimeout(() => {
        try {
          server.send(JSON.stringify({ t: "presence", online: this.ctx.getWebSockets().length }));
        } catch {
          /* socket already gone */
        }
      }, 60);
    } catch {
      /* timers unavailable; the broadcast above still covers other clients */
    }

    await this.#scheduleCleanup();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== "string") return;

    const att = ws.deserializeAttachment() ?? { actorId: "anon", nick: ANON };

    if (msg.t === "say") {
      const res = await this.sendText({
        actorId: att.actorId,
        nick: att.nick,
        text: msg.text,
        ip: att.ip ?? "unknown",
      });
      if (res.error) {
        try {
          ws.send(JSON.stringify({ t: "error", scope: res.scope ?? "msg", error: res.error, retryAfter: res.retryAfter }));
        } catch {
          /* socket already closing */
        }
      }
      return;
    }

    if (msg.t === "history") {
      const res = await this.history({ since: msg.since, limit: msg.limit, q: msg.q, ip: att.ip ?? "unknown" });
      try {
        ws.send(JSON.stringify({ t: "history", ...res }));
      } catch {
        /* socket already closing */
      }
      return;
    }

    if (msg.t === "ping") {
      try {
        ws.send(JSON.stringify({ t: "pong" }));
      } catch {
        /* socket already closing */
      }
    }
  }

  async webSocketClose(ws) {
    try {
      ws.close();
    } catch {
      /* already closed */
    }

    // The closing socket is still present in getWebSockets() at this point, so
    // the live count excludes it. The broadcast is repeated once the socket has
    // actually left the list: a send issued while a peer is tearing down can be
    // dropped, which left remaining clients showing a stale count.
    const online = Math.max(0, this.ctx.getWebSockets().length - 1);
    this.#broadcast({ t: "presence", online });

    try {
      setTimeout(() => {
        try {
          this.#broadcast({ t: "presence", online: this.ctx.getWebSockets().length });
        } catch {
          /* object evicted; nothing to notify */
        }
      }, 150);
    } catch {
      /* timers unavailable; the broadcast above still stands */
    }
  }

  async webSocketError(ws) {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  async #scheduleCleanup() {
    const current = await this.ctx.storage.getAlarm();
    if (current == null) {
      await this.ctx.storage.setAlarm(Date.now() + 3600_000);
    }
  }

  // A Durable Object that finishes handling a message with no pending work can
  // hibernate immediately, discarding frames still queued on its sockets. One
  // storage write keeps it resident for this turn so the broadcast flushes.
  async #keepAlive() {
    this.sql.exec(
      `INSERT INTO meta (k, v) VALUES ('ping', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      String(Date.now()),
    );
  }

  async alarm() {
    const now = Math.floor(Date.now() / 1000);
    this.sql.exec(`DELETE FROM rate_limits WHERE reset_at < ?`, now - 3600);
    await this.ctx.storage.setAlarm(Date.now() + 3600_000);
  }
}
