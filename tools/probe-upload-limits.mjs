// Uploads progressively larger payloads to find where requests start failing.
// The free plan caps Worker CPU time per request, so a failure that appears only
// above a certain part size points at per-request encoding cost.
//
//   node tools/probe-upload-limits.mjs [baseUrl]

const BASE = process.argv[2] ?? "https://chat.example.com";
const MB = 1024 * 1024;
let cookie = "";

async function req(path, opts = {}) {
  const headers = new Headers(opts.headers ?? {});
  if (cookie) headers.set("cookie", cookie);
  const res = await fetch(`${BASE}${path}${path.includes("?") ? "&" : "?"}room=test`, { ...opts, headers });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return res;
}

// Try a single part of the given size and report status plus a body snippet.
async function tryPart(mb, concurrency) {
  const size = Math.round(mb * MB);
  await req("/api/session", { method: "POST" });
  const init = await (
    await req("/api/up/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `limit-${mb}mb.bin`,
        mime: "application/octet-stream",
        bytes: size,
        sig: `lim-${mb}-${Date.now()}`,
      }),
    })
  ).json();
  if (!init.uploadId) return { mb, ok: false, note: `init failed: ${JSON.stringify(init).slice(0, 80)}` };

  const partSize = init.partSize;
  const partCount = Math.ceil(size / partSize);
  const payload = Buffer.alloc(size, 0x5a);

  let done = 0;
  let next = 0;
  let failure = null;
  const t0 = Date.now();

  const worker = async () => {
    for (;;) {
      const n = next++;
      if (n >= partCount) return;
      const start = n * partSize;
      const chunk = payload.subarray(start, Math.min(start + partSize, size));
      try {
        const res = await req(`/api/up/part?uploadId=${init.uploadId}&partNumber=${n + 1}`, {
          method: "PUT",
          body: chunk,
          headers: { "content-length": String(chunk.length) },
        });
        if (res.status !== 200) {
          const text = (await res.text()).slice(0, 100).replace(/\s+/g, " ");
          if (!failure) failure = { part: n + 1, status: res.status, body: text };
          return;
        }
        done++;
      } catch (err) {
        if (!failure) failure = { part: n + 1, error: String(err?.message ?? err).slice(0, 100) };
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, partCount) }, worker));
  const secs = (Date.now() - t0) / 1000;

  let complete = null;
  if (!failure) {
    const c = await req("/api/up/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uploadId: init.uploadId }),
    });
    complete = await c.json().catch(() => null);
  }

  return { mb, ok: !failure && complete?.ok === true, done, partCount, secs, failure, complete };
}

const main = async () => {
  console.log(`base=${BASE}\n`);
  console.log("大小    分片  并发  结果      耗时");
  console.log("─────────────────────────────────────");

  for (const [mb, conc] of [
    [16, 4],
    [32, 4],
    [64, 4],
    [103, 4],
  ]) {
    const r = await tryPart(mb, conc);
    const status = r.ok ? "OK" : "FAIL";
    console.log(`${String(r.mb).padStart(4)}MB ${String(r.partCount ?? "?").padStart(4)}  ${String(conc).padStart(3)}  ${status.padEnd(8)} ${r.secs?.toFixed(1) ?? "-"}s`);
    if (r.failure) {
      console.log(`         └─ part ${r.failure.part}: status=${r.failure.status ?? "-"} ${r.failure.body ?? r.failure.error ?? ""}`);
    }
    // Stop at the first failure: later sizes would only reproduce it.
    if (!r.ok) break;
  }
};

main().catch((err) => {
  console.error("probe error:", err?.message ?? err);
  process.exit(1);
});
