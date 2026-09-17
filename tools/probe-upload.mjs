// Minimal two-step upload probe: init then one part, printing both raw replies.
//
//   node tools/probe-upload.mjs [baseUrl]

const BASE = process.argv[2] ?? "http://127.0.0.1:60110";
const SIZE = 1024 * 1024;
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
  await req("/api/session", { method: "POST" });
  console.log("session ok");

  const initRes = await req("/api/up/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "probe.bin",
      mime: "application/octet-stream",
      bytes: SIZE,
      sig: `probe-${Date.now()}`,
    }),
  });
  const init = await initRes.json();
  console.log("init status :", initRes.status);
  console.log("init body   :", JSON.stringify(init));

  const uploadId = init.uploadId;
  if (!uploadId) {
    console.log("no uploadId, stopping");
    process.exit(1);
  }

  const url = `/api/up/part?uploadId=${encodeURIComponent(uploadId)}&partNumber=1`;
  console.log("part url    :", url);

  const body = Buffer.alloc(SIZE, 0x41);
  const partRes = await req(url, {
    method: "PUT",
    body,
    headers: { "content-length": String(SIZE) },
  });
  const partText = await partRes.text();
  console.log("part status :", partRes.status);
  console.log("part body   :", partText.slice(0, 300));

  const health = await (await req("/api/health")).json();
  console.log("health      :", JSON.stringify(health));
};

main().catch((err) => {
  console.error("probe error:", err?.message ?? err);
  process.exit(1);
});
