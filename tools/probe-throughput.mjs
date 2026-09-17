// Measures upload throughput the way the browser client uploads: several parts
// in flight at once. Serial measurement understates real performance.
//
//   node tools/probe-throughput.mjs [baseUrl] [sizeMB] [concurrency]

const BASE = process.argv[2] ?? "https://your-proxy.pages.dev";
const SIZE_MB = Number(process.argv[3] ?? 20);
const CONCURRENCY = Number(process.argv[4] ?? 8);
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
  console.log(`base=${BASE} size=${SIZE_MB}MB concurrency=${CONCURRENCY}`);
  await req("/api/session", { method: "POST" });

  const init = await (
    await req("/api/up/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `throughput-${SIZE_MB}mb.bin`,
        mime: "application/octet-stream",
        bytes: SIZE,
        sig: `tp-${Date.now()}`,
      }),
    })
  ).json();
  if (!init.uploadId) {
    console.log("FAIL init:", JSON.stringify(init));
    process.exit(1);
  }

  const partSize = init.partSize;
  const partCount = Math.ceil(SIZE / partSize);
  console.log(`partSize=${(partSize / 1048576).toFixed(1)}MB parts=${partCount}`);

  const payload = Buffer.alloc(SIZE, 0x5a);
  let cursor = 0;
  let done = 0;
  const t0 = Date.now();

  const worker = async () => {
    for (;;) {
      const n = ++cursor;
      if (n > partCount) return;
      const start = (n - 1) * partSize;
      const chunk = payload.subarray(start, Math.min(start + partSize, SIZE));
      const res = await req(`/api/up/part?uploadId=${init.uploadId}&partNumber=${n}`, {
        method: "PUT",
        body: chunk,
        headers: { "content-length": String(chunk.length) },
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok !== true) {
        console.log(`  part ${n} rejected:`, JSON.stringify(data));
        process.exit(1);
      }
      done++;
      if (done % 5 === 0 || done === partCount) {
        const secs = (Date.now() - t0) / 1000;
        const mb = (done * partSize) / 1048576;
        console.log(`  ${done}/${partCount} parts  ${secs.toFixed(1)}s  ${(mb / secs).toFixed(2)} MB/s`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, partCount) }, worker));
  const totalSecs = (Date.now() - t0) / 1000;
  console.log(`\nuploaded ${SIZE_MB}MB in ${totalSecs.toFixed(1)}s = ${(SIZE_MB / totalSecs).toFixed(2)} MB/s`);

  const complete = await (
    await req("/api/up/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uploadId: init.uploadId }),
    })
  ).json();
  console.log("complete:", JSON.stringify(complete).slice(0, 120));

  // Verify content integrity through a download.
  const t1 = Date.now();
  const dl = await req(`/api/dl/${init.uploadId}`);
  const got = Buffer.from(await dl.arrayBuffer());
  const dlSecs = (Date.now() - t1) / 1000;
  console.log(
    `downloaded ${got.length} bytes in ${dlSecs.toFixed(1)}s = ${(got.length / 1048576 / dlSecs).toFixed(2)} MB/s`,
  );
  const intact = got.length === SIZE && got[0] === 0x5a && got[got.length - 1] === 0x5a;
  console.log("content intact:", intact);

  // Estimate for the user's 103 MB file.
  const perMB = totalSecs / SIZE_MB;
  console.log(`\n倍率估算: 103MB 约需 ${(perMB * 103).toFixed(0)} 秒`);
};

main().catch((err) => {
  console.error("probe error:", err?.message ?? err);
  process.exit(1);
});
