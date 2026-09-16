// Exercises the shared notice endpoint: read, write, read back, and the
// sanitisation rules (single line, length cap).
//
//   node tools/probe-notice.mjs [baseUrl]

const BASE = process.argv[2] ?? "https://chat.example.com";
let cookie = "";

async function req(path, opts = {}) {
  const headers = new Headers(opts.headers ?? {});
  if (cookie) headers.set("cookie", cookie);
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const post = (text) =>
  req("/api/notice", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });

const main = async () => {
  console.log(`base=${BASE}\n`);

  const initial = await req("/api/notice");
  console.log("1 初始读取       ", initial.status, JSON.stringify(initial.data));

  const written = await post("今晚 8 点在这里集合，记得带上进度");
  console.log("2 写入中文       ", written.status, JSON.stringify(written.data));

  const readBack = await req("/api/notice");
  console.log("3 回读           ", readBack.status, JSON.stringify(readBack.data));

  const multiline = await post("第一行\n第二行\r\n第三行" + "X".repeat(300));
  const n = multiline.data.notice ?? "";
  console.log(
    "4 换行+超长      ",
    `长度=${n.length} 含换行=${/[\r\n]/.test(n)} 开头=${JSON.stringify(n.slice(0, 16))}`,
  );

  const empty = await post("   ");
  console.log("5 清空           ", empty.status, JSON.stringify(empty.data));

  const finalRead = await req("/api/notice");
  console.log("6 最终状态       ", JSON.stringify(finalRead.data));

  const ok = n.length === 200 && !/[\r\n]/.test(n) && finalRead.data.notice === "";
  console.log(ok ? "\nNOTICE OK" : "\nNOTICE MISMATCH");
  process.exit(ok ? 0 : 1);
};

main().catch((err) => {
  console.error("probe error:", err?.message ?? err);
  process.exit(1);
});
