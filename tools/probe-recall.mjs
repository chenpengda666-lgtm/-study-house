// Verifies message retraction: no ownership check, no time limit, and the
// removal propagates to other clients over the socket.
//
//   node tools/probe-recall.mjs [baseUrl]

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

// Minimal WebSocket client: collects frames so we can wait for a specific one.
function openSocket(label) {
  const wsUrl = `${BASE.replace(/^http/, "ws")}/api/ws`;
  const ws = new WebSocket(wsUrl);
  const seen = [];
  ws.addEventListener("message", (ev) => {
    try {
      seen.push(JSON.parse(ev.data));
    } catch {
      /* ignore */
    }
  });
  return { ws, seen, label, open: () => new Promise((r) => ws.addEventListener("open", r, { once: true })) };
}

const waitFor = async (client, pred, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = client.seen.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 60));
  }
  return null;
};

const main = async () => {
  console.log(`base=${BASE}\n`);
  await post("/api/session");

  // Two clients: one sends, the other watches for the retraction broadcast.
  const sender = openSocket("sender");
  const watcher = openSocket("watcher");
  await Promise.all([sender.open(), watcher.open()]);
  await new Promise((r) => setTimeout(r, 600));

  const text = `recall-probe-${Date.now()}`;
  sender.ws.send(JSON.stringify({ t: "say", text }));

  const announced = await waitFor(sender, (m) => m.t === "msg" && m.msg?.body === text);
  if (!announced) {
    console.log("✗ 消息未被广播，测试前提不成立");
    process.exit(1);
  }
  const msgId = announced.msg.id;
  console.log(`已发送消息 id=${msgId}`);

  const watcherSaw = await waitFor(watcher, (m) => m.t === "msg" && m.msg?.id === msgId);
  console.log(`另一客户端收到该消息      ${watcherSaw ? "✓" : "✗"}`);

  // ---- retract it -----------------------------------------------------------
  const res = await req(`/api/msg/${msgId}`, { method: "DELETE" });
  console.log(`\n撤回响应                  ${res.status} ${JSON.stringify(res.data)}`);

  const recalled = await waitFor(watcher, (m) => m.t === "msgrecalled" && m.id === msgId);
  console.log(`另一客户端收到撤回广播    ${recalled ? "✓" : "✗"}${recalled ? `  by=${recalled.by}` : ""}`);

  // ---- gone from history ----------------------------------------------------
  const hist = await req("/api/history?since=0&limit=200");
  const stillThere = (hist.data?.msgs ?? []).some((m) => m.id === msgId);
  console.log(`历史记录中已不存在        ${stillThere ? "✗ 仍存在" : "✓"}`);

  // ---- idempotence / error handling ----------------------------------------
  const again = await req(`/api/msg/${msgId}`, { method: "DELETE" });
  console.log(`重复撤回                  ${again.status} ${JSON.stringify(again.data)}`);
  const bad = await req("/api/msg/notanumber", { method: "DELETE" });
  console.log(`非法 id                   ${bad.status} ${JSON.stringify(bad.data)}`);

  sender.ws.close();
  watcher.ws.close();

  const pass =
    watcherSaw && recalled && !stillThere && again.status === 404 && bad.status === 400;
  console.log(pass ? "\nRECALL OK" : "\nRECALL MISMATCH");
  process.exit(pass ? 0 : 1);
};

main().catch((err) => {
  console.error("probe error:", err?.message ?? err);
  process.exit(1);
});
