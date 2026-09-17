// Confirms that the rate limiter is keyed on the session rather than the client.
//
// Callers pass session.actorId as the limiter key, and POST /api/session hands
// out a fresh actorId to anyone, with no credentials and no cost.
//
// Uses POST /api/notice (limit 10/min) because it is a writing endpoint that
// needs no upload plumbing.
//
//   node tools/audit-session-ratelimit.mjs [baseUrl]

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

const say = (req, text) =>
  req("/api/notice", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });

async function hammer(label, attempts) {
  const req = makeClient();
  await req("/api/session", { method: "POST" });
  let ok = 0;
  let limited = 0;
  let firstLimit = null;
  for (let i = 1; i <= attempts; i++) {
    const r = await say(req, `${label}-${i}`);
    if (r.status === 429) {
      limited++;
      if (firstLimit === null) firstLimit = i;
    } else if (r.status === 200) ok++;
  }
  return { label, ok, limited, firstLimit };
}

const main = async () => {
  console.log(`base=${BASE}`);
  console.log("公告接口额度：10 次/分钟\n");

  const original = (await (await fetch(`${BASE}/api/notice`)).json()).notice ?? "";

  const a = await hammer("A", 13);
  console.log(
    `会话 A：13 次请求 → 成功 ${a.ok}，被限流 ${a.limited}` +
      (a.firstLimit ? `（第 ${a.firstLimit} 次起）` : ""),
  );

  if (a.limited === 0) {
    console.log("\n前提不成立：单会话内未触发限流");
    await say(makeClient(), original);
    process.exit(1);
  }

  // A brand-new session. If the limiter were keyed on the client IP, this would
  // be blocked immediately.
  const b = makeClient();
  await b("/api/session", { method: "POST" });
  const first = await say(b, "B-1");
  console.log(`\n会话 B（全新）：第 1 次请求 → ${first.status} ${JSON.stringify(first.data).slice(0, 60)}`);

  const bypassed = first.status === 200;

  // How far can it go? Loop sessions and count total accepted writes.
  let sessions = 0;
  let accepted = 0;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && sessions < 25) {
    const c = makeClient();
    await c("/api/session", { method: "POST" });
    sessions++;
    for (let i = 0; i < 3; i++) {
      const r = await say(c, `loop-${sessions}-${i}`);
      if (r.status === 200) accepted++;
    }
  }
  console.log(`\n连续新建 ${sessions} 个会话，共被接受 ${accepted} 次写入`);
  console.log(`（若限流生效，15 秒内本应几乎全部被拒）`);

  // Restore the original notice.
  await say(makeClient(), original);
  console.log("\n已还原公告内容");

  console.log(
    bypassed
      ? "\n结论：✗ 限流键绑定在会话上 —— 每新建一个会话就重置配额，等于没有限流"
      : "\n结论：✓ 新会话同样被限制",
  );
  process.exit(bypassed ? 1 : 0);
};

main().catch((err) => {
  console.error("probe error:", err?.message ?? err);
  process.exit(1);
});
