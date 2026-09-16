// Reproduces the e2e byte pattern and reports the first divergence with its
// position relative to part and RPC-chunk boundaries.
//
//   node tools/probe-bytes.mjs [baseUrl] [sizeMB]

const BASE = process.argv[2] ?? "https://your-proxy.pages.dev";
const SIZE = Number(process.argv[3] ?? 4) * 1024 * 1024;
const PART = 2 * 1024 * 1024;
const CHUNK = 256 * 1024;
let cookie = "";

async function req(path, opts = {}) {
  const headers = new Headers(opts.headers ?? {});
  if (cookie) headers.set("cookie", cookie);
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return res;
}

function makeFile(bytes) {
  const buf = new Uint8Array(bytes);
  let x = 0x12345678;
  for (let i = 0; i < bytes; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = x & 0xff;
  }
  return buf;
}

const main = async () => {
  console.log(`base=${BASE} size=${SIZE / 1048576}MB`);
  await req("/api/session", { method: "POST" });

  const source = makeFile(SIZE);
  const init = await (
    await req("/api/up/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "bytes-probe.bin",
        mime: "application/octet-stream",
        bytes: SIZE,
        sig: `bytes-${Date.now()}`,
      }),
    })
  ).json();

  const partSize = init.partSize;
  const partCount = Math.ceil(SIZE / partSize);
  console.log(`partSize=${partSize} chunks per part=${Math.ceil((partSize * 4) / 3 / CHUNK)}`);

  for (let n = 1; n <= partCount; n++) {
    const start = (n - 1) * partSize;
    const chunk = source.subarray(start, Math.min(start + partSize, SIZE));
    const res = await req(`/api/up/part?uploadId=${init.uploadId}&partNumber=${n}`, {
      method: "PUT",
      body: chunk,
      headers: { "content-length": String(chunk.length) },
    });
    const data = await res.json().catch(() => ({}));
    console.log(`  part ${n}: chunks=${data.chunks} received=${data.received}`);
  }

  await req("/api/up/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uploadId: init.uploadId }),
  });

  const dl = await req(`/api/dl/${init.uploadId}`);
  const got = Buffer.from(await dl.arrayBuffer());
  console.log(`\ndownloaded=${got.length} expected=${SIZE}`);

  let diff = -1;
  const n = Math.min(got.length, SIZE);
  for (let i = 0; i < n; i++) {
    if (got[i] !== source[i]) {
      diff = i;
      break;
    }
  }

  if (diff < 0 && got.length === SIZE) {
    console.log("CONTENT IDENTICAL");
    return;
  }
  if (diff < 0) {
    console.log("CONTENT IDENTICAL for the common prefix (length differs)");
    return;
  }

  console.log(`FIRST DIFF at byte ${diff}`);
  console.log(`  part           ${Math.floor(diff / PART) + 1} (offset in part ${diff % PART})`);
  console.log(`  RPC chunk      ${Math.floor(diff / (CHUNK * 0.75))}`);
  const from = Math.max(0, diff - 6);
  console.log(`  expected ${[...source.subarray(from, from + 18)].join(",")}`);
  console.log(`  actual   ${[...got.subarray(from, from + 18)].join(",")}`);

  // How much of the stream matches, and where the good data resumes.
  let tailStart = -1;
  for (let i = diff; i < n; i++) {
    if (got[i] === source[i]) {
      tailStart = i;
      break;
    }
  }
  console.log(`  匹配在 ${tailStart} 处恢复` + (tailStart < 0 ? "（之后全部不匹配）" : ""));
};

main().catch((err) => {
  console.error("probe error:", err?.message ?? err);
  process.exit(1);
});
