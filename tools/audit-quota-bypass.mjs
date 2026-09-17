// Checks whether the declared file size can be used to bypass the quota.
//
// createUpload() validates the quota against the *declared* byte count, and
// putPartChunk() has no size check at all. If completion records the declared
// size rather than what was actually stored, real storage can exceed the quota
// while the counter says otherwise.
//
// Writes only a few MB — enough to prove the accounting is wrong, not enough to
// matter. Aborts the upload afterwards so nothing is kept.
//
//   node tools/audit-quota-bypass.mjs [baseUrl]

const BASE = process.argv[2] ?? "https://chat.pengda.xyz";
const DECLARED = 1024; // declare 1 KB
const REAL_PARTS = 2; // but store 2 parts
const PART_BYTES = 2 * 1024 * 1024; // 2 MiB each

let cookie = "";
async function req(path, opts = {}) {
  const headers = new Headers(opts.headers ?? {});
  if (cookie) headers.set("cookie", cookie);
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, data };
}

const post = (p, b) =>
  req(p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b ?? {}),
  });

const capacity = async () => (await req("/api/files?limit=1")).data?.capacity ?? {};

const main = async () => {
  console.log(`base=${BASE}`);
  console.log(`声明大小 ${DECLARED} 字节，实际写入 ${REAL_PARTS} × ${PART_BYTES} 字节\n`);

  await post("/api/session");

  const before = await capacity();
  console.log(`上传前：用量 ${before.usedBytes} 字节，剩余 ${before.remainingBytes}`);

  const init = await post("/api/up/init", {
    name: "quota-bypass.bin",
    mime: "application/octet-stream",
    bytes: DECLARED, // the quota is checked against this
    sig: `bypass-${Date.now()}`,
  });
  if (!init.data?.uploadId) {
    console.log("init 失败:", JSON.stringify(init.data));
    process.exit(1);
  }
  const uploadId = init.data.uploadId;
  console.log(`上传会话已创建（仅声明 ${DECLARED} 字节）`);

  // Push far more data than declared. Each part is sent as base64 chunks.
  const CHUNK_CHARS = 256 * 1024;
  const payload = Buffer.alloc(PART_BYTES, 0x41).toString("base64");
  let written = 0;
  for (let n = 1; n <= REAL_PARTS; n++) {
    for (let i = 0; i * CHUNK_CHARS < payload.length; i++) {
      const slice = payload.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS);
      const r = await req(`/api/up/part?uploadId=${uploadId}&partNumber=${n}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chunkIndex: i, chunkBase64: slice }),
      });
      if (r.data?.error) {
        console.log(`  分片 ${n} 块 ${i} 被拒: ${r.data.error}`);
        break;
      }
      written += Math.floor((slice.length * 3) / 4);
    }
  }
  console.log(`实际写入 ${written} 字节（声明只有 ${DECLARED}）`);

  const complete = await post("/api/up/complete", { uploadId });
  console.log(`完成上传：${complete.status} ${JSON.stringify(complete.data).slice(0, 120)}`);

  const after = await capacity();
  const counted = (after.usedBytes ?? 0) - (before.usedBytes ?? 0);
  console.log(`\n上传后：用量 ${after.usedBytes} 字节（增加 ${counted}）`);

  const fileRow = (await req("/api/files?limit=5")).data?.files?.[0];
  if (fileRow) {
    console.log(`文件记录：${fileRow.name}，记录大小 ${fileRow.bytes} 字节`);
  }

  const bypassed = written > 10 * DECLARED && counted < written / 10;
  console.log("\n判定:");
  console.log(`  实际写入远超声明       ${written > 10 * DECLARED ? "✓ 是" : "✗ 否"}`);
  console.log(`  配额只按声明计         ${counted < written / 10 ? "✓ 是" : "✗ 否"}`);
  console.log(
    bypassed
      ? `\n结论：✗ 配额可被绕过 —— 实际存储 ${written} 字节，账上只记了 ${counted} 字节`
      : "\n结论：✓ 未发现配额绕过",
  );

  // Clean up regardless of outcome.
  await req(`/api/files/${uploadId}`, { method: "DELETE" });
  const cleaned = await capacity();
  console.log(`\n已清理：用量回到 ${cleaned.usedBytes} 字节`);

  process.exit(bypassed ? 1 : 0);
};

main().catch((err) => {
  console.error("probe error:", err?.message ?? err);
  process.exit(1);
});
