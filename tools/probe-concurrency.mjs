// Compares serial versus concurrent range downloads at several concurrency
// levels, which is the change the browser client now makes by default.
//
//   node tools/probe-concurrency.mjs [baseUrl] [sizeMB]

const BASE = process.argv[2] ?? "https://your-proxy.pages.dev";
const SIZE = Number(process.argv[3] ?? 16) * 1024 * 1024;
let cookie = "";

async function req(path, opts = {}) {
  const headers = new Headers(opts.headers ?? {});
  if (cookie) headers.set("cookie", cookie);
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return res;
}

async function fetchRange(uploadId, start, end) {
  const res = await req(`/api/dl/${uploadId}`, {
    headers: { range: `bytes=${start}-${end}` },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length;
}

async function runWith(uploadId, concurrency, partSize) {
  const partCount = Math.ceil(SIZE / partSize);
  let next = 0;
  let received = 0;
  const t0 = Date.now();

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= partCount) return;
      const start = i * partSize;
      const end = Math.min(start + partSize, SIZE) - 1;
      received += await fetchRange(uploadId, start, end);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, partCount) }, worker));
  const secs = (Date.now() - t0) / 1000;
  return { secs, received, mbps: received / 1048576 / secs };
}

const main = async () => {
  console.log(`base=${BASE} size=${SIZE / 1048576}MB`);
  await req("/api/session", { method: "POST" });

  const init = await (
    await req("/api/up/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "concurrency-probe.bin",
        mime: "application/octet-stream",
        bytes: SIZE,
        sig: `conc-${Date.now()}`,
      }),
    })
  ).json();

  const partSize = init.partSize;
  const partCount = Math.ceil(SIZE / partSize);
  const payload = Buffer.alloc(SIZE, 0x44);

  const tUp = Date.now();
  for (let n = 1; n <= partCount; n++) {
    const start = (n - 1) * partSize;
    const chunk = payload.subarray(start, Math.min(start + partSize, SIZE));
    await req(`/api/up/part?uploadId=${init.uploadId}&partNumber=${n}`, {
      method: "PUT",
      body: chunk,
      headers: { "content-length": String(chunk.length) },
    });
  }
  await req("/api/up/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uploadId: init.uploadId }),
  });
  console.log(`上传完成 ${((Date.now() - tUp) / 1000).toFixed(1)}s\n`);

  // Baseline: one streaming request for the whole file.
  const t0 = Date.now();
  const dl = await req(`/api/dl/${init.uploadId}`);
  const reader = dl.body.getReader();
  let whole = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    whole += value.byteLength;
  }
  const wholeSecs = (Date.now() - t0) / 1000;
  console.log(`整文件单请求     ${wholeSecs.toFixed(1)}s  ${(whole / 1048576 / wholeSecs).toFixed(2)} MB/s`);
  console.log("");

  // Concurrent ranges at several widths, using the client's part sizing.
  const clientPart = Math.min(4 * 1024 * 1024, Math.max(1024 * 1024, Math.ceil(SIZE / 12)));
  for (const c of [1, 2, 4, 8]) {
    const r = await runWith(init.uploadId, c, clientPart);
    console.log(
      `并发 ${String(c).padStart(2)}  (${(clientPart / 1048576).toFixed(0)}MB/片, ${Math.ceil(SIZE / clientPart)} 片)   ${r.secs.toFixed(1)}s  ${r.mbps.toFixed(2)} MB/s`,
    );
  }
};

main().catch((err) => {
  console.error("probe error:", err?.message ?? err);
  process.exit(1);
});
