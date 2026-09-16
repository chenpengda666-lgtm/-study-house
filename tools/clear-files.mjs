// Deletes every file currently in the cabinet, for resetting a dev environment.
//
//   node tools/clear-files.mjs [baseUrl]

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

const main = async () => {
  await req("/api/session", { method: "POST" });

  const listed = await (await req("/api/files?limit=200")).json();
  const files = listed.files ?? [];
  if (files.length === 0) {
    console.log("文件柜已经是空的");
  }

  for (const f of files) {
    const res = await req(`/api/files/${f.id}`, { method: "DELETE" });
    const body = await res.json().catch(() => ({}));
    const flag = body.ok ? "ok" : body.error ?? `HTTP ${res.status}`;
    console.log(`  ${flag.padEnd(16)} ${f.name}`);
  }

  const after = await (await req("/api/files?limit=1")).json();
  console.log(`\n剩余文件 ${after.capacity.fileCount} 个，占用 ${after.capacity.usedBytes} 字节`);
};

main().catch((err) => {
  console.error("clear error:", err?.message ?? err);
  process.exit(1);
});
