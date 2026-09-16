// Uploads one file and inspects the stored chunk layout to locate data
// corruption or ordering problems.
//
//   node tools/probe-chunks.mjs [baseUrl] [sizeMB]

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const SIZE_MB = Number(process.argv[3] ?? 2);
const SIZE = SIZE_MB * 1024 * 1024;
const PART = 1024 * 1024;
const CHUNK = 128 * 1024;
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

  const init = await (
    await req("/api/up/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "chunks-probe.bin",
        mime: "application/octet-stream",
        bytes: SIZE,
        sig: `chunks-${Date.now()}`,
      }),
    })
  ).json();
  if (!init.uploadId) {
    console.log("init failed:", JSON.stringify(init));
    process.exit(1);
  }
  console.log("uploadId:", init.uploadId, "partSize:", init.partSize, "chunkSize:", init.chunkSize);

  const partCount = Math.ceil(SIZE / PART);
  for (let n = 1; n <= partCount; n++) {
    const start = (n - 1) * PART;
    const len = Math.min(PART, SIZE - start);
    const body = Buffer.alloc(len, n & 0xff);
    const res = await req(`/api/up/part?uploadId=${init.uploadId}&partNumber=${n}`, {
      method: "PUT",
      body,
      headers: { "content-length": String(len) },
    });
    const data = await res.json();
    console.log(`  part ${n}: status=${res.status} chunks=${data.chunks} received=${data.received}`);
  }

  const done = await (
    await req("/api/up/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uploadId: init.uploadId }),
    })
  ).json();
  console.log("complete:", JSON.stringify(done).slice(0, 160));

  const map = await (await req(`/api/debug/min?id=${init.uploadId}&size=${SIZE}`)).json();
  console.log("\nstored layout:");
  for (const m of map.maps) {
    const expected = Math.ceil((PART * 4) / 3);
    const sum = m.total;
    const flag = sum === PART ? "ok" : sum === PART ? "" : "MISMATCH";
    console.log(`  part ${m.partNumber}: chunks=${m.count} total=${sum} expected=${PART} ${flag}`);
  }

  // Expected chunk sizes for a full 1 MiB part: n-1 chunks of 98304 bytes and a
  // tail chunk holding the remainder.
  const full = Math.ceil((PART * 4) / 3);
  const expectedCount = Math.ceil(full / CHUNK);
  const tailChars = full - (expectedCount - 1) * CHUNK;
  const expectedTail = Math.floor((tailChars * 3) / 4);
  console.log(`\nexpected: ${expectedCount} chunks, last = ${expectedTail} bytes`);
  const p1 = map.maps[0];
  console.log(`part 1 sizes: [${p1.sizes.slice(0, 4).join(", ")}${p1.count > 4 ? ", ..." : ""}, ${p1.sizes.at(-1)}]`);
};

main().catch((err) => {
  console.error("probe error:", err?.message ?? err);
  process.exit(1);
});
