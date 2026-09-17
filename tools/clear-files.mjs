// Deletes every file currently in the cabinet.
//
//   node tools/clear-files.mjs [baseUrl] [--force]
//
// DESTRUCTIVE AND IRREVERSIBLE: deleting a file immediately destroys its bytes
// in Durable Object storage. There is no trash, no version history and no way
// to recover — the only copy is gone.
//
// It therefore refuses to touch a non-local target unless --force is passed,
// and prints exactly what it is about to delete before doing it. This guard
// exists because the script was once pointed at production by mistake and
// destroyed real user files.

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const BASE = args.find((a) => !a.startsWith("--")) ?? "http://127.0.0.1:8787";
const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/.test(BASE);

if (!isLocal && !FORCE) {
  console.error(`拒绝执行：目标是 ${BASE}，不是本地环境。\n`);
  console.error("这个脚本会永久删除文件柜里的每一个文件，且无法恢复。");
  console.error("如果确实要清理远程环境，请显式加上 --force：\n");
  console.error(`  node tools/clear-files.mjs ${BASE} --force\n`);
  process.exit(2);
}

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
    return;
  }

  // Show the full inventory first — this is the last chance to notice that
  // something in here should not be deleted.
  console.log(`即将永久删除 ${files.length} 个文件（合计 ${listed.capacity?.usedBytes ?? 0} 字节）：\n`);
  for (const f of files) {
    console.log(`  ${String(f.bytes).padStart(10)} B  ${f.name}`);
  }
  console.log("");

  for (const f of files) {
    const res = await req(`/api/files/${f.id}`, { method: "DELETE" });
    const body = await res.json().catch(() => ({}));
    const flag = body.ok ? "ok" : (body.error ?? `HTTP ${res.status}`);
    console.log(`  ${flag.padEnd(16)} ${f.name}`);
  }

  const after = await (await req("/api/files?limit=1")).json();
  console.log(`\n剩余文件 ${after.capacity.fileCount} 个，占用 ${after.capacity.usedBytes} 字节`);
};

main().catch((err) => {
  console.error("clear error:", err?.message ?? err);
  process.exit(1);
});
