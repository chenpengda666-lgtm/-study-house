// Probes the limits of the part-chunk write path.
//
// putPartChunk validates partNumber (<= 4096) and only rejects a negative
// chunkIndex. If chunkIndex is unbounded, nothing caps how much a single upload
// can store: 4096 parts times unlimited chunks times 128 KB each.
//
// Writes tiny payloads at extreme indices — proving the boundary is absent
// without actually consuming meaningful storage.
//
//   node tools/audit-part-limits.mjs [baseUrl]

const BASE = process.argv[2] ?? "https://chat.pengda.xyz";
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

// A handful of bytes, base64. Small on purpose.
const TINY = Buffer.from("audit").toString("base64");

const main = async () => {
  console.log(`base=${BASE}\n`);
  await post("/api/session");

  const init = await post("/api/up/init", {
    name: "audit-limits.bin",
    mime: "application/octet-stream",
    bytes: 1024,
    sig: `limits-${Date.now()}`,
  });
  if (!init.data?.uploadId) {
    console.log("init 失败:", JSON.stringify(init.data));
    process.exit(1);
  }
  const uploadId = init.data.uploadId;

  const tryChunk = async (partNumber, chunkIndex) => {
    const r = await req(`/api/up/part?uploadId=${uploadId}&partNumber=${partNumber}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chunkIndex, chunkBase64: TINY }),
    });
    return r.data?.error ?? `OK (${r.status})`;
  };

  console.log("逐项探测写入边界：");
  const cases = [
    ["正常值", 1, 0],
    ["chunkIndex 极大", 1, 1_000_000],
    ["chunkIndex 接近上限", 1, 2_147_483_647],
    ["chunkIndex 负数", 1, -1],
    ["partNumber 上限", 4096, 0],
    ["partNumber 越界", 4097, 0],
    ["partNumber 极大", 999_999, 0],
  ];
  for (const [label, part, chunk] of cases) {
    const res = await tryChunk(part, chunk);
    console.log(`  ${label.padEnd(18)} part=${String(part).padEnd(8)} chunk=${String(chunk).padEnd(12)} -> ${res}`);
  }

  // Does the count reflect what was accepted?
  const stat = await req(`/api/up/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uploadId }) });
  console.log(`\n完成上传: ${JSON.stringify(stat.data).slice(0, 140)}`);

  const unlimitedChunk = (await tryChunk(1, 5_000_000)) === "OK (200)";
  const unlimitedPart = (await tryChunk(500_000, 0)) === "OK (200)";

  console.log("\n结论:");
  console.log(`  chunkIndex 无上限    ${unlimitedChunk ? "✗ 是（可无限写入）" : "✓ 有上限"}`);
  console.log(`  partNumber 有上限    ${unlimitedPart ? "✗ 否（超出 4096 仍接受）" : "✓ 是（4096）"}`);

  await req(`/api/files/${uploadId}`, { method: "DELETE" });
  console.log("\n已清理测试上传");

  process.exit(unlimitedChunk ? 1 : 0);
};

main().catch((err) => {
  console.error("probe error:", err?.message ?? err);
  process.exit(1);
});
