// Inspects what the Pages project actually serves, so a deploy that silently
// keeps an old bundle is visible instead of assumed.
//
//   node tools/probe-pages-deploy.mjs [pagesUrl]

const URL_BASE = process.argv[2] ?? "https://your-proxy.pages.dev";

const main = async () => {
  const html = await (await fetch(`${URL_BASE}/`)).text();
  const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);
  const styles = [...html.matchAll(/href="([^"]+\.css)"/g)].map((m) => m[1]);
  console.log("线上 index.html 引用:");
  console.log("  js :", scripts.join(", ") || "(none)");
  console.log("  css:", styles.join(", ") || "(none)");

  for (const s of scripts) {
    const res = await fetch(`${URL_BASE}${s}`);
    const body = await res.text();
    console.log(`\n${s}`);
    console.log("  status:", res.status, " content-type:", res.headers.get("content-type"));
    console.log("  bytes :", body.length);
    // Marker from the decimal-capacity fix; only the new bundle has it.
    console.log("  contains decimal-capacity logic:", /1e3|1000/.test(body) ? "possible" : "no");
  }

  // A missing asset returns the SPA fallback (HTML) instead of JavaScript.
  const missing = await fetch(`${URL_BASE}/assets/__does_not_exist__.js`);
  const missingBody = await missing.text();
  console.log("\n缺失资源的响应:");
  console.log("  status:", missing.status, " content-type:", missing.headers.get("content-type"));
  console.log("  looks like HTML fallback:", missingBody.trimStart().startsWith("<"));
};

main().catch((err) => {
  console.error("probe error:", err?.message ?? err);
  process.exit(1);
});
