// Verifies that clearing the transcript leaves the file cabinet intact.
//
//   node tools/probe-clear-scope.mjs [baseUrl]

const BASE = process.argv[2] ?? "https://chat.pengda.xyz";
const MB = 1024 * 1024;
let cookie = "";

async function req(path, opts = {}) {
  const headers = new Headers(opts.headers ?? {});
  if (cookie) headers.set("cookie", cookie);
  const res = await fetch(`${BASE}${path}${path.includes("?") ? "&" : "?"}room=test`, { ...opts, headers });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const post = (path, body) =>
  req(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

const main = async () => {
  console.log(`base=${BASE}\n`);
  await post("/api/session");

  // ---- seed: one uploaded file plus one plain message ----------------------
  const size = 2 * MB;
  const init = await post("/api/up/init", {
    name: "clear-scope.bin",
    mime: "application/octet-stream",
    bytes: size,
    sig: `scope-${Date.now()}`,
  });
  if (!init.data.uploadId) {
    console.log("上传初始化失败:", JSON.stringify(init.data));
    process.exit(1);
  }
  const payload = Buffer.alloc(size, 0x5a);
  await req(`/api/up/part?uploadId=${init.data.uploadId}&partNumber=1`, {
    method: "PUT",
    body: payload,
    headers: { "content-length": String(size) },
  });
  await post("/api/up/complete", { uploadId: init.data.uploadId });
  await post("/api/msg", { text: "这条消息应该被清空" });

  const before = {
    history: (await req("/api/history?since=0&limit=100")).data,
    files: (await req("/api/files?limit=100")).data,
  };
  console.log("清空前:");
  console.log(`  消息 ${before.history?.msgs?.length ?? 0} 条`);
  console.log(`  文件 ${before.files?.files?.length ?? 0} 个，占用 ${before.files?.capacity?.usedBytes ?? 0} 字节`);

  // ---- clear the transcript ------------------------------------------------
  const cleared = await post("/api/clear", {});
  console.log(`\n清空响应: ${cleared.status} ${JSON.stringify(cleared.data)}`);

  const after = {
    history: (await req("/api/history?since=0&limit=100")).data,
    files: (await req("/api/files?limit=100")).data,
  };
  console.log("\n清空后:");
  console.log(`  消息 ${after.history?.msgs?.length ?? 0} 条`);
  console.log(`  文件 ${after.files?.files?.length ?? 0} 个，占用 ${after.files?.capacity?.usedBytes ?? 0} 字节`);

  const msgGone = (after.history?.msgs?.length ?? 0) === 0;
  const filesKept = (after.files?.files?.length ?? 0) === (before.files?.files?.length ?? 0);
  const bytesKept = (after.files?.capacity?.usedBytes ?? 0) === (before.files?.capacity?.usedBytes ?? 0);

  // The kept file must still be downloadable, not just listed.
  const fileId = after.files?.files?.[0]?.id;
  let dlOk = false;
  if (fileId) {
    const res = await fetch(`${BASE}/api/dl/${fileId}`, { headers: { cookie } });
    dlOk = res.status === 200;
  }

  console.log("\n判定:");
  console.log(`  聊天记录已清空      ${msgGone ? "✓" : "✗"}`);
  console.log(`  文件仍在列表中      ${filesKept ? "✓" : "✗"}`);
  console.log(`  占用字节未变        ${bytesKept ? "✓" : "✗"}`);
  console.log(`  保留的文件仍可下载  ${dlOk ? "✓" : "✗"}`);

  const pass = msgGone && filesKept && bytesKept && dlOk;
  console.log(pass ? "\nCLEAR SCOPE OK" : "\nCLEAR SCOPE MISMATCH");
  process.exit(pass ? 0 : 1);
};

main().catch((err) => {
  console.error("probe error:", err?.message ?? err);
  process.exit(1);
});
