// Seeds two states for UI inspection: one live file and one deleted file.
//
//   node tools/seed-ux.mjs [baseUrl]

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
let cookie = "";

async function req(path, opts = {}) {
  const headers = new Headers(opts.headers ?? {});
  if (cookie) headers.set("cookie", cookie);
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return res;
}

async function uploadOne(name, fill, size = 1024 * 1024) {
  const payload = Buffer.alloc(size, fill);
  const init = await req("/api/up/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      mime: "application/octet-stream",
      bytes: size,
      sig: `${name}-${size}-${Date.now()}`,
    }),
  });
  const info = await init.json();
  if (!info.uploadId) return { ok: false, detail: JSON.stringify(info).slice(0, 160) };

  const part = await req(
    `/api/up/part?uploadId=${encodeURIComponent(info.uploadId)}&partNumber=1`,
    { method: "PUT", body: payload, headers: { "content-length": String(size) } },
  );
  if (part.status !== 200) return { ok: false, detail: `part ${part.status}` };

  const done = await req("/api/up/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uploadId: info.uploadId }),
  });
  const result = await done.json();
  return { ok: result.ok === true, fileId: info.uploadId, size: result.size };
}

const main = async () => {
  await req("/api/session", { method: "POST" });

  const live = await uploadOne("保留-Probe.bin", 0x11);
  console.log("live file     ->", live.ok ? `ok ${live.size} bytes` : `FAILED ${live.detail}`);

  const dead = await uploadOne("已删-Probe.bin", 0x22);
  console.log("doomed file   ->", dead.ok ? `ok ${dead.size} bytes` : `FAILED ${dead.detail}`);

  if (dead.ok) {
    const del = await req(`/api/files/${dead.fileId}`, { method: "DELETE" });
    const body = await del.json().catch(() => ({}));
    console.log("delete result ->", `status=${del.status}`, JSON.stringify(body).slice(0, 120));
  }

  const files = await req("/api/files?limit=20");
  const listed = await files.json();
  console.log("cabinet now   ->", (listed.files ?? []).map((f) => f.name).join(", ") || "(empty)");

  const hist = await req("/api/history?since=0&limit=20");
  const msgs = (await hist.json()).msgs ?? [];
  const cards = msgs.filter((m) => m.kind === "file").map((m) => `${m.file?.name}${m.file?.deleted ? " [已删除]" : ""}`);
  console.log("cards in chat ->", cards.join(", ") || "(none)");
};

main().catch((err) => {
  console.error("seed error:", err?.message ?? err);
  process.exit(1);
});
