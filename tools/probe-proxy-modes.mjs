// A/B compares the two proxy handoff styles on a real download.
//
//   node tools/probe-proxy-modes.mjs [sizeMB]

const HOST = "https://your-proxy.pages.dev";
const SIZE = Number(process.argv[2] ?? 16) * 1024 * 1024;

async function session(base) {
  const res = await fetch(`${base}/api/session`, { method: "POST" });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  return cookie;
}

async function uploadAndTime(cookie) {
  const headers = { cookie, "content-type": "application/json" };
  const init = await (
    await fetch(`${HOST}/api/up/init`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "proxy-mode.bin",
        mime: "application/octet-stream",
        bytes: SIZE,
        sig: `pm-${Date.now()}`,
      }),
    })
  ).json();

  const partSize = init.partSize;
  const partCount = Math.ceil(SIZE / partSize);
  const payload = Buffer.alloc(SIZE, 0x66);
  for (let n = 1; n <= partCount; n++) {
    const start = (n - 1) * partSize;
    const chunk = payload.subarray(start, Math.min(start + partSize, SIZE));
    await fetch(`${HOST}/api/up/part?uploadId=${init.uploadId}&partNumber=${n}`, {
      method: "PUT",
      headers: { cookie, "content-length": String(chunk.length) },
      body: chunk,
    });
  }
  await fetch(`${HOST}/api/up/complete`, {
    method: "POST",
    headers,
    body: JSON.stringify({ uploadId: init.uploadId }),
  });
  return init.uploadId;
}

async function timeDownload(cookie, uploadId, mode) {
  const suffix = mode === "wrap" ? "?proxy=wrap" : "";
  const t0 = Date.now();
  const res = await fetch(`${HOST}/api/dl/${uploadId}${suffix}`, { headers: { cookie } });
  const reader = res.body.getReader();
  let received = 0;
  let blocks = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    blocks++;
  }
  const secs = (Date.now() - t0) / 1000;
  return { secs, received, blocks, mbps: received / 1048576 / secs };
}

const main = async () => {
  console.log(`host=${HOST} size=${SIZE / 1048576}MB\n`);
  const cookie = await session(HOST);
  const uploadId = await uploadAndTime(cookie);
  console.log("uploaded\n");

  for (const mode of ["wrap", "direct"]) {
    const r = await timeDownload(cookie, uploadId, mode);
    console.log(
      `${mode.padEnd(7)} ${r.secs.toFixed(1)}s  ${r.mbps.toFixed(2)} MB/s  流块 ${r.blocks}  平均 ${Math.round(r.received / r.blocks)} B`,
    );
  }
};

main().catch((err) => {
  console.error("probe error:", err?.message ?? err);
  process.exit(1);
});
