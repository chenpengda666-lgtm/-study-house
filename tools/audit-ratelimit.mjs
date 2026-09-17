// Checks whether rate limits survive a fresh session.
//
// The limiter is keyed on whatever the callers pass as `ip`, and they pass
// session.actorId — which /api/session reissues freely to anyone. If a new
// session gets a fresh budget, the limiter is decorative.
//
// Uses /api/up/init because it is the limiter that has an HTTP endpoint
// (chat messages go over WebSocket).
//
//   node tools/audit-ratelimit.mjs [baseUrl]

const BASE = process.argv[2] ?? "https://chat.pengda.xyz";

function makeClient() {
  let cookie = "";
  return async function req(path, opts = {}) {
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
  };
}

const initUpload = (req, tag) =>
  req("/api/up/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `${tag}.bin`,
      mime: "application/octet-stream",
      bytes: 1024,
      sig: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    }),
  });

async function probeSession(label, attempts) {
  const req = makeClient();
  await req("/api/session", { method: "POST" });
  let ok = 0;
  let limited = 0;
  let firstLimitAt = null;
  for (let i = 1; i <= attempts; i++) {
    const r = await initUpload(req, `${label}-${i}`);
    if (r.status === 429) {
      limited++;
      if (firstLimitAt === null) firstLimitAt = i;
    } else if (r.data?.uploadId) {
      ok++;
    }
  }
  return { label, ok, limited, firstLimitAt };
}

const main = async () => {
  console.log(`base=${BASE}`);
  console.log("上传限流额度：10 次/分钟\n");

  const a = await probeSession("A", 14);
  console.log(`会话 A：尝试 14 次 → 成功 ${a.ok}，被限流 ${a.limited}` + (a.firstLimitAt ? `（第 ${a.firstLimitAt} 次起）` : ""));

  if (a.limited === 0) {
    console.log("\n结论：单会话内未触发限流，测试前提不成立（可能额度已调整）");
    process.exit(1);
  }

  const b = await probeSession("B", 10);
  console.log(`会话 B：尝试 10 次 → 成功 ${b.ok}，被限流 ${b.limited}`);

  const bypassed = b.ok > 0;
  console.log(
    bypassed
      ? `\n结论：✗ 全新会话仍获得 ${b.ok} 次配额 —— 换一个会话就重置限流，可无限绕过`
      : "\n结论：✓ 新会话同样被限制，限流键不依赖会话",
  );

  if (bypassed) {
    console.log("\n影响：攻击者循环调用 POST /api/session（无需任何凭证），");
    console.log("      即可无限发消息、建上传会话、清空记录 —— 现有全部限流形同虚设。");
  }
  process.exit(bypassed ? 1 : 0);
};

main().catch((err) => {
  console.error("probe error:", err?.message ?? err);
  process.exit(1);
});
