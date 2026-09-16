import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
  SESSION_DAYS,
  clientIp,
  issueSession,
  randomId,
  sanitizeNick,
  verifySession,
} from "./auth.js";

const app = new Hono();
const SESSION_COOKIE = "cfc_session";
// File ids are 32 hex characters produced by newFileId(). Anything that does
// not match is a malformed id, which is different from a valid id that is
// simply unknown.
const ID_RE = /^[a-f0-9]{32}$/i;

// Durable Object RPC with small arguments is reliable here, but an argument
// object whose field holds a very large string is dropped entirely, and
// identifiers placed in the URL, query string, or custom headers are stripped
// on the way to the object. So: RPC everywhere, and big payloads chopped into
// bounded chunks by the caller.

// Routes build their own Response objects, so the session cookie is injected
// here rather than through c.header(): anything set before `return new Response`
// would not be merged into that response.
app.use("/*", async (c, next) => {
  await next();
  const cookie = c.get("setCookie");
  if (cookie && c.res && !c.res.headers.has("Set-Cookie")) {
    c.res.headers.set("Set-Cookie", cookie);
  }
});

function roomFor(env, name = "main") {
  return env.CHAT_ROOMS.get(env.CHAT_ROOMS.idFromName(name));
}

function fileStore(env) {
  return env.FILE_STORE.get(env.FILE_STORE.idFromName("global"));
}

// Downloads read blob data straight from the object that holds it. Going through
// FileStore first would add a second cross-object hop plus another base64
// re-encode for every window, which dominated transfer time.
function blobStore(env, channel) {
  return env.BLOB_STORE.get(env.BLOB_STORE.idFromName(`blob:${channel}`));
}

function json(data, status = 200, extraHeaders = null) {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const SIZE = 8192;
  let bin = "";
  for (let i = 0; i < bytes.length; i += SIZE) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + SIZE));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sessionCookie(request, token) {
  const secure = new URL(request.url).protocol === "https:";
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_DAYS * 86400}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

// Reads an existing session without creating one, used by read-only routes.
async function peekSession(c, env) {
  const token = getCookie(c, SESSION_COOKIE);
  return verifySession(env.SESSION_SECRET, token);
}

// Creates a session on first write so visitors never see a login step.
async function ensureSession(c, env) {
  const existing = await peekSession(c, env);
  if (existing) return existing;
  const actorId = randomId(12);
  const nick = sanitizeNick(c.req.query("nick"));
  const token = await issueSession(env.SESSION_SECRET, actorId, nick);
  c.set("setCookie", sessionCookie(c.req.raw, token));
  return { actorId, nick };
}

async function sessionHandler(c) {
  const session = await ensureSession(c, c.env);
  return json({ ok: true, ...session });
}

// Registered for both verbs: establishing a session is idempotent, and clients
// that POST here should not fall through to the SPA handler and get HTML.
app.get("/api/session", sessionHandler);
app.post("/api/session", sessionHandler);

app.get("/api/history", async (c) => {
  const session = await peekSession(c, c.env);
  const q = c.req.query("q");
  const res = await roomFor(c.env).history({
    since: Number(c.req.query("since")) || 0,
    limit: Number(c.req.query("limit")) || 50,
    q: q ? q.slice(0, 64) : null,
    ip: session?.actorId ?? clientIp(c.req.raw),
  });
  return json(res, res?.error === "rate_limited" ? 429 : 200);
});

app.get("/api/files", async (c) => {
  const q = c.req.query("q");
  const res = await roomFor(c.env).listFiles({
    limit: Number(c.req.query("limit")) || 50,
    q: q ? q.slice(0, 64) : null,
  });
  return json(res);
});

// Shared notice shown at the top of the room. Readable without a session so the
// bar can render before the client has one; writing creates one.
app.get("/api/notice", async (c) => {
  const res = await roomFor(c.env).getNotice();
  return json(res);
});

app.post("/api/notice", async (c) => {
  const session = await ensureSession(c, c.env);
  let body;
  try {
    body = await c.req.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  const res = await roomFor(c.env).setNotice({
    text: body.text,
    actorId: session.actorId,
    nick: session.nick,
    ip: session.actorId,
  });
  return json(res, res.error === "rate_limited" ? 429 : res.error ? 400 : 200);
});

// ---------------------------------------------------------------- websocket

app.get("/api/ws", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "expected_upgrade" }, 426);
  }

  // Browsers always send the session cookie on the upgrade request, but a
  // non-browser client (or a test harness) cannot set headers here, so the
  // token is also accepted as a query parameter.
  const url = new URL(c.req.url);
  const token = url.searchParams.get("token") ?? getCookie(c, SESSION_COOKIE);
  const verified = await verifySession(c.env.SESSION_SECRET, token);

  let actorId;
  let nick;
  if (verified) {
    actorId = verified.actorId;
    nick = verified.nick;
  } else {
    const session = await ensureSession(c, c.env);
    actorId = session.actorId;
    nick = session.nick;
  }

  const target = new URL(url.toString());
  target.searchParams.set("a", actorId);
  target.searchParams.set("n", nick);
  target.searchParams.set("c", `${actorId}:${randomId(4)}`);

  // Rooms exist so tests can isolate presence; the UI always uses "main".
  const room = /^[A-Za-z0-9_-]{1,32}$/.test(url.searchParams.get("room") ?? "")
    ? url.searchParams.get("room")
    : "main";

  // Forward the upgrade verbatim, including the client's sec-websocket-key.
  const res = await roomFor(c.env, room).fetch(new Request(target.toString(), c.req.raw));
  if (res.status !== 101 || !res.webSocket) {
    return json({ error: "upgrade_failed" }, 502);
  }
  const cookie = c.get("setCookie");
  const headers = new Headers();
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(null, { status: 101, webSocket: res.webSocket, headers });
});

// ------------------------------------------------------------------ uploads

app.post("/api/up/init", async (c) => {
  const session = await ensureSession(c, c.env);
  let body;
  try {
    body = await c.req.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  const res = await fileStore(c.env).createUpload({
    actorId: session.actorId,
    nick: session.nick,
    name: body.name,
    mime: body.mime,
    bytes: body.bytes,
    sig: body.sig,
  });
  const status = res.error === "quota_exceeded" ? 507 : res.error ? 400 : 200;
  return json(res, status);
});

app.put("/api/up/part", async (c) => {
  await ensureSession(c, c.env);
  const uploadId = c.req.query("uploadId") ?? "";
  const partNumber = Number(c.req.query("partNumber"));
  if (!uploadId || !Number.isInteger(partNumber)) return json({ error: "bad_params" }, 400);

  const len = Number(c.req.header("content-length")) || 0;
  if (len > 3 * 1024 * 1024) return json({ error: "part_too_large" }, 413);

  const data = await c.req.raw.arrayBuffer();
  if (!data || data.byteLength === 0) return json({ error: "empty_body" }, 400);

  // Uploaded in bounded chunks. Two runtime limits drive this: a large string
  // inside an RPC argument object makes the whole argument vanish, and a chunk
  // this size keeps per-request CPU (base64 encode) well under the free-plan
  // ceiling. Larger chunks pushed the Durable Object into returning 503 once
  // enough parts were in flight.
  const b64 = bytesToBase64(data);
  const CHUNK = 128 * 1024;
  const total = Math.max(1, Math.ceil(b64.length / CHUNK));
  const store = fileStore(c.env);

  for (let i = 0; i < total; i++) {
    const chunkBase64 = b64.slice(i * CHUNK, (i + 1) * CHUNK);
    const res = await (
      await store.fetch(
        new Request("https://store.internal/part", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ uploadId, partNumber, chunkIndex: i, chunkBase64 }),
        }),
      )
    ).json();
    if (res?.error) {
      // session_lost means the upload session no longer exists (wiped, expired,
      // or abandoned); the client restarts rather than surfacing a raw error.
      const gone = res.error === "session_lost" || res.error === "unknown_upload";
      return json(res, gone ? 404 : 400);
    }
  }

  const stat = await store.partStat({ uploadId });
  return json({ ok: true, partNumber, chunks: total, received: stat?.parts ?? 0 });
});

app.post("/api/up/complete", async (c) => {
  await ensureSession(c, c.env);
  let body;
  try {
    body = await c.req.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  const res = await fileStore(c.env).completeUpload(body.uploadId);
  let status = 200;
  if (res.error === "quota_exceeded") status = 507;
  else if (res.error === "no_parts" || res.error === "incomplete") status = 400;
  else if (res.error === "already_completed") status = 409;
  else if (res.error) status = 400;
  return json(res, status);
});

app.post("/api/up/abort", async (c) => {
  await ensureSession(c, c.env);
  let body;
  try {
    body = await c.req.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  const res = await fileStore(c.env).abortUpload(body.uploadId);
  return json(res);
});

// ------------------------------------------------------------------- delete

app.delete("/api/files/:fileId", async (c) => {
  const fileId = c.req.param("fileId");
  if (!ID_RE.test(fileId)) return json({ error: "bad_id" }, 400);

  const session = await ensureSession(c, c.env);
  const result = await roomFor(c.env).deleteFile({
    fileId,
    actorId: session.actorId,
    nick: session.nick,
    ip: session.actorId,
  });

  if (result.error === "rate_limited") {
    return json({ error: "rate_limited", retryAfter: result.retryAfter }, 429);
  }
  if (result.error === "not_found") return json({ error: "not_found" }, 404);
  if (result.error === "already_deleted") return json({ error: "already_deleted" }, 409);

  // The row is already tombstoned, so a cleanup failure here cannot make the
  // file reappear; the purge sweep retries it later.
  if (result.alreadyDeleted) {
    // Nothing left to reclaim — the bytes were dropped on the first delete.
    return json(result);
  }

  const reclaimed = result.storeChannel
    ? await fileStore(c.env).deleteBlob({ channel: result.storeChannel })
    : { error: "no_channel" };

  return json({
    ok: true,
    fileId: result.fileId,
    name: result.name,
    bytes: result.bytes,
    reclaimed: reclaimed.ok === true,
    delivered: result.delivered,
  });
});

// Wipes the transcript, the file index, and every stored byte. Rate limited
// inside the object; there are no accounts in this build, so the confirmation
// lives on the client and this endpoint is deliberately simple.
app.post("/api/clear", async (c) => {
  const session = await ensureSession(c, c.env);
  const cleared = await roomFor(c.env).clearAll({ ip: session.actorId });
  if (cleared?.error === "rate_limited") {
    return json({ error: "rate_limited", retryAfter: cleared.retryAfter }, 429);
  }
  const store = await fileStore(c.env).clearAll({ channels: cleared?.channels ?? [] });
  return json({
    ok: true,
    messages: cleared?.messages ?? 0,
    files: cleared?.files ?? 0,
    blobs: store?.blobs ?? 0,
  });
});

// Clears the stored bytes for files deleted long enough ago to be unrecoverable.
async function purgeDeletedFiles(env, limit = 200) {
  const pending = await roomFor(env).purgeDeleted({ limit });
  if (!pending?.keys?.length) return { purged: 0, bytes: 0 };

  let ok = true;
  for (const entry of pending.keys) {
    if (!entry.channel) continue;
    const res = await fileStore(env).deleteBlob({ channel: entry.channel });
    if (res?.error) ok = false;
  }
  return {
    purged: ok ? pending.purged : 0,
    bytes: ok ? pending.bytes : 0,
    failed: ok ? 0 : pending.purged,
  };
}

app.post("/api/files/purge", async (c) => {
  await ensureSession(c, c.env);
  const result = await purgeDeletedFiles(c.env, 500);
  return json(result);
});

// ----------------------------------------------------------------- download

app.get("/api/dl/:uploadId", async (c) => {
  const uploadId = c.req.param("uploadId");
  if (!ID_RE.test(uploadId)) return json({ error: "bad_id" }, 400);

  const session = await peekSession(c, c.env);
  const grant = await roomFor(c.env).takeDownload({
    fileId: uploadId,
    ip: session?.actorId ?? clientIp(c.req.raw),
  });
  if (grant.error === "rate_limited") {
    return json({ error: "rate_limited", retryAfter: grant.retryAfter }, 429);
  }
  if (grant.error === "deleted") return json({ error: "deleted" }, 410);
  if (grant.error === "not_found") return json({ error: "not_found" }, 404);

  const file = grant.file;
  if (!file.channel) return json({ error: "no_storage" }, 410);

  const total = Number(file.bytes) || 0;

  // Parse the byte window the client asked for; a plain GET means the whole file.
  let offset = 0;
  let length = total;
  let partial = false;
  const rangeHeader = c.req.header("range");
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (match) {
      const startRaw = match[1];
      const endRaw = match[2];
      if (startRaw === "" && endRaw !== "") {
        const suffix = Number(endRaw);
        offset = Math.max(0, total - suffix);
        length = total - offset;
      } else {
        offset = Number(startRaw);
        length = endRaw === "" ? total - offset : Number(endRaw) - offset + 1;
      }
      if (Number.isFinite(offset) && Number.isFinite(length) && offset >= 0 && length > 0) {
        length = Math.min(length, total - offset);
        partial = true;
      } else {
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
      }
    }
  }

  let cursor = offset;
  let remaining = length;

  // Each pull asks for an exact byte window. Two things matter for throughput:
  // the window is large (the cost is the round trip, not the bytes), and the
  // decoded pieces are coalesced before being enqueued. Emitting them one by
  // one fragments the stream into thousands of tiny blocks, and each block
  // crossing the proxy hop costs far more than the bytes it carries.
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        if (remaining <= 0) {
          controller.close();
          return;
        }
        const want = Math.min(4 * 1024 * 1024, remaining);
        const res = await blobStore(c.env, file.channel).readWindow({ offset: cursor, length: want });
        if (res?.error) {
          controller.error(new Error(res.error));
          return;
        }
        const chunks = res.chunks ?? [];
        if (chunks.length === 0) {
          controller.close();
          return;
        }

        let merged = 0;
        for (const b64 of chunks) merged += Math.floor((b64.length * 3) / 4);

        const buffer = new Uint8Array(merged);
        let offsetIn = 0;
        for (const b64 of chunks) {
          const view = base64ToBytes(b64);
          buffer.set(view, offsetIn);
          offsetIn += view.byteLength;
        }

        const out = offsetIn === buffer.byteLength ? buffer : buffer.subarray(0, offsetIn);
        controller.enqueue(out);
        cursor += offsetIn;
        remaining -= offsetIn;
      } catch (err) {
        controller.error(err);
      }
    },
  });

  const headers = new Headers();
  // Force a download so an uploaded HTML/SVG can never execute as a page.
  headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  headers.set("content-type", file.mime || "application/octet-stream");
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, max-age=0");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-length", String(length));
  if (partial) {
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${total}`);
  }

  return new Response(stream, { status: partial ? 206 : 200, headers });
});

// ------------------------------------------------------------------- health

app.get("/api/health", async (c) => {
  let storage = "unbound";
  try {
    const cap = await roomFor(c.env).capacity();
    storage = cap ? `ok:${cap.fileCount}` : "no-capacity";
  } catch (err) {
    storage = `error:${String(err?.message ?? err).slice(0, 80)}`;
  }
  return json({
    ok: true,
    storage,
    backend: "durable-objects",
    hasSecret: Boolean(c.env.SESSION_SECRET),
    time: Date.now(),
  });
});

app.notFound((c) => {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
  // Anything outside /api that was not served from the static asset bundle.
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,

  // Reclaims storage for files deleted more than a day ago. Without this the
  // bytes would linger and keep counting against the account allowance.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      purgeDeletedFiles(env, 500).then(
        (r) => {
          if (r.purged || r.failed) console.log("purge sweep", JSON.stringify(r));
        },
        (err) => console.error("purge sweep failed", String(err?.message ?? err)),
      ),
    );
  },
};

export { ChatRoom } from "./chat-room.js";
export { FileStore, BlobStore } from "./file-store.js";
