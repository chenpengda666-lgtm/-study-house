import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "./lib/useChat.js";
import { deleteFile, fileSignature, formatBytes, formatCapacity, formatDay, formatTime, postJSON, uploadFile } from "./lib/upload.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // keep in sync with worker FILE_MAX_BYTES
// Overwritten by the server's reported limit once the first fetch lands.
let liveMaxFileBytes = MAX_FILE_BYTES;
const SESSION_ATTEMPTS = 4;

// Session setup can race a cold Worker start, so retry with backoff instead of
// surfacing a hard failure on the very first page load.
async function ensureSession() {
  let lastErr;
  for (let i = 0; i < SESSION_ATTEMPTS; i++) {
    try {
      return await postJSON("/api/session");
    } catch (err) {
      lastErr = err;
      if (err?.status && err.status < 500) break;
      await new Promise((r) => setTimeout(r, 600 * 2 ** i));
    }
  }
  throw lastErr;
}

function avatarText(nick, actorId) {
  const n = (nick || "").trim();
  if (n) return n.slice(0, 1);
  return (actorId || "?").slice(0, 1).toUpperCase();
}

export default function App() {
  const [me, setMe] = useState({ actorId: "", nick: "" });
  const [draft, setDraft] = useState("");
  const [uploads, setUploads] = useState([]);
  const [files, setFiles] = useState([]);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("live");
  const [sideOpen, setSideOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState("");
  // Tombstoned file ids, so a card can go inert the moment anyone deletes it,
  // including deletions announced over the socket by other people.
  const [deletedIds, setDeletedIds] = useState(() => new Set());
  const [busyIds, setBusyIds] = useState(() => new Set());
  // Storage figures arrive with every file list response.
  const [capacity, setCapacity] = useState(null);
  const [clearing, setClearing] = useState(false);
  // Shared notice bar. Anyone can edit it; edits sync to other clients live.
  const [bulletin, setBulletin] = useState("");
  const [bulletinDraft, setBulletinDraft] = useState("");
  const [bulletinEditing, setBulletinEditing] = useState(false);

  const streamRef = useRef(null);
  const textRef = useRef(null);
  const stickRef = useRef(true);
  const controlsRef = useRef(new Map());
  const fileInputRef = useRef(null);

  const loadFiles = async () => {
    try {
      const res = await fetch("/api/files?limit=80");
      const data = await res.json();
      setFiles(data.files ?? []);
      if (data.capacity) {
        setCapacity(data.capacity);
        if (data.capacity.maxFileBytes) liveMaxFileBytes = data.capacity.maxFileBytes;
      }
    } catch {
      /* the sidebar is non-critical */
    }
  };

  const chat = useChat({
    onMessage: (msg) => {
      if (msg?.kind === "file") loadFiles();
    },
    onFileDeleted: (fileId) => {
      // Drop it from the cabinet; the chat card stays but renders as gone.
      setFiles((prev) => prev.filter((f) => f.id !== fileId));
      setDeletedIds((prev) => new Set(prev).add(fileId));
    },
    // No onCleared handler: only the transcript is cleared, and the hook has
    // already dropped its own messages. The cabinet and file states are
    // deliberately left untouched.
    onNotice: (text) => setBulletin(text ?? ""),
  });

  const markDeleted = (fileId) =>
    setDeletedIds((prev) => new Set(prev).add(fileId));

  // Load the shared notice once; later edits arrive over the socket.
  useEffect(() => {
    fetch("/api/notice")
      .then((r) => r.json())
      .then((d) => setBulletin(d?.notice ?? ""))
      .catch(() => {
        /* the bar simply stays empty */
      });
  }, []);

  const saveBulletin = async () => {
    setBulletinEditing(false);
    const text = bulletinDraft.trim();
    if (text === bulletin) return;
    try {
      const res = await postJSON("/api/notice", { text });
      setBulletin(res?.notice ?? text);
    } catch (err) {
      setNotice(`公告保存失败：${err?.message ?? "网络错误"}`);
      setTimeout(() => setNotice(""), 4000);
    }
  };

  const clearHistory = async () => {
    if (
      !window.confirm(
        "清空全部聊天记录？\n\n只删除聊天消息，文件柜里的文件会保留。删除后无法恢复。",
      )
    ) {
      return;
    }
    setClearing(true);
    try {
      const res = await postJSON("/api/clear", {});
      chat.setMessages([]);
      window.__cf_chat_since = 0;
      setNotice(`已清空 ${res?.messages ?? 0} 条聊天记录，文件柜未受影响`);
      setTimeout(() => setNotice(""), 4000);
    } catch (err) {
      setNotice(`清空失败：${err?.message ?? "网络错误"}`);
    } finally {
      setClearing(false);
    }
  };

  const removeFile = async (fileId, name) => {
    if (!window.confirm(`删除「${name}」？\n\n文件将从磁盘移除，聊天记录里的卡片会变成失效状态。`)) {
      return;
    }
    setBusyIds((prev) => new Set(prev).add(fileId));
    try {
      const res = await deleteFile(fileId);
      markDeleted(fileId);
      setFiles((prev) => prev.filter((f) => f.id !== fileId));
      if (res.reclaimed === false) {
        setNotice("已标记删除，但云端对象回收失败，稍后会自动重试");
      }
    } catch (err) {
      const msg = err?.message ?? "网络错误";
      setNotice(msg === "already_deleted" ? "这个文件已经被删除了" : `删除失败：${msg}`);
      if (msg === "already_deleted") markDeleted(fileId);
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(fileId);
        return next;
      });
    }
  };

  useEffect(() => {
    ensureSession()
      .then((s) => setMe({ actorId: s.actorId, nick: s.nick }))
      .catch((err) => setNotice(`会话初始化失败（${err?.message ?? "网络错误"}），请刷新页面`));
    loadFiles();
  }, []);

  useEffect(() => {
    const el = streamRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [chat.messages]);

  const onScroll = () => {
    const el = streamRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const runSearch = async (q) => {
    const term = q.trim();
    if (!term) {
      setMode("live");
      setQuery("");
      return;
    }
    try {
      const res = await fetch(`/api/history?q=${encodeURIComponent(term)}&limit=120`);
      const data = await res.json();
      if (data.error) {
        setNotice(data.error === "rate_limited" ? "搜索太频繁，稍等一下" : `搜索失败：${data.error}`);
        return;
      }
      chat.mergeHistory(data.msgs ?? []);
      setQuery(term);
      setMode("search");
    } catch {
      setNotice("搜索请求失败");
    }
  };

  const clearSearch = () => {
    setQuery("");
    setMode("live");
    stickRef.current = true;
    chat.askHistory({ since: window.__cf_chat_since || 0, limit: 80 });
  };

  const startUpload = (file) => {
    if (!file) return;
    if (file.size > liveMaxFileBytes) {
      setNotice(`单个文件上限 ${formatBytes(liveMaxFileBytes)}，这个文件有 ${formatBytes(file.size)}`);
      return;
    }
    // Catch the obviously-too-big case here so the user is not left waiting
    // through a long upload that the server was always going to reject.
    if (capacity && capacity.remainingBytes < file.size) {
      setNotice(
        `空间不足：剩余 ${formatCapacity(capacity.remainingBytes)}，这个文件需要 ${formatBytes(file.size)}。先删掉一些文件再传。`,
      );
      return;
    }
    const key = `${fileSignature(file)}:${Date.now()}`;
    const entry = {
      key,
      name: file.name,
      total: file.size,
      sent: 0,
      percent: 0,
      phase: "init",
    };
    setUploads((prev) => [entry, ...prev].slice(0, 6));

    const patch = (key2, next) =>
      setUploads((prev) => prev.map((u) => (u.key === key2 ? { ...u, ...next } : u)));

    const control = uploadFile(file, {
      onProgress: (p) => patch(key, { percent: p.percent, phase: p.phase, sent: p.sent, resumed: p.resumed }),
      onDone: (res) => {
        patch(key, { percent: 100, phase: "done", sent: file.size });
        loadFiles();
        setTimeout(() => setUploads((prev) => prev.filter((u) => u.key !== key)), 2500);
        void res;
      },
      onError: (err, meta) => {
        const msg = String(err?.message || err);
        patch(key, {
          phase: meta?.cancelled ? "cancelled" : "error",
          error: msg,
          resumable: meta?.resumable,
        });
        setNotice(
          msg === "quota_exceeded"
            ? "空间已满，上传被拒。先删除一些文件再试。"
            : `上传失败：${msg}`,
        );
        loadFiles();
      },
    });
    controlsRef.current.set(key, control);
  };

  const onDrop = (event) => {
    event.preventDefault();
    setDragging(false);
    for (const file of event.dataTransfer?.files ?? []) startUpload(file);
  };

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    if (!chat.sendText(text)) {
      setNotice("连接未就绪，正在重连");
      return;
    }
    setDraft("");
    stickRef.current = true;
    requestAnimationFrame(() => {
      const el = streamRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  };

  const shown = useMemo(() => chat.messages, [chat.messages]);

  // A file counts as gone if this session saw it deleted, or if the server
  // already reports it tombstoned (covers reloads and other tabs).
  const isGone = (file) => Boolean(file) && (deletedIds.has(file.id) || file.deleted === true);

  const statusLabel =
    chat.status === "online" ? "已连接" : chat.status === "connecting" ? "连接中" : chat.status === "reconnecting" ? "重连中" : "离线";

  return (
    <div className="shell" onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      <section className="column">
        <header className="topbar">
          <span className="brand">学习屋</span>
          {bulletinEditing ? (
            <input
              className="bulletin-input"
              value={bulletinDraft}
              autoFocus
              maxLength={200}
              placeholder="写一句公告，回车保存，Esc 取消"
              onChange={(e) => setBulletinDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveBulletin();
                if (e.key === "Escape") setBulletinEditing(false);
              }}
              onBlur={saveBulletin}
            />
          ) : (
            <button
              type="button"
              className={`bulletin-text${bulletin ? "" : " empty"}`}
              title="点击编辑公告"
              onClick={() => {
                setBulletinDraft(bulletin);
                setBulletinEditing(true);
              }}
            >
              {bulletin || "点击添加公告"}
            </button>
          )}
          <span className="pill">
            <i className={`dot ${chat.status === "online" ? "on" : "off"}`} />
            {statusLabel} · {chat.online} 人在线
          </span>
          <button className="ghost tiny" onClick={() => setSideOpen((v) => !v)}>文件</button>
        </header>

        <div className="searchbar">
          <input
            type="search"
            placeholder="搜索历史消息，回车确认"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runSearch(e.target.value);
              if (e.key === "Escape") clearSearch();
            }}
          />
          {mode === "search" ? (
            <button className="ghost" onClick={clearSearch}>退出搜索</button>
          ) : (
            <button className="ghost" onClick={() => runSearch(query)} disabled={!query.trim()}>搜索</button>
          )}
          <button
            className="ghost danger"
            title="删除全部消息和文件，无法恢复"
            onClick={clearHistory}
            disabled={clearing}
          >
            {clearing ? "清空中…" : "清空"}
          </button>
        </div>

        {(notice || chat.error) && (
          <div className="notice" style={{ padding: "8px 18px" }}>
            {notice || `操作受限（${chat.error?.scope}），${chat.error?.retryAfter ?? 0} 秒后重试`}
          </div>
        )}

        <div className="stream" ref={streamRef} onScroll={onScroll}>
          {shown.length === 0 && (
            <div className="empty">
              还没有消息。<br />说点什么，或者把文件拖进来。
            </div>
          )}
          {shown.map((msg, idx) => {
            const prev = shown[idx - 1];
            const newDay = !prev || new Date(prev.at).toDateString() !== new Date(msg.at).toDateString();
            const mine = msg.actorId === me.actorId;
            return (
              <div key={msg.id}>
                {newDay && mode === "live" && <div className="daymark">{formatDay(msg.at)}</div>}
                <div className={`msg ${mine ? "mine" : ""}`}>
                  <div className="avatar">{avatarText(msg.nick, msg.actorId)}</div>
                  <div className="bubble-wrap">
                    <div className="meta">
                      <span>{mine ? "我" : msg.nick}</span>
                      <span>{formatTime(msg.at)}</span>
                      {mode === "search" && <span>#{msg.id}</span>}
                    </div>
                    {msg.kind === "file" && msg.file ? (
                      <div className={`filecard ${isGone(msg.file) ? "gone" : ""}`}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className="filename">{msg.file.name}</div>
                          <div className="filesub">
                            {isGone(msg.file)
                              ? `${formatBytes(msg.file.bytes)} · 已删除`
                              : `${formatBytes(msg.file.bytes)} · ${msg.file.downloads ?? 0} 次下载`}
                          </div>
                        </div>
                        {isGone(msg.file) ? (
                          <span className="filesub">不可下载</span>
                        ) : (
                          <>
                            {/* A plain link lets the browser stream straight to disk: it
                                is the fastest path measured here (~0.6 MB/s versus
                                ~0.12 MB/s for parallel range requests) and it never holds
                                the file in memory, which matters for large uploads. */}
                            <a href={`/api/dl/${msg.file.id}`} download>
                              <button className="tiny">下载</button>
                            </a>
                            <button
                              className="ghost tiny danger"
                              title="删除并清理云端文件"
                              disabled={busyIds.has(msg.file.id)}
                              onClick={() => removeFile(msg.file.id, msg.file.name)}
                            >
                              {busyIds.has(msg.file.id) ? "…" : "删除"}
                            </button>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="bubble">{msg.body}</div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="composer">
          <div className="composer-row">
            <button className="ghost" onClick={() => fileInputRef.current?.click()} title="选择文件">＋ 文件</button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                for (const f of e.target.files ?? []) startUpload(f);
                e.target.value = "";
              }}
            />
            <textarea
              ref={textRef}
              value={draft}
              placeholder="回车发送，Shift + 回车换行"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button onClick={send} disabled={!draft.trim()}>发送</button>
          </div>
        </div>
      </section>

      <aside className={`column side ${sideOpen ? "open" : ""}`}>
        {uploads.length > 0 && (
          <div className="upload-stack">
            {uploads.map((u) => (
              <div className="upload" key={u.key}>
                <div className="fileitem-head">
                  <span className="filename" style={{ maxWidth: 160 }}>{u.name}</span>
                  <span className="filesub">{formatBytes(u.total)}</span>
                </div>
                <div className={`bar ${u.phase === "paused" ? "paused" : ""}`}>
                  <i style={{ width: `${u.percent}%` }} />
                </div>
                <div className="fileitem-head">
                  <span className="filesub">
                    {u.phase === "init" && "准备中"}
                    {u.phase === "uploading" && `${u.percent}%${u.resumed ? " · 续传" : ""}`}
                    {u.phase === "paused" && "已暂停"}
                    {u.phase === "finalizing" && "合并中"}
                    {u.phase === "done" && "完成"}
                    {u.phase === "error" && "失败"}
                    {u.phase === "cancelled" && "已取消"}
                  </span>
                  <span style={{ display: "flex", gap: 6 }}>
                    {u.phase === "uploading" && (
                      <button className="ghost tiny" onClick={() => controlsRef.current.get(u.key)?.pause()}>暂停</button>
                    )}
                    {u.phase === "paused" && (
                      <button className="tiny" onClick={() => controlsRef.current.get(u.key)?.resume()}>继续</button>
                    )}
                    {(u.phase === "error" || u.phase === "cancelled") && (
                      <button className="ghost tiny" onClick={() => setUploads((prev) => prev.filter((x) => x.key !== u.key))}>移除</button>
                    )}
                  </span>
                </div>
                {u.error && <span className="notice">{u.error}</span>}
              </div>
            ))}
          </div>
        )}

        <div className="panel-title">
          文件柜
          <span className="cap-usage">
            {files.length} 个
            {capacity ? ` · ${formatCapacity(capacity.usedBytes)} / ${formatCapacity(capacity.quotaBytes)}` : ""}
          </span>
        </div>
        {capacity && (
          <>
            <div className={`cap-bar ${capacity.full ? "bad" : capacity.warn ? "warn" : ""}`}>
              <i
                style={{
                  width: `${Math.min(100, Math.max(0.6, (capacity.usedBytes / capacity.quotaBytes) * 100))}%`,
                }}
              />
            </div>
            <div className={`cap-left ${capacity.full ? "bad" : capacity.warn ? "warn" : ""}`}>
              {capacity.full
                ? "空间已满，请先删除文件"
                : `剩余 ${formatCapacity(capacity.remainingBytes)}`}
            </div>
          </>
        )}
        <div className="filelist">
          {files.length === 0 && <div className="empty">还没有文件</div>}
          {files.map((f) => (
            <div className="fileitem" key={f.id}>
              <div className="fileitem-head">
                <span className="filename">{f.name}</span>
                <button
                  className="ghost tiny danger"
                  title="删除并清理云端文件"
                  disabled={busyIds.has(f.id)}
                  onClick={() => removeFile(f.id, f.name)}
                >
                  {busyIds.has(f.id) ? "…" : "删除"}
                </button>
              </div>
              <div className="fileitem-head">
                <span className="filesub">
                  {formatBytes(f.bytes)} · {f.downloads} 次
                </span>
                <a href={`/api/dl/${f.id}`} download>
                  <button className="ghost tiny">下载</button>
                </a>
              </div>
              <span className="filesub">{f.uploader} · {formatTime(f.at)}</span>
            </div>
          ))}
        </div>
      </aside>

      {dragging && <div className="drophint">松手即上传</div>}
    </div>
  );
}
