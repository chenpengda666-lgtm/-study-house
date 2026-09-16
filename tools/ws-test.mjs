// Exercises the Durable Object WebSocket path: handshake, broadcast between
// two independent clients, history replay, presence, and rate limiting.
//
//   node tools/ws-test.mjs [baseUrl]

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const WS_BASE = BASE.replace(/^http/, "ws");

let failures = 0;
function check(label, ok, detail = "") {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${detail ? `  ${detail}` : ""}`);
}

async function session(nick) {
  const res = await fetch(`${BASE}/api/session?nick=${encodeURIComponent(nick)}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  const token = cookie.includes("=") ? cookie.slice(cookie.indexOf("=") + 1) : "";
  return { cookie, token };
}

function openSocket(token, { since = 0 } = {}) {
  const url = `${WS_BASE}/api/ws?since=${since}&token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];

  ws.addEventListener("message", (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    inbox.push(data);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(data)) {
        waiters[i].resolve(data);
        waiters.splice(i, 1);
      }
    }
  });

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("websocket error before open")));
    setTimeout(() => reject(new Error("websocket open timeout")), 8000);
  });

  return {
    ws,
    inbox,
    ready,
    wait(predicate, label, ms = 6000) {
      const found = inbox.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
        waiters.push({
          match: predicate,
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
        });
      });
    },
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    close() {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}

const main = async () => {
  console.log(`base=${BASE}`);

  const a1 = await session("阿甲");
  const b1 = await session("阿乙");
  check("two sessions issued", Boolean(a1.token) && Boolean(b1.token), `${a1.token.slice(0, 16)} / ${b1.token.slice(0, 16)}`);

  const plain = await fetch(`${BASE}/api/ws`);
  check("non-upgrade request rejected", plain.status !== 101, `status=${plain.status}`);
  const body = await plain.json().catch(() => ({}));
  check("rejection is explicit", body.error === "expected_upgrade", JSON.stringify(body));

  const a = openSocket(a1.token);
  await a.ready;
  check("client A connected", a.ws.readyState === WebSocket.OPEN);

  const hello = await a.wait((d) => d.t === "hello", "hello frame");
  check("hello frame received", Boolean(hello.actorId), `nick=${hello.nick} online=${hello.online}`);
  check("hello carries history", Array.isArray(hello.recent), `recent=${hello.recent?.length}`);
  check("nick resolved from token", hello.nick === "阿甲", hello.nick);

  const b = openSocket(b1.token);
  await b.ready;
  const bHello = await b.wait((d) => d.t === "hello", "B hello");
  check("client B connected", b.ws.readyState === WebSocket.OPEN, `nick=${bHello.nick}`);
  check("B nick resolved", bHello.nick === "阿乙", bHello.nick);

  const presence = await a.wait((d) => d.t === "presence" && d.online >= 2, "presence>=2");
  check("presence broadcast to A", presence.online >= 2, `online=${presence.online}`);

  const text = `联调消息-${Date.now()}`;
  a.send({ t: "say", text });
  const gotA = await a.wait((d) => d.t === "msg" && d.msg?.body === text, "A echo");
  const gotB = await b.wait((d) => d.t === "msg" && d.msg?.body === text, "B broadcast");
  check("sender receives own message", gotA.msg.body === text, `id=${gotA.msg.id}`);
  check("peer receives broadcast", gotB.msg.body === text, `id=${gotB.msg.id}`);
  check("same message id for both", gotA.msg.id === gotB.msg.id, `${gotA.msg.id} vs ${gotB.msg.id}`);
  check("nick attached to message", gotB.msg.nick === "阿甲", gotB.msg.nick);

  b.send({ t: "history", since: 0, limit: 10 });
  const hist = await b.wait((d) => d.t === "history" && Array.isArray(d.msgs), "history frame");
  check("history over socket", hist.msgs.some((m) => m.body === text), `count=${hist.msgs.length}`);

  b.send({ t: "ping" });
  const pong = await b.wait((d) => d.t === "pong", "pong");
  check("ping answered", pong.t === "pong");

  const before = a.inbox.filter((d) => d.t === "msg").length;
  for (let i = 0; i < 40; i++) a.send({ t: "say", text: `flood-${i}` });
  let limited = null;
  try {
    limited = await a.wait((d) => d.t === "error" && d.error === "rate_limited", "rate limit", 8000);
  } catch {
    limited = null;
  }
  const after = a.inbox.filter((d) => d.t === "msg").length;
  check("message rate limit triggers", Boolean(limited), limited ? `scope=${limited.scope} retryAfter=${limited.retryAfter}` : "no limit hit");
  check("flood throttled", after - before < 40, `delivered=${after - before} of 40`);

  const onlineBefore = a.inbox.filter((d) => d.t === "presence").pop()?.online ?? 0;
  b.close();
  const afterClose = await a.wait((d) => d.t === "presence" && d.online < onlineBefore, "presence after close");
  check("presence drops on disconnect", afterClose.online < onlineBefore, `${onlineBefore} -> ${afterClose.online}`);

  a.close();
  await new Promise((r) => setTimeout(r, 200));

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error("harness error:", err?.message ?? err);
  process.exit(2);
});
