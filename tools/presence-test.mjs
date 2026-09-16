// Tracks the exact online count one client observes while others join and
// leave. A loose "went down" assertion hides off-by-one errors, so this prints
// the raw sequence.
//
// Each run uses its own room, otherwise sockets left over from a previous run
// would inflate the baseline and make the test non-repeatable.
//
//   node tools/presence-test.mjs [baseUrl]

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const WS_BASE = BASE.replace(/^http/, "ws");
const ROOM = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label, ok, detail = "") {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${detail ? `  ${detail}` : ""}`);
}

async function token(nick) {
  const res = await fetch(`${BASE}/api/session?nick=${encodeURIComponent(nick)}`);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  return cookie.includes("=") ? cookie.slice(cookie.indexOf("=") + 1) : "";
}

function connect(tok, label) {
  const url = `${WS_BASE}/api/ws?since=0&room=${ROOM}&token=${encodeURIComponent(tok)}`;
  const ws = new WebSocket(url);
  const presence = [];
  ws.addEventListener("message", (ev) => {
    let d;
    try {
      d = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (d.t === "presence") presence.push(d.online);
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error(`${label} failed to open`)));
    setTimeout(() => reject(new Error(`${label} open timeout`)), 8000);
  });
  return {
    ws,
    presence,
    ready,
    close: () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}

const main = async () => {
  console.log(`base=${BASE} room=${ROOM}`);

  const tokA = await token("在线甲");
  const a = connect(tokA, "A");
  await a.ready;
  await sleep(800);
  check("A alone sees 1", a.presence.at(-1) === 1, `sequence=[${a.presence}]`);

  const tokB = await token("在线乙");
  const b = connect(tokB, "B");
  await b.ready;
  await sleep(800);
  check("A sees 2 when B joins", a.presence.at(-1) === 2, `sequence=[${a.presence}]`);

  const tokC = await token("在线丙");
  const c = connect(tokC, "C");
  await c.ready;
  await sleep(800);
  check("A sees 3 when C joins", a.presence.at(-1) === 3, `sequence=[${a.presence}]`);

  c.close();
  await sleep(1200);
  check("A sees 2 when C leaves", a.presence.at(-1) === 2, `sequence=[${a.presence}]`);

  b.close();
  await sleep(1200);
  check("A sees 1 when B leaves", a.presence.at(-1) === 1, `sequence=[${a.presence}]`);

  // A fresh client in the same room must land on the same number.
  a.close();
  await sleep(1200);
  const a2 = connect(tokA, "A2");
  await a2.ready;
  await sleep(1000);
  check("fresh client sees exactly 1", a2.presence.at(-1) === 1, `sequence=[${a2.presence}]`);
  a2.close();

  console.log(`\nA presence sequence: [${a.presence}]`);
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error("harness error:", err?.message ?? err);
  process.exit(2);
});
