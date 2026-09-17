// Sends one message over the socket so there is something to right-click.
//
//   node tools/say.mjs "文本" [baseUrl]

const text = process.argv[2] ?? "右键我试试撤回";
const BASE = process.argv[3] ?? "https://chat.pengda.xyz";

const session = await fetch(`${BASE}/api/session?room=test`, { method: "POST" });
const cookie = (session.headers.get("set-cookie") ?? "").split(";")[0];

const target = `${BASE.replace(/^https/, "wss").replace(/^http/, "ws")}/api/ws?room=test`;
const ws = new WebSocket(target, { headers: cookie ? { cookie } : {} });

ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ t: "say", text }));
});

ws.addEventListener("message", (ev) => {
  const data = JSON.parse(ev.data);
  if (data.t === "msg") {
    console.log(`已发送 id=${data.msg.id}  "${data.msg.body}"`);
    ws.close();
    process.exit(0);
  }
});

setTimeout(() => {
  console.error("超时：未收到消息广播");
  process.exit(1);
}, 8000);
