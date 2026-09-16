// Runs the same upload+download against two entry points so it is clear whether
// the Pages proxy hop is what costs throughput.
//
//   node tools/probe-entrypoints.mjs [sizeMB]

const ENTRY_POINTS = [
  ["Pages 代理", "https://your-proxy.pages.dev"],
  ["Worker 直连", "https://cf-chat.YOUR-SUBDOMAIN.workers.dev"],
];
const SIZE = Number(process.argv[2] ?? 4) * 1024 * 1024;

async function run(label, base) {
  let cookie = "";
  async function req(path, opts = {}) {
    const headers = new Headers(opts.headers ?? {});
    if (cookie) headers.set("cookie", cookie);
    const res = await fetch(`${base}${path}`, { ...opts, headers });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return res;
  }

  try {
    await req("/api/session", { method: "POST" });
    const init = await (
      await req("/api/up/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "entrypoint.bin",
          mime: "application/octet-stream",
          bytes: SIZE,
          sig: `ep-${label}-${Date.now()}`,
        }),
      })
    ).json();
    if (!init.uploadId) return `${label}: init failed ${JSON.stringify(init)}`;

    const partSize = init.partSize;
    const partCount = Math.ceil(SIZE / partSize);
    const payload = Buffer.alloc(SIZE, 0x21);

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
    const upSecs = (Date.now() - tUp) / 1000;

    const tDown = Date.now();
    const dl = await req(`/api/dl/${init.uploadId}`);
    const reader = dl.body.getReader();
    let received = 0;
    let blocks = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      blocks++;
    }
    const downSecs = (Date.now() - tDown) / 1000;

    return [
      `${label}`,
      `  上传  ${upSecs.toFixed(1)}s  ${(SIZE / 1048576 / upSecs).toFixed(2)} MB/s`,
      `  下载  ${downSecs.toFixed(1)}s  ${(received / 1048576 / downSecs).toFixed(2)} MB/s`,
      `  流块数 ${blocks}  平均块大小 ${Math.round(received / blocks)} B`,
    ].join("\n");
  } catch (err) {
    return `${label}: ${String(err?.message ?? err).slice(0, 80)}`;
  }
}

const main = async () => {
  console.log(`文件大小 ${SIZE / 1048576}MB\n`);
  for (const [label, base] of ENTRY_POINTS) {
    console.log(await run(label, base));
    console.log();
  }
};

main().catch((err) => {
  console.error("probe error:", err?.message ?? err);
  process.exit(1);
});
