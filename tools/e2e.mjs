// End-to-end exercise of the upload -> broadcast -> download pipeline.
// Run against a live `wrangler dev` (local Miniflare R2 + Durable Objects).
//
//   node tools/e2e.mjs [baseUrl] [fileSizeMB]

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const SIZE_MB = Number(process.argv[3] ?? 20);
const SIZE = SIZE_MB * 1024 * 1024;

let cookie = "";
let failures = 0;

function check(label, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  if (!ok) failures++;
  console.log(`[${mark}] ${label}${detail ? `  ${detail}` : ""}`);
}

async function req(path, { method = "GET", body, headers = {}, cookie: sendCookie = true } = {}) {
  const h = new Headers(headers);
  if (sendCookie && cookie) h.set("cookie", cookie);
  const res = await fetch(`${BASE}${path}`, { method, body, headers: h, redirect: "manual" });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return res;
}

async function jsonReq(path, opts = {}) {
  const res = await req(path, opts);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data, res };
}

function makeFile(bytes) {
  const buf = new Uint8Array(bytes);
  // Deterministic but non-uniform content so corruption is detectable.
  let x = 0x12345678;
  for (let i = 0; i < bytes; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = x & 0xff;
  }
  return buf;
}

function contentHash(bytes) {
  // FNV-1a over 32-bit accumulator, enough to catch truncation or reordering.
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

const main = async () => {
  console.log(`base=${BASE} size=${SIZE_MB}MB`);

  const health = await jsonReq("/api/health");
  check("health ok", health.status === 200 && health.data?.ok === true, JSON.stringify(health.data));
  check("storage backend reachable", String(health.data?.storage).startsWith("ok:"), health.data?.storage);
  check("uses Durable Object storage", health.data?.backend === "durable-objects", health.data?.backend);
  check("SESSION_SECRET present", health.data?.hasSecret === true);

  const session = await jsonReq("/api/session");
  check("session issued", session.status === 200 && Boolean(session.data?.actorId), session.data?.nick);
  check("session cookie set", cookie.startsWith("cfc_session="), cookie.slice(0, 24));

  const payload = makeFile(SIZE);
  const sourceHash = contentHash(payload);
  // Unique per run, otherwise the dedupe path short-circuits the upload test.
  const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const fileName = `e2e-${runTag}.bin`;
  const sig = `${SIZE}|${fileName}|1700000000000`;

  const init = await jsonReq("/api/up/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: fileName, mime: "application/octet-stream", bytes: SIZE, sig }),
  });
  check("upload init", init.status === 200 && Boolean(init.data?.uploadId), JSON.stringify(init.data).slice(0, 140));
  check("fresh upload is not deduped", init.data?.deduped !== true && init.data?.resumed !== true);
  if (init.status !== 200) return finish();

  const { uploadId, partSize } = init.data;
  const partCount = Math.ceil(SIZE / partSize);
  const expectParts = SIZE > partSize ? Math.ceil(SIZE / partSize) : 1;
  check(
    "part geometry sane",
    partCount === expectParts && partSize === 2 * 1024 * 1024,
    `partSize=${partSize} parts=${partCount}`,
  );

  let uploaded = 0;
  for (let n = 1; n <= partCount; n++) {
    const start = (n - 1) * partSize;
    const chunk = payload.subarray(start, Math.min(start + partSize, SIZE));
    const res = await req(`/api/up/part?uploadId=${uploadId}&partNumber=${n}`, {
      method: "PUT",
      body: chunk,
      headers: { "content-length": String(chunk.length) },
    });
    if (res.status !== 200) {
      check(`part ${n} upload`, false, `status=${res.status} ${(await res.text()).slice(0, 120)}`);
      return finish();
    }
    const data = await res.json();
    if (!data.ok || data.received !== n) {
      check(`part ${n} stored`, false, JSON.stringify(data).slice(0, 120));
      return finish();
    }
    uploaded++;
  }
  check(`all ${partCount} parts uploaded`, uploaded === partCount);

  const complete = await jsonReq("/api/up/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uploadId }),
  });
  check("multipart complete", complete.status === 200 && complete.data?.ok === true, JSON.stringify(complete.data).slice(0, 160));
  check("object size matches", complete.data?.size === SIZE, `${complete.data?.size} vs ${SIZE}`);

  const history = await jsonReq("/api/history?since=0&limit=20");
  const msgs = history.data?.msgs ?? [];
  const fileMsg = msgs.filter((m) => m.kind === "file").pop();
  check("file announced in chat", Boolean(fileMsg?.file?.id), fileMsg?.file?.name);
  check("announced size matches", fileMsg?.file?.bytes === SIZE, `${fileMsg?.file?.bytes}`);

  // Full download
  const dl = await req(`/api/dl/${uploadId}`);
  const got = new Uint8Array(await dl.arrayBuffer());
  const dlHeaders = Object.fromEntries(dl.headers.entries());
  check("download status", dl.status === 200, `status=${dl.status} headers=${JSON.stringify(dlHeaders)}`);
  check("download length", got.length === SIZE, `${got.length} vs ${SIZE}`);
  check("download content intact", contentHash(got) === sourceHash, `${contentHash(got)} vs ${sourceHash}`);
  check(
    "attachment disposition",
    (dl.headers.get("content-disposition") ?? "").includes("attachment"),
    dl.headers.get("content-disposition"),
  );
  check("nosniff header", dl.headers.get("x-content-type-options") === "nosniff");
  check("accept-ranges advertised", dl.headers.get("accept-ranges") === "bytes");

  // Range request, exercising the resume path a big download actually uses.
  const mid = Math.floor(SIZE / 2);
  const ranged = await req(`/api/dl/${uploadId}`, { headers: { range: `bytes=${mid}-` } });
  const tail = new Uint8Array(await ranged.arrayBuffer());
  check("range status 206", ranged.status === 206, `status=${ranged.status}`);
  check("range length", tail.length === SIZE - mid, `${tail.length} vs ${SIZE - mid}`);
  check("range content intact", contentHash(tail.subarray(0, 65536)) === contentHash(payload.subarray(mid, mid + 65536)));
  check(
    "content-range header",
    (ranged.headers.get("content-range") ?? "").startsWith(`bytes ${mid}-`),
    ranged.headers.get("content-range"),
  );

  // Same signature again: should dedupe server-side instead of re-uploading.
  const again = await jsonReq("/api/up/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: fileName, mime: "application/octet-stream", bytes: SIZE, sig }),
  });
  check("dedupe on repeat signature", again.data?.complete === true, JSON.stringify(again.data).slice(0, 140));

  const search = await jsonReq(`/api/history?q=${encodeURIComponent(fileName)}&limit=20`);
  check("file name searchable", (search.data?.msgs ?? []).length >= 1, `hits=${(search.data?.msgs ?? []).length}`);

  const files = await jsonReq("/api/files?limit=20");
  const listed = (files.data?.files ?? []).find((f) => f.id === uploadId);
  check("appears in file index", Boolean(listed), listed?.name);
  check("download counter incremented", (listed?.downloads ?? 0) >= 2, `downloads=${listed?.downloads}`);

  // ------------------------------------------------------------------ delete

  const del = await req(`/api/files/${uploadId}`, { method: "DELETE" });
  const delBody = await del.json().catch(() => ({}));
  check("delete accepted", del.status === 200 && delBody.ok === true, `status=${del.status} ${JSON.stringify(delBody).slice(0, 140)}`);
  check("cloud object reclaimed", delBody.reclaimed === true, `reclaimed=${delBody.reclaimed}`);

  const gone = await req(`/api/dl/${uploadId}`);
  check("download after delete is 410", gone.status === 410, `status=${gone.status}`);
  const goneBody = await gone.json().catch(() => ({}));
  check("410 carries a reason", goneBody.error === "deleted", JSON.stringify(goneBody));

  const filesAfter = await jsonReq("/api/files?limit=20");
  const stillListed = (filesAfter.data?.files ?? []).find((f) => f.id === uploadId);
  check("hidden from file cabinet", stillListed === undefined);

  const afterDel = await jsonReq("/api/history?since=0&limit=50");
  const delMsg = (afterDel.data?.msgs ?? []).find((m) => m.file?.id === uploadId);
  check("card kept in transcript", Boolean(delMsg), `found=${Boolean(delMsg)}`);
  check("card reports deleted", delMsg?.file?.deleted === true, JSON.stringify(delMsg?.file ?? null).slice(0, 120));

  // Repeating the delete is idempotent: the file is already gone, which is the
  // state the caller asked for, so it reports success rather than an error.
  const again2 = await req(`/api/files/${uploadId}`, { method: "DELETE" });
  const againBody = await again2.json().catch(() => ({}));
  check(
    "second delete is idempotent",
    again2.status === 200 && againBody.ok === true && againBody.alreadyDeleted === true,
    `status=${again2.status} ${JSON.stringify(againBody).slice(0, 100)}`,
  );

  const unknown = await req(`/api/files/${"a".repeat(32)}`, { method: "DELETE" });
  check("unknown id is 404", unknown.status === 404, `status=${unknown.status}`);

  const badId = await req(`/api/files/short`, { method: "DELETE" });
  check("malformed id rejected", badId.status === 400, `status=${badId.status}`);

  // The delete path already zeroes the row's byte count, so the sweep has
  // nothing left to reclaim for it; what matters is that it reports success.
  const purge = await jsonReq("/api/files/purge", { method: "POST" });
  check("purge endpoint responds", purge.status === 200, JSON.stringify(purge.data).slice(0, 140));
  check("purge reports no failure", (purge.data?.failed ?? 1) === 0, JSON.stringify(purge.data));

  const afterPurge = await jsonReq("/api/history?since=0&limit=50");
  const tomb = (afterPurge.data?.msgs ?? []).find((m) => m.file?.id === uploadId);
  check("tombstone survives purge", Boolean(tomb), `found=${Boolean(tomb)}`);
  check("tombstone still marked deleted", tomb?.file?.deleted === true);
  check("tombstone keeps its name", Boolean(tomb?.file?.name), tomb?.file?.name);

  finish();
};

function finish() {
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("harness error:", err);
  process.exit(2);
});
