// Byte-exact round-trip check: uploads a pattern, downloads it, and reports the
// first byte where they differ.
//
//   node tools/probe-roundtrip.mjs [baseUrl] [sizeKB]

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const SIZE = (Number(process.argv[3] ?? 300)) * 1024;
let cookie = "";

async function req(path, opts = {}) {
  const headers = new Headers(opts.headers ?? {});
  if (cookie) headers.set("cookie", cookie);
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return res;
}

const main = async () => {
  await req("/api/session", { method: "POST" });

  // Distinct byte per position so the first divergence is informative.
  const source = Buffer.alloc(SIZE);
  for (let i = 0; i < SIZE; i++) source[i] = i % 251;

  const init = await (
    await req("/api/up/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "roundtrip.bin",
        mime: "application/octet-stream",
        bytes: SIZE,
        sig: `rt-${Date.now()}`,
      }),
    })
  ).json();
  if (!init.uploadId) {
    console.log("init failed:", JSON.stringify(init));
    process.exit(1);
  }
  console.log(`size=${SIZE} partSize=${init.partSize} chunkSize=${init.chunkSize}`);

  const partSize = init.partSize;
  const partCount = Math.ceil(SIZE / partSize);
  for (let n = 1; n <= partCount; n++) {
    const start = (n - 1) * partSize;
    const chunk = source.subarray(start, Math.min(start + partSize, SIZE));
    const res = await req(`/api/up/part?uploadId=${init.uploadId}&partNumber=${n}`, {
      method: "PUT",
      body: chunk,
      headers: { "content-length": String(chunk.length) },
    });
    if (res.status !== 200) console.log(`  part ${n} FAILED ${res.status}`);
  }

  await req("/api/up/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uploadId: init.uploadId }),
  });

  const dl = await req(`/api/dl/${init.uploadId}`);
  const got = Buffer.from(await dl.arrayBuffer());
  console.log(`downloaded=${got.length} status=${dl.status}`);

  if (got.length !== SIZE) {
    console.log(`LENGTH MISMATCH: ${got.length} vs ${SIZE}`);
  }

  let firstDiff = -1;
  const n = Math.min(got.length, SIZE);
  for (let i = 0; i < n; i++) {
    if (got[i] !== source[i]) {
      firstDiff = i;
      break;
    }
  }

  if (firstDiff < 0 && got.length === SIZE) {
    console.log("CONTENT IDENTICAL");
  } else {
    console.log(`FIRST DIFF AT BYTE ${firstDiff}`);
    const from = Math.max(0, firstDiff - 8);
    console.log(`  expected: ${[...source.subarray(from, from + 24)].join(",")}`);
    console.log(`  actual  : ${[...got.subarray(from, from + 24)].join(",")}`);
    console.log(`  part boundary offset: ${firstDiff % partSize}`);
  }
};

main().catch((err) => {
  console.error("probe error:", err?.message ?? err);
  process.exit(1);
});
