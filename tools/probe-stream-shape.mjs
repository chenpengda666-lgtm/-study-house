// Measures how the download stream actually arrives, so the cost is attributed
// to buffering versus throughput rather than guessed.
//
//   node tools/probe-stream-shape.mjs [baseUrl] [sizeMB]

const BASE = process.argv[2] ?? "https://your-proxy.pages.dev";
const SIZE = Number(process.argv[3] ?? 8) * 1024 * 1024;
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
  console.log(`base=${BASE} size=${SIZE / 1048576}MB`);
  await req("/api/session", { method: "POST" });

  const init = await (
    await req("/api/up/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "stream-shape.bin",
        mime: "application/octet-stream",
        bytes: SIZE,
        sig: `shape-${Date.now()}`,
      }),
    })
  ).json();
  const partSize = init.partSize;
  const partCount = Math.ceil(SIZE / partSize);
  const payload = Buffer.alloc(SIZE, 0x33);

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
  console.log("uploaded, now reading the download stream...\n");

  // Full download, timing every block.
  const t0 = Date.now();
  let res = await req(`/api/dl/${init.uploadId}`);
  const ttfb = Date.now() - t0;

  const gaps = [];
  let received = 0;
  let last = Date.now();
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const now = Date.now();
    gaps.push(now - last);
    last = now;
    received += value.byteLength;
  }
  const total = (Date.now() - t0) / 1000;

  gaps.sort((a, b) => a - b);
  const sum = gaps.reduce((a, b) => a + b, 0);
  console.log("整文件下载");
  console.log(`  字节     ${received}`);
  console.log(`  首字节   ${ttfb}ms`);
  console.log(`  总耗时   ${total.toFixed(1)}s`);
  console.log(`  速度     ${(received / 1048576 / total).toFixed(2)} MB/s`);
  console.log(`  流块数   ${gaps.length}  平均 ${Math.round(received / gaps.length)} B/块`);
  console.log(`  块间隔   p50=${gaps[Math.floor(gaps.length / 2)]}ms  p90=${gaps[Math.floor(gaps.length * 0.9)]}ms  max=${gaps[gaps.length - 1]}ms`);
  console.log(`  停顿占比 ${((sum / 1000 / total) * 100).toFixed(0)}%`);

  // Same file, fetched in 1 MB ranges: shows whether per-request cost dominates.
  console.log("\n分片 Range 下载（每个 1MB 一个请求）");
  const t1 = Date.now();
  let rTotal = 0;
  let requests = 0;
  for (let off = 0; off < SIZE; off += 1024 * 1024) {
    const r = await req(`/api/dl/${init.uploadId}`, {
      headers: { range: `bytes=${off}-${Math.min(off + 1048575, SIZE - 1)}` },
    });
    const buf = Buffer.from(await r.arrayBuffer());
    rTotal += buf.length;
    requests++;
  }
  const rSecs = (Date.now() - t1) / 1000;
  console.log(`  字节 ${rTotal}  ${requests} 个请求  ${rSecs.toFixed(1)}s  ${(rTotal / 1048576 / rSecs).toFixed(2)} MB/s`);
};

main().catch((err) => {
  console.error("probe error:", err?.message ?? err);
  process.exit(1);
});
