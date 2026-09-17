// Times the individual hops in a download so the real bottleneck is visible
// rather than guessed at.
//
//   node tools/probe-download-cost.mjs [baseUrl] [sizeMB]

const BASE = process.argv[2] ?? "https://your-proxy.pages.dev";
const SIZE_MB = Number(process.argv[3] ?? 4);
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
  console.log(`base=${BASE} size=${SIZE_MB}MB`);
  await req("/api/session", { method: "POST" });

  const init = await (
    await req("/api/up/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `dlcost-${SIZE_MB}mb.bin`,
        mime: "application/octet-stream",
        bytes: SIZE,
        sig: `dl-${Date.now()}`,
      }),
    })
  ).json();
  const partSize = init.partSize;
  const partCount = Math.ceil(SIZE / partSize);
  const payload = Buffer.alloc(SIZE, 0x37);

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

  // Time the whole download, reading the stream in chunks so the client is not
  // the limiting factor.
  const t0 = Date.now();
  const dl = await req(`/api/dl/${init.uploadId}`);
  let received = 0;
  const reader = dl.body.getReader();
  let marks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    marks.push({ at: Date.now() - t0, bytes: received });
  }
  const secs = (Date.now() - t0) / 1000;

  console.log(`\ndownload: ${received} bytes in ${secs.toFixed(1)}s = ${(received / 1048576 / secs).toFixed(2)} MB/s`);
  console.log("first 6 stream chunks (ms, cumulative bytes):");
  for (const m of marks.slice(0, 6)) console.log(`  ${m.at}ms  ${m.bytes} bytes`);
  if (marks.length > 1) {
    const gaps = [];
    for (let i = 1; i < marks.length; i++) gaps.push(marks[i].at - marks[i - 1].at);
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    console.log(`stream chunks: ${marks.length}, avg gap ${avg.toFixed(0)}ms`);
  }
  console.log(`TTFB (first byte): ${marks[0]?.at ?? "n/a"}ms`);
};

main().catch((err) => {
  console.error("probe error:", err?.message ?? err);
  process.exit(1);
});
