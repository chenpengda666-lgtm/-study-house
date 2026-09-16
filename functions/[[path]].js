// Pages proxy to the Worker.
//
// Why this exists: workers.dev is blocked on some networks while pages.dev is
// reachable from the same machine, so the app is served through the Pages
// domain instead. Requests stay same-origin under that domain, so session
// cookies and WebSocket upgrades behave as they would on the Worker.
//
// Two handoff styles are supported, and the difference is large:
//   direct (default) — return the upstream Response itself. Cloudflare then
//     relays it without rebuilding the stream.
//   wrap — rebuild a Response around res.body. Measured roughly 8x slower on
//     large downloads, apparently because the rebuilt stream is relayed in
//     many small blocks.
// Set `?proxy=wrap` (or PROXY_MODE=wrap) to force the slow path for comparison.

// Upstream is the Worker's custom domain. Measured against workers.dev on this
// deployment, the custom domain was faster for the internal Pages -> Worker hop
// (0.44 vs 0.26 MB/s), though both fluctuate widely. Either way this hop stays
// inside Cloudflare, so workers.dev being blocked on client networks is
// irrelevant here — only the client-to-Pages leg touches the public internet.
const UPSTREAM = "https://chat.pengda.xyz";

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const mode = url.searchParams.get("proxy") ?? "direct";
  const target = UPSTREAM + url.pathname + url.search;
  const upgrade = context.request.headers.get("upgrade");

  const headers = new Headers(context.request.headers);
  headers.set("host", new URL(UPSTREAM).host);

  // A WebSocket upgrade must pass through with its handshake headers intact.
  if (upgrade && upgrade.toLowerCase() === "websocket") {
    const res = await fetch(target, { method: "GET", headers });
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      webSocket: res.webSocket,
    });
  }

  const res = await fetch(target, {
    method: context.request.method,
    headers,
    body: ["GET", "HEAD"].includes(context.request.method) ? undefined : context.request.body,
  });

  if (mode === "direct") {
    return res;
  }

  return new Response(res.body, { status: res.status, headers: res.headers });
}
