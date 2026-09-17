// Uploads one probe file so the local storage layout can be inspected.
//
//   node tools/probe-store.mjs [baseUrl] [sizeMB]

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const SIZE_MB = Number(process.argv[3] ?? 3);
const SIZE = SIZE_MB * 1024 * 1024;
let cookie = "";

async function req(path, opts = {}) {
  const headers = new Headers(opts.headers ?? {});
  if (cookie) headers.set("cookie", cookie);
  const res = await fetch(`${BASE}${path}${path.includes("?") ? "&" : "?"}room=test`, { ...opts, headers });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return res;
}

const main = async () => {
  await req("/api/session", { method: "POST" });

  const name = "存储位置探针.bin";
  const init = await req("/api/up/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, mime: "application/octet-stream", bytes: SIZE, sig: `probe-${Date.now()}` }),
  });
  const info = await init.json();
  if (!info.uploadId) {
    console.log("init failed:", JSON.stringify(info));
    process.exit(1);
  }
  console.log("R2 object key :", info.key);
  console.log("uploadId      :", `${info.uploadId.slice(0, 24)}... (${info.uploadId.length} chars)`);

  const partSize = info.partSize;
  const partCount = Math.ceil(SIZE / partSize);
  for (let n = 1; n <= partCount; n++) {
    const start = (n - 1) * partSize;
    const len = Math.min(partSize, SIZE - start);
    const body = Buffer.alloc(len, 0x5a);
    await req(`/api/up/part?uploadId=${encodeURIComponent(info.uploadId)}&partNumber=${n}`, {
      method: "PUT",
      body,
      headers: { "content-length": String(len) },
    });
  }

  const done = await req("/api/up/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uploadId: info.uploadId }),
  });
  const result = await done.json();
  console.log("stored size   :", result.size, "bytes");

  const files = await (await req("/api/files?limit=1")).json();
  console.log("capacity      :", JSON.stringify(files.capacity));
};

main().catch((err) => {
  console.error("probe error:", err?.message ?? err);
  process.exit(1);
});
