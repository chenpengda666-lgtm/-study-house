import { useCallback, useEffect, useRef, useState } from "react";

const HEARTBEAT_MS = 30_000; // A 30s interval keeps Durable Object request billing tiny.
const BASE_BACKOFF_MS = 1200;
const MAX_BACKOFF_MS = 30_000;

function sessionToken() {
  const match = document.cookie.match(/(?:^|;\s*)cfc_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function wsURL() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const since = window.__cf_chat_since || 0;
  const token = sessionToken();
  const query = new URLSearchParams({ since: String(since) });
  if (token) query.set("token", token);
  return `${proto}//${location.host}/api/ws?${query.toString()}`;
}

function upsert(list, incoming) {
  if (!incoming?.length) return list;
  const seen = new Set(list.map((m) => m.id));
  const additions = incoming.filter((m) => Number.isFinite(m.id) && !seen.has(m.id));
  if (additions.length === 0) return list;
  const merged = [...list, ...additions];
  merged.sort((a, b) => a.id - b.id);
  return merged.slice(-600);
}

export function useChat({ onMessage, onFileDeleted, onCleared, onNotice } = {}) {
  const [messages, setMessages] = useState([]);
  const [online, setOnline] = useState(0);
  const [status, setStatus] = useState("connecting");
  const [error, setError] = useState(null);

  const wsRef = useRef(null);
  const retryRef = useRef(0);
  const closedRef = useRef(false);
  const timerRef = useRef(null);
  const hbRef = useRef(null);
  const onMessageRef = useRef(onMessage);
  const onFileDeletedRef = useRef(onFileDeleted);
  const onClearedRef = useRef(onCleared);
  const onNoticeRef = useRef(onNotice);
  onMessageRef.current = onMessage;
  onFileDeletedRef.current = onFileDeleted;
  onClearedRef.current = onCleared;
  onNoticeRef.current = onNotice;

  const bumpSince = useCallback((id) => {
    if (Number.isFinite(id) && id > (window.__cf_chat_since || 0)) {
      window.__cf_chat_since = id;
    }
  }, []);

  const connect = useCallback(() => {
    if (closedRef.current) return;
    clearTimeout(timerRef.current);

    let socket;
    try {
      socket = new WebSocket(wsURL());
    } catch (err) {
      setStatus("offline");
      timerRef.current = setTimeout(connect, BASE_BACKOFF_MS);
      return;
    }
    wsRef.current = socket;
    setStatus(retryRef.current === 0 ? "connecting" : "reconnecting");

    socket.onopen = () => {
      retryRef.current = 0;
      setStatus("online");
      clearInterval(hbRef.current);
      hbRef.current = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ t: "ping" }));
        }
      }, HEARTBEAT_MS);
    };

    socket.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (data.t === "msg") {
        bumpSince(data.msg?.id);
        setMessages((prev) => upsert(prev, [data.msg]));
        onMessageRef.current?.(data.msg);
      } else if (data.t === "history" && Array.isArray(data.msgs)) {
        const last = data.msgs[data.msgs.length - 1];
        if (last) bumpSince(last.id);
        setMessages((prev) => upsert(prev, data.msgs));
      } else if (data.t === "hello") {
        if (Number.isFinite(data.lastId)) bumpSince(data.lastId);
        if (Array.isArray(data.recent) && data.recent.length) {
          const last = data.recent[data.recent.length - 1];
          if (last) bumpSince(last.id);
          setMessages((prev) => upsert(prev, data.recent));
        }
        if (data.online) setOnline(data.online);
      } else if (data.t === "presence") {
        setOnline(data.online ?? 0);
      } else if (data.t === "filedeleted") {
        // Another participant removed a file; make its card inert here too.
        onFileDeletedRef.current?.(data.fileId);
      } else if (data.t === "cleared") {
        // Someone wiped the room; drop the local transcript to match.
        setMessages([]);
        window.__cf_chat_since = 0;
        onClearedRef.current?.();
      } else if (data.t === "notice") {
        // The shared notice was edited by someone else.
        onNoticeRef.current?.(data.notice ?? "");
      } else if (data.t === "error") {
        setError({ scope: data.scope, error: data.error, retryAfter: data.retryAfter });
        setTimeout(() => setError(null), 4000);
      }
    };

    socket.onclose = () => {
      clearInterval(hbRef.current);
      if (closedRef.current) return;
      retryRef.current += 1;
      setStatus("offline");
      const delay = Math.min(BASE_BACKOFF_MS * 2 ** (retryRef.current - 1), MAX_BACKOFF_MS);
      timerRef.current = setTimeout(connect, delay);
    };

    socket.onerror = () => {
      try {
        socket.close();
      } catch {
        /* onclose handles the retry */
      }
    };
  }, [bumpSince]);

  useEffect(() => {
    closedRef.current = false;
    connect();
    return () => {
      closedRef.current = true;
      clearInterval(hbRef.current);
      clearTimeout(timerRef.current);
      try {
        wsRef.current?.close();
      } catch {
        /* already closed */
      }
    };
  }, [connect]);

  const sendText = useCallback((text) => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ t: "say", text }));
    return true;
  }, []);

  const askHistory = useCallback((params = {}) => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ t: "history", ...params }));
    return true;
  }, []);

  const mergeHistory = useCallback(
    (list) => {
      const last = list?.[list.length - 1];
      if (last) bumpSince(last.id);
      setMessages((prev) => upsert(prev, list));
    },
    [bumpSince],
  );

  return { messages, setMessages, online, status, error, sendText, askHistory, mergeHistory };
}
