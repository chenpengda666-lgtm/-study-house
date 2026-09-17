// Verifies the part-upload response against exactly what the browser client
// asserts. The client rejects a part unless the JSON body has ok === true, so a
// mismatch here breaks real uploads while a looser test would still pass.
//
//   node tools/probe-part-contract.mjs [baseUrl] [sizeMB] [partMB]

const BASE = process.argv[2] ?? "https://your-proxy.pages.dev";
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
  console.log(`base=${BASE} size=${SIZE_MB}MB`);
  await req("/api/session", { method: "POST" });

  const init = await (
    await req("/api/up/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "contract-probe.bin",
        mime: "application/octet-stream",
        bytes: SIZE,
        sig: `contract-${Date.now()}`,
      }),
    })
  ).json();
  if (!init.uploadId) {
    console.log("FAIL init:", JSON.stringify(init));
    process.exit(1);
  }
  const partSize = init.partSize;
  const partCount = Math.ceil(SIZE / partSize);
  console.log(`partSize=${partSize} parts=${partCount} chunkSize=${init.chunkSize}`);

  // Send one part and check the body the way the browser does.
  const body = Buffer.alloc(partSize, 0x41);
  const t0 = Date.now();
  const res = await req(`/api/up/part?uploadId=${init.uploadId}&partNumber=1`, {
    method: "PUT",
    body,
    headers: { "content-length": String(partSize) },
  });
  const ms = Date.now() - t0;
  const data = await res.json().catch(() => ({}));

  console.log(`\npart 1 response (${ms}ms):`);
  console.log("  status     :", res.status);
  console.log("  body       :", JSON.stringify(data));

  // This is the assertion the browser makes.
  const clientAccepts = data?.ok === true;
  console.log("\nclient would accept this part:", clientAccepts ? "YES" : "NO — upload fails");

  if (!clientAccepts) {
    console.log("  reason: client requires { ok: true }, got", JSON.stringify(data));
    process.exit(1);
  }

  // Finish the rest so a full round trip is exercised, then verify contents.
  for (let n = 2; n <= partCount; n++) {
    const chunk = Buffer.alloc(Math.min(partSize, SIZE - (n - 1) * partSize), 0x41);
    const r = await req(`/api/up/part?uploadId=${init.uploadId}&partNumber=${n}`, {
      method: "PUT",
      body: chunk,
      headers: { "content-length": String(chunk.length) },
    });
    const d = await r.json().catch(() => ({}));
    if (d.ok !== true) {
      console.log(`  part ${n} rejected:`, JSON.stringify(d));
      process.exit(1);
    }
  }

  const done = await (
    await req("/api/up/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uploadId: init.uploadId }),
    })
  ).json();
  console.log("\ncomplete:", JSON.stringify(done).slice(0, 160));

  const dl = await req(`/api/dl/${init.uploadId}`);
  const got = Buffer.from(await dl.arrayBuffer());
  const same = got.length === SIZE && got.every((b) => b === 0x41);
  console.log(`download: ${got.length} bytes, all 0x41 = ${same}`);

  console.log(same ? "\nCONTRACT OK" : "\nCONTRACT MISMATCH");
  process.exit(same ? 0 : 1);
};

main().catch((err) => {
  console.error("probe error:", err?.message ?? err);
  process.exit(1);
});
