// Chunked upload with resume. Part state lives on the server in Durable Object
// storage, so reloading the page mid-upload continues from the last part the
// server confirms it holds.

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let i = -1;
  let x = v;
  do {
    x /= 1024;
    i++;
  } while (x >= 1024 && i < units.length - 1);
  // Keep one decimal below 100 and two above, so 9 GB quotas do not collapse
  // 8.99 GB and 9.00 GB into the same label.
  const digits = x < 10 ? 2 : x < 100 ? 1 : 0;
  return `${x.toFixed(digits)} ${units[i]}`;
}

// Storage quotas are expressed in decimal GB, matching how Cloudflare bills
// (1 GB = 1,000,000,000 bytes). Formatting them with the binary divisor above
// would render a 4 GB quota as "3.73 GB", which reads as missing space.
export function formatCapacity(n) {
  const v = Number(n) || 0;
  if (v < 1000) return `${v} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let i = -1;
  let x = v;
  do {
    x /= 1000;
    i++;
  } while (x >= 1000 && i < units.length - 1);
  const digits = x < 10 ? 2 : x < 100 ? 1 : 0;
  return `${x.toFixed(digits)} ${units[i]}`;
}

export function formatTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatDay(ms) {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return "今天";
  const y = new Date(today.getTime() - 86400000);
  if (sameDay(d, y)) return "昨天";
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

export function fileSignature(file) {
  return `${file.size}|${file.name}|${Math.floor(file.lastModified || 0)}`.slice(0, 64);
}

async function putWithRetry(url, blob, onTick, signal, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { method: "PUT", body: blob, signal });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        // A missing session is not a transient failure: retrying the same part
        // will fail identically, so surface it for the caller to restart.
        if (res.status === 404 && detail.includes("session_lost")) {
          const err = new Error("session_lost");
          err.restartable = true;
          throw err;
        }
        // 503 here comes from the edge when the Durable Object is overloaded.
        // Retrying immediately would land on the same backlog, so this is
        // flagged for a long backoff instead.
        if (res.status === 503) {
          const err = new Error("overloaded");
          err.overloaded = true;
          throw err;
        }
        throw new Error(`HTTP ${res.status} ${detail.slice(0, 120)}`);
      }
      const data = await res.json();
      // The server acknowledges a stored part with { ok, partNumber, chunks,
      // received }; there is no ETag because parts are written to Durable
      // Object storage rather than an object store's multipart API.
      if (data?.ok !== true) {
        throw new Error(`part rejected: ${data?.error ?? "unknown"}`);
      }
      onTick(blob.size);
      return data;
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err?.restartable) throw err;
      lastErr = err;
      const backoff = err?.overloaded ? 1500 * (i + 1) : 400 * 2 ** i;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

export async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* keep {} and fall through to the status check */
  }
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.payload = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function deleteFile(fileId) {
  const res = await fetch(`/api/files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* fall through to the status check */
  }
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Uploads one file. Reports progress through onProgress and supports pause
 * (via the returned handle) and resume across both retries and page reloads.
 */
export function uploadFile(file, { onProgress, onDone, onError, concurrency = 4 } = {}) {
  const state = { aborted: false, paused: false, stopped: false };
  const control = {
    pause() {
      state.paused = true;
    },
    resume() {
      state.paused = false;
      state.wake?.();
    },
    cancel() {
      state.stopped = true;
      state.aborted = true;
      state.wake?.();
    },
  };

  const run = async (restartAttempt = 0) => {
    let sent = 0;
    const total = file.size;

    const report = (patch) => {
      onProgress?.({ name: file.name, total, sent, ...patch });
    };

    try {
      report({ phase: "init", percent: 0 });
      const init = await postJSON("/api/up/init", {
        name: file.name,
        mime: file.type || "application/octet-stream",
        bytes: file.size,
        sig: fileSignature(file),
      });

      if (init.complete) {
        report({ phase: "done", percent: 100, sent: total, deduped: true });
        onDone?.({ ...init, deduped: true });
        return;
      }

      // Part size comes from the server; the fallback only matters if an older
      // server omits it.
      const partSize = init.partSize || 1024 * 1024;
      const partCount = Math.max(1, Math.ceil(total / partSize));
      const uploadId = init.uploadId;

      // Parts already stored never get re-sent, which is what makes
      // resume-after-reload work. The server reports how many it holds.
      const stored = Math.max(0, Number(init.received) || 0);
      const done = new Set();
      for (let n = 1; n <= stored; n++) {
        done.add(n);
        sent += Math.min(partSize, Math.max(0, total - (n - 1) * partSize));
      }
      report({
        phase: "uploading",
        percent: Math.floor((sent / total) * 100),
        resumed: Boolean(init.resumed),
      });

      const queue = [];
      for (let n = 1; n <= partCount; n++) {
        if (!done.has(n)) queue.push(n);
      }

      let cursor = 0;
      const worker = async () => {
        while (cursor < queue.length) {
          if (state.stopped) throw new Error("cancelled");
          while (state.paused && !state.stopped) {
            report({ phase: "paused", percent: Math.floor((sent / total) * 100) });
            await new Promise((r) => {
              state.wake = r;
            });
          }
          if (state.stopped) throw new Error("cancelled");

          const n = queue[cursor++];
          const start = (n - 1) * partSize;
          const blob = file.slice(start, Math.min(start + partSize, total));
          await putWithRetry(
            `/api/up/part?uploadId=${encodeURIComponent(uploadId)}&partNumber=${n}`,
            blob,
            (bytes) => {
              sent += bytes;
              report({ phase: "uploading", percent: Math.min(99, Math.floor((sent / total) * 100)) });
            },
            undefined,
          );
          done.add(n);
        }
      };

      const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker);
      await Promise.all(workers);

      report({ phase: "finalizing", percent: 99 });
      const finish = await postJSON("/api/up/complete", { uploadId });
      report({ phase: "done", percent: 100, sent: total });
      onDone?.({ ...finish, uploadId });
    } catch (err) {
      if (state.stopped) {
        report({ phase: "cancelled", percent: Math.floor((sent / total) * 100) });
        onError?.(err, { cancelled: true, resumable: true });
        return;
      }

      // The upload session vanished on the server (wiped, expired, or the
      // object was rebuilt). Restarting once is cheaper than making the user
      // retry by hand, and it cannot loop because the retry only happens once.
      if (err?.restartable && restartAttempt < 1) {
        report({ phase: "init", percent: 0, restarted: true });
        return run(restartAttempt + 1);
      }

      report({ phase: "error", percent: Math.floor((sent / total) * 100) });
      onError?.(err, { resumable: true });
    }
  };

  run();
  return control;
}
