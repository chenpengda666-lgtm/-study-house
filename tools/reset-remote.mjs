// Resets the deployed environment to an empty state.
//
// Uses the application's own /api/clear endpoint rather than injecting a
// temporary one: no source edit, no extra deploy, and nothing destructive ever
// gets left behind on the server.
//
//   node tools/reset-remote.mjs [targetUrl]

const TARGET = process.argv[2] ?? "https://chat.example.com";

async function call(path, { method = "GET", cookie, body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${TARGET}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: res.status, data, setCookie: res.headers.get("set-cookie") };
}

const main = async () => {
  console.log(`target=${TARGET}\n`);

  // Establish a session; the clear endpoint is rate limited per session.
  const session = await call("/api/session", { method: "POST" });
  const cookie = (session.setCookie ?? "").split(";")[0];
  if (!cookie) {
    console.error("could not obtain a session cookie");
    process.exit(1);
  }
  console.log("session ok");

  const cleared = await call("/api/clear", { method: "POST", cookie, body: {} });
  console.log(`clear: ${cleared.status} ${JSON.stringify(cleared.data)}`);
  if (cleared.status !== 200 || !cleared.data?.ok) {
    console.error("clear failed");
    process.exit(1);
  }

  // Verify from the same endpoints the UI reads.
  const history = await call("/api/history?since=0&limit=1");
  const files = await call("/api/files?limit=1");
  const msgs = history.data?.msgs ?? [];
  const cap = files.data?.capacity ?? {};

  console.log(`\nhistory: ${JSON.stringify(history.data)}`);
  console.log(`files  : ${JSON.stringify(cap)}`);

  const clean = msgs.length === 0 && (cap.fileCount ?? 0) === 0 && (cap.usedBytes ?? 0) === 0;
  console.log(clean ? "\nreset complete" : "\nWARNING: data still present");
  process.exit(clean ? 0 : 1);
};

main().catch((err) => {
  console.error("reset failed:", err?.message ?? err);
  process.exit(1);
});
