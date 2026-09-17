// Verifies that the test room is fully isolated from the real one.
//
// The whole point: a probe run must not be able to see, overwrite or delete
// anything in the real room, and a cleanup in the test room must leave the real
// room untouched.
//
//   node tools/probe-room-isolation.mjs [baseUrl]

const BASE = process.argv[2] ?? "https://chat.pengda.xyz";
const MB = 1024 * 1024;

async function client(room) {
  let cookie = "";
  // Append the room as a query parameter, using "?" or "&" as appropriate.
  const join = (path) => {
    if (room !== "test") return `${BASE}${path}`;
    return `${BASE}${path}${path.includes("?") ? "&" : "?"}room=test`;
  };

  return async function req(path, opts = {}) {
    const headers = new Headers(opts.headers ?? {});
    if (cookie) headers.set("cookie", cookie);
    const res = await fetch(join(path), { ...opts, headers });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* non-JSON */
    }
    return { status: res.status, data };
  };
}

const capacityOf = async (req) => (await req("/api/files?limit=1")).data?.capacity ?? {};
const fileNames = async (req) => ((await req("/api/files?limit=50")).data?.files ?? []).map((f) => f.name);

async function upload(req, name, text) {
  const body = Buffer.from(text.padEnd(MB, "x"));
  const init = await req("/api/up/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, mime: "text/plain", bytes: body.length, sig: `${name}-${Date.now()}` }),
  });
  if (!init.data?.uploadId) return { error: init.data?.error ?? "init_failed" };
  const put = await req(`/api/up/part?uploadId=${init.data.uploadId}&partNumber=1`, {
    method: "PUT",
    body,
    headers: { "content-length": String(body.length) },
  });
  if (!put.data?.ok) return { error: put.data?.error ?? "part_failed" };
  const done = await req("/api/up/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uploadId: init.data.uploadId }),
  });
  return done.data;
}

const main = async () => {
  console.log(`base=${BASE}\n`);

  const real = await client("main");
  const test = await client("test");
  await real("/api/session", { method: "POST" });
  await test("/api/session", { method: "POST" });

  // ---- snapshot the real room ----------------------------------------------
  const realBefore = await capacityOf(real);
  const realFilesBefore = await fileNames(real);
  console.log(`真实房间：${realFilesBefore.length} 个文件，占用 ${realBefore.usedBytes} 字节`);

  // ---- write into the test room --------------------------------------------
  const name = `isolation-probe-${Date.now()}.txt`;
  const uploaded = await upload(test, name, "test-room-only");
  console.log(`\n向测试房间上传 ${name} -> ${uploaded?.ok ? "成功" : JSON.stringify(uploaded).slice(0, 80)}`);

  if (!uploaded?.ok) {
    console.log("上传失败，测试前提不成立");
    process.exit(1);
  }

  // ---- the real room must be untouched -------------------------------------
  const realAfter = await capacityOf(real);
  const realFilesAfter = await fileNames(real);
  const testFiles = await fileNames(test);

  console.log(`\n真实房间：${realFilesAfter.length} 个文件，占用 ${realAfter.usedBytes} 字节`);
  console.log(`测试房间：${testFiles.length} 个文件${testFiles.length ? ` (${testFiles.join(", ")})` : ""}`);

  const realUnchanged =
    realFilesAfter.length === realFilesBefore.length &&
    realAfter.usedBytes === realBefore.usedBytes;
  const leakedIntoReal = realFilesAfter.includes(name);
  const presentInTest = testFiles.includes(name);

  console.log("\n判定:");
  console.log(`  测试上传出现在测试房间   ${presentInTest ? "✓" : "✗"}`);
  console.log(`  真实房间字节未变         ${realUnchanged ? "✓" : "✗"}`);
  console.log(`  真实房间未出现该文件     ${leakedIntoReal ? "✗ 泄漏了" : "✓"}`);

  // ---- clearing the test room must not touch the real one ------------------
  await test("/api/clear", { method: "POST" });
  const realAfterClear = await capacityOf(real);
  const realStillLen = realAfterClear.usedBytes === realBefore.usedBytes;
  console.log(`  清空测试房间后真实房间不变 ${realStillLen ? "✓" : "✗"}`);

  // tidy the test room
  for (const f of (await (await test("/api/files?limit=50")).data?.files ?? [])) {
    await test(`/api/files/${f.id}`, { method: "DELETE" });
  }

  const pass = presentInTest && realUnchanged && !leakedIntoReal && realStillLen;
  console.log(pass ? "\nROOM ISOLATION OK" : "\nROOM ISOLATION FAILED");
  process.exit(pass ? 0 : 1);
};

main().catch((err) => {
  console.error("probe error:", err?.message ?? err);
  process.exit(1);
});
