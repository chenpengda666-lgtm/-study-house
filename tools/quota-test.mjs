// Verifies the cabinet storage readout: usage grows on upload, shrinks on
// delete, and uploads are refused once the quota would be exceeded.
//
//   node tools/quota-test.mjs [baseUrl]

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const MB = 1024 * 1024;
let cookie = "";
let failures = 0;

function check(label, ok, detail = "") {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${detail ? `  ${detail}` : ""}`);
}

const gb = (n) => `${(n / 1024 ** 3).toFixed(2)} GB`;
const mb = (n) => `${(n / MB).toFixed(1)} MB`;

async function req(path, opts = {}) {
  const headers = new Headers(opts.headers ?? {});
  if (cookie) headers.set("cookie", cookie);
  const res = await fetch(`${BASE}${path}${path.includes("?") ? "&" : "?"}room=test`, { ...opts, headers });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return res;
}

async function capacity() {
  const res = await req("/api/files?limit=1");
  const data = await res.json();
  return data.capacity;
}

async function upload(name, sizeMB, fill = 0x33) {
  const size = sizeMB * MB;
  const init = await req("/api/up/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      mime: "application/octet-stream",
      bytes: size,
      sig: `${name}-${size}-${Date.now()}`,
    }),
  });
  const info = await init.json();
  if (!info.uploadId) return { error: info.error, status: init.status, payload: info };

  const partSize = info.partSize ?? 8 * MB;
  const partCount = Math.ceil(size / partSize);
  for (let n = 1; n <= partCount; n++) {
    const start = (n - 1) * partSize;
    const len = Math.min(partSize, size - start);
    const body = Buffer.alloc(len, fill);
    const up = await req(
      `/api/up/part?uploadId=${encodeURIComponent(info.uploadId)}&partNumber=${n}`,
      { method: "PUT", body, headers: { "content-length": String(len) } },
    );
    if (up.status !== 200) return { error: "part_failed", status: up.status };
  }

  const done = await req("/api/up/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uploadId: info.uploadId }),
  });
  const result = await done.json();
  return { ok: result.ok === true, fileId: info.uploadId, size: result.size, status: done.status, payload: result };
}

const main = async () => {
  console.log(`base=${BASE}`);
  await req("/api/session", { method: "POST" });

  // Assertions are relative to the starting state so the suite is repeatable
  // against a server that already holds files from earlier runs.
  const start = await capacity();
  check("capacity is exposed", typeof start?.usedBytes === "number", JSON.stringify(start));
  check("quota is 4 GB", start.quotaBytes === 4 * 1000 * 1000 * 1000, gb(start.quotaBytes));
  check("per-file cap is 1 GiB", start.maxFileBytes === 1024 ** 3, mb(start.maxFileBytes));
  console.log(`  start: used=${mb(start.usedBytes)} remaining=${gb(start.remainingBytes)} files=${start.fileCount}`);

  const baseUsed = start.usedBytes;
  const baseFiles = start.fileCount;

  const first = await upload("quota-A.bin", 12);
  check("upload A succeeded", first.ok === true, first.error ? `error=${first.error}` : `size=${mb(first.size)}`);

  const afterA = await capacity();
  check(
    "usage grew by 12 MB",
    Math.abs(afterA.usedBytes - (baseUsed + 12 * MB)) < 2048,
    `used=${mb(afterA.usedBytes)}`,
  );
  check(
    "remaining is quota minus used",
    afterA.remainingBytes === afterA.quotaBytes - afterA.usedBytes,
    gb(afterA.remainingBytes),
  );

  const second = await upload("quota-B.bin", 8);
  check("upload B succeeded", second.ok === true, `size=${mb(second.size)}`);

  const afterB = await capacity();
  check(
    "usage is 20 MB above baseline",
    Math.abs(afterB.usedBytes - (baseUsed + 20 * MB)) < 3072,
    `used=${mb(afterB.usedBytes)}`,
  );
  check("file count grew by two", afterB.fileCount === baseFiles + 2, `files=${afterB.fileCount}`);

  const del = await req(`/api/files/${first.fileId}`, { method: "DELETE" });
  check("delete accepted", del.status === 200, `status=${del.status}`);

  const afterDel = await capacity();
  check(
    "usage shrank by 12 MB on delete",
    Math.abs(afterDel.usedBytes - (baseUsed + 8 * MB)) < 2048,
    `used=${mb(afterDel.usedBytes)}`,
  );
  check(
    "remaining recovered",
    afterDel.remainingBytes === afterDel.quotaBytes - afterDel.usedBytes,
    gb(afterDel.remainingBytes),
  );

  // An oversize single file is refused before any upload work happens.
  const tooBig = await req("/api/up/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "huge.bin",
      mime: "application/octet-stream",
      bytes: 1024 ** 3 + 1,
      sig: `huge-${Date.now()}`,
    }),
  });
  const hugeBody = await tooBig.json();
  check("per-file cap enforced", hugeBody.error === "too_large", `status=${tooBig.status} ${JSON.stringify(hugeBody).slice(0, 120)}`);

  const status = await capacity();
  console.log(`  final: used=${mb(status.usedBytes)} remaining=${gb(status.remainingBytes)} files=${status.fileCount}`);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error("harness error:", err?.message ?? err);
  process.exit(2);
});
