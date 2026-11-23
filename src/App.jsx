import React, { useEffect, useRef, useState } from "react";
import { registerPlugin } from '@capacitor/core';
import {
  ArrowDown,
  ArrowUpRight,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Download,
  FileInput,
  FileText,
  Image as ImageIcon,
  Globe,
  KeyRound,
  LogOut,
  Menu,
  Mic,
  MoreHorizontal,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Square,
  SquarePen,
  Sun,
  Trash2,
  UserRound,
  Volume2,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, streamChat, handleAppPause, uploadFile, speechAsr, speechTts } from "./api.js";
import { getConnectionInfo, clearNativeSession, restoreNativeSession, restoreNativeBaseUrl, setNativeBaseUrl } from "./native.js";
import { AuthDialog, ByokDialog, IconButton, ImportDialog, Modal, ServerDialog, UseNotice } from "./dialogs.jsx";
import { loadByok, saveByok, clearByok } from "./byok.js";
restoreNativeBaseUrl();
const localChatVault = registerPlugin('LocalChatStore');
const voiceRecorder = registerPlugin('VoiceRecorder');

function base64ToBlob(base64, type = 'audio/wav') {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type });
}

async function imagePreview(file, maximum = 512, quality = 0.72) {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const node = new Image();
      node.onload = () => resolve(node);
      node.onerror = reject;
      node.src = url;
    });
    const scale = Math.min(1, maximum / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  } finally { URL.revokeObjectURL(url); }
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('无法读取文件。'));
    reader.readAsDataURL(file);
  });
}

const TEXT_FILE = /\.(?:txt|md|markdown|csv|json|log|xml|html|css|js|ts|jsx|tsx|py|java|c|cpp|h|cs|go|rs|sql|yaml|yml)$/iu;
const PDF_FILE = /\.pdf$/iu;

const purposeFor = (file) => /\.(pdf|docx?|pptx?)$/iu.test(file.name) ? 'rich_layout_recognition' : 'user_data';

const dateLabel = (value) => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
};

function Message({ message, last, generating, onCopy, onRetry, onRead, reading, ttsEnabled, avatar }) {
  const pending = ["streaming", "generating"].includes(message.status);
  const demo =
    message.mode === "demo" || message.content?.startsWith("【演示模式");
  const sources = message.sources || [];
  return (
    <article className={"message " + message.role}>
      {message.role === "assistant" && (
        <div className="assistant-avatar">
          <img src={avatar || "/icons/pet.png"} className={avatar ? "avatar-photo" : ""} width="25" height="25" alt="" />
        </div>
      )}
      <div className="message-body">
        {message.role === "assistant" && (
          <div className="message-label">
            {demo
              ? "演示回复"
              : message.source === "import"
                ? "历史记录"
                : "PalmChat · AI 生成"}
          </div>
        )}
        {message.role === "user" && Array.isArray(message.attachments) && message.attachments.length > 0 && (
          <div className="message-attachments">
            {message.attachments.map((file) => (
              <div className="message-attachment" key={file.fileId}>
                {file.kind === "image" && file.preview
                  ? <img src={file.preview} alt={file.name || "图片"} />
                  : <FileText size={16} />}
                <span>{file.name || (file.kind === "image" ? "图片" : "文档")}</span>
              </div>
            ))}
          </div>
        )}
        {message.toolStatus && (
          <div className="tool-status"><span className="typing small"><i /><i /><i /></span>{message.toolStatus}</div>
        )}
        {sources.length > 0 && (
          <details className="sources">
            <summary><Globe size={14} />参考来源 {sources.length}</summary>
            <ul>
              {sources.map((source) => (
                <li key={source.url}>
                  <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title || source.url}</a>
                  {source.siteName && <small>{source.siteName}</small>}
                  {source.snippet && <p>{source.snippet}</p>}
                </li>
              ))}
            </ul>
          </details>
        )}
        {message.reasoning && (
          <details className="reasoning">
            <summary>
              <Sparkles size={14} />
              思考过程
              <ChevronDown size={14} />
            </summary>
            <p>{message.reasoning}</p>
          </details>
        )}
        <div className="message-content">
          {message.content ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ node, ...props }) => (
                  <a {...props} target="_blank" rel="noopener noreferrer" />
                ),
                img: ({ alt }) => (
                  <span className="muted">[图片{alt ? "：" + alt : ""}]</span>
                ),
              }}
            >
              {message.content}
            </ReactMarkdown>
          ) : pending ? (
            <span className="typing" aria-label="正在生成">
              <i />
              <i />
              <i />
            </span>
          ) : (
            <span className="muted">
              {message.refused
                ? "这段内容未通过模型安全审核。"
                : message.status === "error"
                  ? "回复未完成，请重试。"
                  : "已停止生成。"}
            </span>
          )}
        </div>
        {message.status === "stopped" && message.content && (
          <div className="message-status">已停止生成</div>
        )}
        {message.refused && (
          <div className="message-status error">内容未通过安全审核，请调整后重试</div>
        )}
        {message.status === "error" && !message.refused && (
          <div className="message-status error">生成中断，已保留收到的内容</div>
        )}
        {Array.isArray(message.citations) && message.citations.length > 0 && (
          <div className="citations">
            引用：
            {[...new Map(message.citations.map((item) => [item.url, item])).values()].map((item, index) => (
              <a key={item.url} href={item.url} target="_blank" rel="noopener noreferrer">[{index + 1}] {item.title || item.url}</a>
            ))}
          </div>
        )}
        {!pending && (
          <div className="message-tools">
            {message.content && (
              <IconButton label="复制" onClick={() => onCopy(message.role === "assistant" && message.source !== "import" && !demo
                ? message.content+"\n\n（AI 生成 · PalmChat）" : message.content)}>
                <Copy size={15} />
              </IconButton>
            )}
            {message.role === "assistant" && ttsEnabled && message.content && !demo && (
              <IconButton label={reading ? "停止朗读" : "朗读回答"} onClick={onRead}>
                <Volume2 size={15} />
              </IconButton>
            )}
            {message.role === "assistant" && last && (
              <IconButton
                label="重新生成"
                disabled={generating}
                onClick={onRetry}
              >
                <RefreshCw size={15} />
              </IconButton>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

export default function App() {
  const connection = getConnectionInfo();
  const [config, setConfig] = useState({
    mode: connection.configured ? "loading" : "offline",
    allowRegistration: true,
  });
  const [user, setUser] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [active, setActive] = useState(null);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [streaming, setStreaming] = useState(null);
  const [stopping, setStopping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [rename, setRename] = useState(null);
  const [deleteId, setDeleteId] = useState(null);
  const [toast, setToast] = useState("");
  const [contextTrimmed, setContextTrimmed] = useState(false);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [appearance, setAppearance] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('palm-appearance') || '{}');
      return {
        avatar: ['small', 'medium', 'large'].includes(saved.avatar) ? saved.avatar : 'medium',
        font: ['small', 'medium', 'large'].includes(saved.font) ? saved.font : 'medium',
        width: ['narrow', 'medium', 'wide'].includes(saved.width) ? saved.width : 'medium',
        density: ['compact', 'medium', 'loose'].includes(saved.density) ? saved.density : 'medium',
      };
    } catch { return { avatar: 'medium', font: 'medium', width: 'medium', density: 'medium' }; }
  });
  const [byok, setByok] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [recording, setRecording] = useState(false);
  const [readingId, setReadingId] = useState(null);
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('palm-theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
  });
  const endRef = useRef(null);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const avatarInputRef = useRef(null);
  const audioRef = useRef(null);
  const controllerRef = useRef(null);
  const lastErrorRef = useRef(null);
  const atBottomRef = useRef(true);
  const intentRef = useRef(null);
  const provider = config.provider;
  const model = config.model;
  const chatMode = config.mode;
  const features = config.features || {};
  const androidChatOnly = !connection.native && config.legacyHistoryEnabled === false;
  const byokActive = Boolean(byok?.key);
  const displayProvider = byok?.provider || provider;
  const displayModel = byok?.model || model;
  const displayMode = byokActive ? "live" : chatMode;
  // This Node server relays text chat only; media routes are not included.
  const fileEnabled = features.fileInput === true && connection.native;
  const voiceEnabled = features.asr === true && connection.native;
  const ttsEnabled = features.tts === true && connection.native;

  useEffect(() => {
    loadByok().then((value) => setByok(value)).catch(() => {});
  }, []);
  useEffect(() => {
    if (connection.native && !connection.configured) setDialog('server');
  }, [connection.native, connection.configured]);

  function report(error) {
    lastErrorRef.current = {
      code: typeof error === "object" && error?.code ? String(error.code) : "",
      message: String(typeof error === "string" ? error : error?.message || "").slice(0, 400),
      at: Date.now(),
    };
    setToast(typeof error === "string" ? error : error.message);
    if (error.status === 401) {
      setUser(null);
      setDialog("auth");
    }
  }
  async function refreshConfig() {
    try {
      const data = await api("/config");
      setConfig(data);
      return data;
    } catch { return null; }
  }
  async function refreshList() {
    if (androidChatOnly) return;
    const data = await api("/conversations");
    setConversations(data.conversations || []);
    if (data.warnings?.length) setToast(data.warnings[0]);
  }
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!connection.configured) return;
      // Restore the Keystore-encrypted token before the first authenticated request,
      // so an app update or process restart does not force a fresh login.
      await restoreNativeSession().catch(() => {});
      if (!alive) return;
      const settings = await api("/config").catch(() => ({ mode: "offline", allowRegistration: false }));
      if (!alive) return;
      setConfig(settings);
      api("/auth/me")
        .then(async (data) => {
          if (!alive) return;
          setUser(data.user);
          if (!connection.native && settings.legacyHistoryEnabled === false) return;
          const list = await api("/conversations");
          if (alive) {
            setConversations(list.conversations || []);
            if (list.warnings?.length) setToast(list.warnings[0]);
          }
        })
        .catch(() => {});
    })();
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    document.documentElement.dataset.avatarSize = appearance.avatar;
    document.documentElement.dataset.fontSize = appearance.font;
    document.documentElement.dataset.chatWidth = appearance.width;
    document.documentElement.dataset.density = appearance.density;
    try { localStorage.setItem('palm-appearance', JSON.stringify(appearance)); } catch { /* private mode */ }
  }, [appearance]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('palm-theme', theme); } catch { /* private mode */ }
  }, [theme]);
  useEffect(() => {
    const query = search.trim();
    if (!query || !connection.native) { setSearchResults(null); return; }
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const data = await api('/conversations?q=' + encodeURIComponent(query));
        if (alive) setSearchResults(data.conversations || []);
      } catch {
        if (alive) setSearchResults([]);
      }
    }, 300);
    return () => { alive = false; clearTimeout(timer); };
  }, [search, connection.native, conversations]);
  useEffect(() => () => {
    audioRef.current?.pause();
    if (recording) voiceRecorder.cancel?.().catch(() => {});
  }, []);
  useEffect(() => {
    if (atBottomRef.current)
      endRef.current?.scrollIntoView({
        block: "end",
        behavior: streaming ? "instant" : "smooth",
      });
  }, [active?.messages, streaming]);
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
      inputRef.current.style.height =
        Math.min(inputRef.current.scrollHeight, 180) + "px";
    }
  }, [draft]);

  useEffect(() => {
    if (!connection.native) return;
    function onBack(event) {
      if (noticeOpen) { event.preventDefault(); setNoticeOpen(false); }
      else if (dialog) { event.preventDefault(); setDialog(null); intentRef.current = null; }
      else if (rename) { event.preventDefault(); setRename(null); }
      else if (deleteId) { event.preventDefault(); setDeleteId(null); }
      else if (menu) { event.preventDefault(); setMenu(false); }
      else if (drawer) { event.preventDefault(); setDrawer(false); }
    }
    window.addEventListener('palm:android-back', onBack);
    return () => window.removeEventListener('palm:android-back', onBack);
  }, [noticeOpen, dialog, rename, deleteId, menu, drawer]);

  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 760px)");
    function resetDrawer() { if (!narrow.matches) setDrawer(false); }
    function dismiss(event) {
      if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;
      if (menu) setMenu(false);
      else if (drawer) setDrawer(false);
    }
    narrow.addListener(resetDrawer);
    window.addEventListener("keydown", dismiss);
    return () => {
      narrow.removeListener(resetDrawer);
      window.removeEventListener("keydown", dismiss);
    };
  }, [menu, drawer]);

  useEffect(() => {
    if (!connection.native) return;
    function onPause() {
      handleAppPause().catch(error => setToast(error.message));
    }
    function onResume() {
      refreshConfig();
      if (!active?.id || !user) return;
      api('/conversations/' + active.id).then(data => {
        setActive(current => current?.id === active.id ? data.conversation : current);
      }).catch(error => setToast(error.message));
    }
    window.addEventListener('palm:android-pause', onPause);
    window.addEventListener('palm:android-resume', onResume);
    return () => {
      window.removeEventListener('palm:android-pause', onPause);
      window.removeEventListener('palm:android-resume', onResume);
    };
  }, [active?.id, user?.id]);

  function newChat() {
    setActive(null);
    setDraft("");
    setAttachments([]);
    setDrawer(false);
    setMenu(false);
    setContextTrimmed(false);
    atBottomRef.current = true;
    setTimeout(() => inputRef.current?.focus(), 0);
  }
  function openDialog(name) {
    setMenu(false);
    setDrawer(false);
    if (name === "import" && !user) {
      intentRef.current = name;
      setDialog("auth");
      return;
    }
    setDialog(name);
  }
  async function openConversation(id) {
    setDrawer(false);
    setMenu(false);
    setContextTrimmed(false);
    setBusy(true);
    atBottomRef.current = true;
    try {
      const data = await api("/conversations/" + id);
      setActive(data.conversation);
      setDraft("");
      setAttachments([]);
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  }
  async function settle(id) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const data = await api("/conversations/" + id);
      if (
        data.conversation.messages.at(-1)?.status === "generating" &&
        attempt < 29
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      setActive((current) =>
        current?.id === id ? data.conversation : current,
      );
      break;
    }
    await refreshList();
  }
  async function send(text = draft, regenerate = false) {
    if (androidChatOnly || streaming || busy || ["offline", "loading"].includes(chatMode) || (!regenerate && !text.trim())) return;
    if (!user) {
      setDialog("auth");
      return;
    }
    if (!regenerate && attachments.length && attachments.some((item) => item.status !== 'ready')) {
      setToast('请等待附件上传完成，或移除上传失败的附件。');
      return;
    }
    const pendingAttachments = regenerate ? [] : attachments.map(({ fileId, mode, name, kind, size, preview, dataUrl, text }) =>
      ({ fileId, mode, name, kind, size, preview, dataUrl, text }));
    setBusy(true);
    setContextTrimmed(false);
    atBottomRef.current = true;
    let conversation = active;
    try {
      if (!conversation) {
        const data = await api("/conversations", {
          method: "POST",
          body: { title: "新对话" },
        });
        conversation = data.conversation;
        setActive(conversation);
        await refreshList();
      }
    } catch (error) {
      report(error);
      setBusy(false);
      return;
    }
    const id = conversation.id;
    const controller = new AbortController();
    controllerRef.current = controller;
    setActive((current) => {
      if (current?.id !== id) return current;
      const messages = [...(current.messages || [])];
      if (regenerate && messages.at(-1)?.role === "assistant") messages.pop();
      if (!regenerate)
        messages.push({
          id: "pending-user",
          role: "user",
          content: text,
          status: "complete",
          ...(pendingAttachments.length ? { attachments: pendingAttachments } : {}),
        });
      messages.push({
        id: "pending-assistant",
        role: "assistant",
        content: "",
        reasoning: "",
        status: "streaming",
        mode: displayMode,
        model: displayModel,
      });
      return { ...current, messages };
    });
    setDraft("");
    setAttachments([]);
    setStreaming(id);
    setBusy(false);
    let accepted = false;
    try {
      await streamChat(
        id,
        { content: text, thinking, regenerate,
          ...(pendingAttachments.length ? { attachments: pendingAttachments } : {}) },
        controller.signal,
        (event, data) => {
          if (event === "meta") {
            accepted = true;
            setContextTrimmed(Boolean(data.contextTrimmed));
            setActive((current) => {
              if (current?.id !== id) return current;
              const messages = [...current.messages];
              if (!regenerate && data.userMessage)
                messages[messages.length - 2] = data.userMessage;
              if (data.assistantMessage)
                messages[messages.length - 1] = {
                  ...data.assistantMessage,
                  status: "streaming",
                };
              return { ...current, messages };
            });
          } else if (event === "delta" || event === "reasoning") {
            setActive((current) => {
              if (current?.id !== id) return current;
              const messages = [...current.messages],
                last = { ...messages.at(-1) },
                key = event === "delta" ? "content" : "reasoning";
              last[key] = (last[key] || "") + (data.text || "");
              messages[messages.length - 1] = last;
              return { ...current, messages };
            });
          } else if (event === "tool") {
            setActive((current) => {
              if (current?.id !== id) return current;
              const messages = [...current.messages];
              const last = { ...messages.at(-1) };
              const call = data.call || {};
              const existing = new Map((last.sources || []).map((source) => [source.url, source]));
              for (const source of call.sources || []) if (source?.url) existing.set(source.url, source);
              if (existing.size) last.sources = [...existing.values()].slice(-30);
              last.toolStatus = data.phase === 'done' ? '' :
                call.kind === 'read_link' ? '正在阅读链接…' :
                  String(call.kind || '').includes('image') ? '正在搜索图片…' : '正在联网搜索…';
              messages[messages.length - 1] = last;
              return { ...current, messages };
            });
          } else if (event === "citation") {
            setActive((current) => {
              if (current?.id !== id) return current;
              const messages = [...current.messages];
              const last = { ...messages.at(-1) };
              last.citations = [...(last.citations || []), data].slice(-100);
              messages[messages.length - 1] = last;
              return { ...current, messages };
            });
          } else if (event === "title") {
            setActive((current) => current?.id === id && data.title ? { ...current, title: data.title } : current);
          } else if (event === "done") {
            setActive((current) => {
              if (current?.id !== id) return current;
              const next = data.conversation || current;
              return data.message?.title ? { ...next, title: data.message.title } : next;
            });
          }
        },
      );
    } catch (error) {
      if (error.name !== "AbortError") report(error);
      if (!accepted && !regenerate) {
        setDraft((current) => current || text);
        if (pendingAttachments.length) setAttachments((current) => current.length ? current : pendingAttachments.map((file) => ({ ...file, id: file.fileId, status: 'ready' })));
      }
      setActive((current) =>
        current?.id === id
          ? {
              ...current,
              messages: current.messages.map((message, index) =>
                index === current.messages.length - 1
                  ? {
                      ...message,
                      status: error.name === "AbortError" ? "stopped" : "error",
                    }
                  : message,
              ),
            }
          : current,
      );
    } finally {
      controllerRef.current = null;
      try {
        await settle(id);
      } catch {}
      setStreaming(null);
      setStopping(false);
    }
  }
  async function stop() {
    if (!streaming || stopping) return;
    setStopping(true);
    try {
      await api("/conversations/" + streaming + "/stop", {
        method: "POST",
        body: {},
      });
    } catch (error) {
      controllerRef.current?.abort();
      report(error);
    }
  }
  async function addFiles(fileList) {
    if (!fileEnabled) return;
    if (!user) { setDialog('auth'); return; }
    const room = Math.max(0, 5 - attachments.length);
    const selected = [...fileList].slice(0, room);
    if (!selected.length) { setToast('一条消息最多添加 5 个文件'); return; }
    const inline = provider === 'openrouter';
    for (const file of selected) {
      if (file.size > (config.maxUploadBytes || 20 * 1024 * 1024)) { setToast(`${file.name} 超过 20 MiB，未添加`); continue; }
      const id = crypto.randomUUID();
      const kind = file.type.startsWith('image/') ? 'image' : 'document';
      if (inline) {
        try {
          if (kind === 'image') {
            if (file.size > 6 * 1024 * 1024) throw new Error('图片超过 6 MiB，请压缩后再试。');
            const preview = await imagePreview(file, 512, 0.7);
            const dataUrl = await imagePreview(file, 1024, 0.8);
            if (dataUrl.length > 1_200_000) throw new Error('图片压缩后仍然过大，请换一张较小的图片。');
            setAttachments((current) => [...current, { id, name: file.name, kind, size: file.size, preview, dataUrl, mode: 'inline', status: 'ready' }]);
          } else if (PDF_FILE.test(file.name) || file.type === 'application/pdf') {
            if (file.size > 4 * 1024 * 1024) throw new Error('PDF 超过 4 MiB，请压缩后再试。');
            const dataUrl = await readAsDataUrl(file);
            if (dataUrl.length > 5_600_000) throw new Error('PDF 编码后过大，请换一个较小的文件。');
            setAttachments((current) => [...current, { id, name: file.name, kind: 'document', size: file.size, dataUrl, mode: 'inline', status: 'ready' }]);
          } else if (TEXT_FILE.test(file.name) || file.type.startsWith('text/')) {
            const text = await file.text();
            if (text.length > 120000) throw new Error('文本文件超过 12 万字符，请截取后再试。');
            setAttachments((current) => [...current, { id, name: file.name, kind: 'document', size: file.size, text, mode: 'inline', status: 'ready' }]);
          } else {
            throw new Error('当前渠道支持图片、PDF 和文本。请将文档转成 PDF 后再添加。');
          }
        } catch (error) {
          setToast(error.message);
        }
        continue;
      }
      let preview = '';
      if (kind === 'image') { try { preview = await imagePreview(file); } catch { /* preview is optional */ } }
      setAttachments((current) => [...current, { id, file, name: file.name, kind, size: file.size, preview, status: 'uploading' }]);
      try {
        const data = await uploadFile(file, kind === 'image' ? 'user_data' : purposeFor(file));
        setAttachments((current) => current.map((item) => item.id === id ? { ...item, fileId: data.id, status: 'ready' } : item));
      } catch (error) {
        setAttachments((current) => current.map((item) => item.id === id ? { ...item, status: 'error', error: error.message } : item));
        setToast(error.message);
      }
    }
  }
  function removeAttachment(id) {
    setAttachments((current) => current.filter((item) => item.id !== id));
  }
  async function toggleVoice() {
    if (!voiceEnabled) return;
    if (recording) {
      setRecording(false);
      try {
        const result = await voiceRecorder.stop();
        const blob = base64ToBlob(result.base64, result.mimeType || 'audio/wav');
        const data = await speechAsr(new File([blob], 'speech.wav', { type: blob.type }));
        setDraft((current) => (current ? current + ' ' : '') + data.text);
      } catch (error) {
        setToast(error.message || '语音识别失败，请重试。');
      }
      return;
    }
    try {
      await voiceRecorder.start();
      setRecording(true);
    } catch (error) {
      setToast(error.message || '无法开始录音，请检查麦克风权限。');
    }
  }
  async function readAloud(message) {
    if (readingId === message.id) {
      audioRef.current?.pause();
      audioRef.current = null;
      setReadingId(null);
      return;
    }
    audioRef.current?.pause();
    setReadingId(message.id);
    try {
      const blob = await speechTts(message.content);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { setReadingId(null); URL.revokeObjectURL(url); };
      audio.onerror = () => { setReadingId(null); URL.revokeObjectURL(url); setToast('无法播放朗读音频。'); };
      await audio.play();
    } catch (error) {
      setReadingId(null);
      setToast(error.message);
    }
  }
  async function importChats(items) {
    const data = await api("/import", {
      method: "POST",
      body: {
        data: { format: "palm-history", version: 1, conversations: items },
      },
    });
    setDialog(null);
    await refreshList();
    if (data.conversations?.[0])
      await openConversation(data.conversations[0].id);
    setToast("已导入 " + data.count + " 段对话");
  }
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      setToast("已复制");
    } catch {
      setToast("请长按文字进行复制");
    }
  }
  async function exportChat() {
    if (!active) return;
    const data = {
      format: "palm-history",
      version: 1,
      exportedBy: "PalmChat",
      contentNotice: "助手角色的回复可能由 AI 生成。导入的历史内容来自原记录。",
      conversations: [
        {
          title: active.title,
          persona: active.persona,
          messages: active.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        },
      ],
    };
    const filename = active.title.replace(/[\\/:*?"<>|]/g, '-') + '.json';
    const json = JSON.stringify(data, null, 2);
    if (connection.native) {
      try {
        const result = await localChatVault.exportDocument({filename, data:json});
        if (result.ok) setToast('聊天记录已导出');
        setDialog(null);
      } catch (error) { report(error); }
      return;
    }
    const url = URL.createObjectURL(new Blob([json], {type:'application/json'}));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDialog(null);
    setMenu(false);
  }
  async function setAvatar(file) {
    if (!file || !active) return;
    if (file.size > 8 * 1024 * 1024) { setToast('头像图片不能超过 8 MiB'); return; }
    try {
      const avatar = await imagePreview(file, 192, 0.8);
      const data = await api("/conversations/" + active.id, { method: "PATCH", body: { avatar } });
      setActive(data.conversation);
      await refreshList();
      setToast('头像已更新');
    } catch (error) { report(error); }
  }
  async function logout() {
    controllerRef.current?.abort();
    try {
      await api("/auth/logout", { method: "POST", body: {} });
    } catch (error) {
      setToast(error.message);
    } finally {
      clearNativeSession();
      setUser(null);
      setConversations([]);
      newChat();
      setDialog(null);
    }
  }
  const messages = active?.messages || [];
  const generating = streaming === active?.id;
  const history = search.trim()
    ? connection.native
      ? (searchResults || [])
      : conversations.filter((item) => item.title.toLowerCase().includes(search.trim().toLowerCase()))
    : conversations;

  return (
    <div className="app-shell">
      {drawer && (
        <button
          className="drawer-backdrop"
          aria-label="关闭导航"
          onClick={() => setDrawer(false)}
        />
      )}
      <aside
        id="conversation-sidebar"
        className={"sidebar " + (drawer ? "open" : "")}
        aria-label="对话导航"
      >
        <div className="brand">
          <img src="/icons/pet.png" alt="" width="29" height="29" />
          <strong>PalmChat</strong>
          <IconButton
            label="关闭导航"
            className="mobile-only"
            onClick={() => setDrawer(false)}
          >
            <X size={21} />
          </IconButton>
        </div>
        {!androidChatOnly && <><button className="new-chat" type="button" onClick={newChat}>
          <SquarePen size={19} />
          开启新对话
        </button>
        <label className="search-field">
          <Search size={16} />
          <input
            aria-label="搜索历史对话"
            placeholder="搜索历史对话"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="history-title">历史对话</div>
        <nav className="history-list" aria-label="历史对话">
          {history.length ? (
            history.map((item) => (
              <div
                key={item.id}
                className={
                  "history-item " + (active?.id === item.id ? "selected" : "")
                }
              >
                <button
                  className="history-open"
                  type="button"
                  aria-current={active?.id === item.id ? "page" : undefined}
                  onClick={() => openConversation(item.id)}
                >
                  <img className="history-avatar" src={item.avatar || "/icons/pet.png"} alt="" />
                  <span className="history-copy">
                    <b>{item.title}</b>
                    {item.snippet && <em>{item.snippet}</em>}
                  </span>
                  <small>{dateLabel(item.updatedAt)}</small>
                </button>
                <button
                  className="history-delete"
                  type="button"
                  aria-label={"删除对话：" + item.title}
                  title="删除对话"
                  onClick={(event) => {
                    event.stopPropagation();
                    setDeleteId(item.id);
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))
          ) : (
            <p className="history-empty">
              {search ? "没有找到相关对话" : "暂无历史对话"}
            </p>
          )}
        </nav></>}
        <details className="sidebar-settings">
          <summary>对话设置</summary>
          <div className="sidebar-settings-body">
          </div>
        </details>
        <div className="sidebar-bottom">
          <button type="button" onClick={() => openDialog(user ? "byok" : "auth")}>
            <KeyRound size={18} />模型与密钥{byokActive ? " · 已配置" : ""}
          </button>
          {!androidChatOnly && <button type="button" onClick={() => openDialog("import")}>
            <FileInput size={18} />
            导入聊天记录
          </button>}
          <button
            type="button"
            onClick={() => openDialog(user ? "settings" : "auth")}
          >
            <UserRound size={18} />
            <span>{user?.username || (config.allowRegistration ? "登录 / 注册" : "登录账号")}</span>
            <Settings size={16} />
          </button>
        </div>
      </aside>
      <main className="main-panel" inert={drawer}>
        <input ref={avatarInputRef} type="file" hidden accept="image/*"
          onChange={(event) => { setAvatar(event.target.files?.[0]); event.target.value = ""; }} />
        <header className="topbar">
          <IconButton
            label="打开导航"
            aria-controls="conversation-sidebar"
            aria-expanded={drawer}
            className="mobile-only"
            onClick={() => setDrawer(true)}
          >
            <Menu size={23} />
          </IconButton>
          <span className="conversation-title">
            {androidChatOnly ? "账号中心" : active?.title || "新对话"}
          </span>
          <div className="header-actions">
            {active && (
              <IconButton label="对话菜单" aria-expanded={menu} onClick={() => setMenu(!menu)}>
                <MoreHorizontal size={22} />
              </IconButton>
            )}
            {!androidChatOnly && <IconButton label="新建对话" onClick={newChat}>
              <SquarePen size={21} />
            </IconButton>}
          </div>
          {menu && (
            <>
              <button
                className="menu-dismiss"
                aria-label="关闭对话菜单"
                onClick={() => setMenu(false)}
              />
              <div className="context-menu">
                <button
                  type="button"
                  onClick={() => {
                    setMenu(false);
                    avatarInputRef.current?.click();
                  }}
                >
                  <ImageIcon size={16} />
                  {active.avatar ? "更换头像" : "设置头像"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenu(false);
                    setRename({ id: active.id, title: active.title });
                  }}
                >
                  <SquarePen size={16} />
                  重命名
                </button>
                  <button type="button" disabled={Boolean(streaming)} onClick={()=>{setMenu(false);setDialog('export');}}>
                    <Download size={16} />
                    导出记录
                  </button>
                <button
                  className="danger"
                  type="button"
                  disabled={generating}
                  onClick={() => {
                    setMenu(false);
                    setDeleteId(active.id);
                  }}
                >
                  <Trash2 size={16} />
                  删除对话
                </button>
              </div>
            </>
          )}
        </header>
        {androidChatOnly ? (
          <section className="account-center">
            <div className="empty-logo"><img src="/icons/pet.png" alt="" width="62" height="62" /></div>
            <h1>在安卓应用中继续</h1>
            <p>请在PalmChat 安卓应用登录同一账号，即可聊天、导入或查看本机保存的对话。</p>
            <button className="button primary" type="button" onClick={() => openDialog(user ? "settings" : "auth")}>
              {user ? "管理账号" : "登录账号"}<ArrowUpRight size={16} />
            </button>
            <button className="notice-link" type="button" onClick={() => setNoticeOpen(true)}>使用须知与隐私说明</button>
          </section>
        ) : <section className={"chat-area " + (!messages.length ? "empty" : "")}>
          <div
            className="chat-scroll"
            ref={scrollRef}
            onScroll={() => {
              const element = scrollRef.current;
              atBottomRef.current =
                element.scrollHeight -
                  element.scrollTop -
                  element.clientHeight <
                90;
              setAwayFromBottom(!atBottomRef.current);
            }}
          >
            {messages.length ? (
              <div className="messages">
                {messages.map((message, index) => (
                  <Message
                    key={message.id || index}
                    message={message}
                    last={index === messages.length - 1}
                    generating={Boolean(streaming)}
                    onCopy={copy}
                    onRetry={() => send("", true)}
                    onRead={() => readAloud(message)}
                    reading={readingId === message.id}
                    ttsEnabled={ttsEnabled}
                    avatar={active?.avatar}
                  />
                ))}
                {messages.at(-1)?.role === "user" && !generating && (
                  <button
                    className="continue-button"
                    type="button"
                    disabled={Boolean(streaming)}
                    onClick={() => send("", true)}
                  >
                    <RefreshCw size={15} />
                    继续回复
                  </button>
                )}
                <div ref={endRef} />
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-logo">
                  <img src={active?.avatar || "/icons/pet.png"} className={active?.avatar ? "avatar-photo" : ""} alt="PalmChat 头像" width="72" height="72" />
                </div>
                <h1>你好，我能帮什么忙吗？</h1>
              </div>
            )}
          </div>
          {awayFromBottom && messages.length > 0 && (
            <IconButton
              label="回到最新消息"
              className="scroll-bottom"
              onClick={() => {
                atBottomRef.current = true;
                endRef.current?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              <ArrowDown size={19} />
            </IconButton>
          )}
          <div className="composer-wrap">
            {displayMode === "demo" && (
              <div className="connection-notice" role="status">
                当前为演示模式。<button type="button" className="notice-link" onClick={() => openDialog(user ? "byok" : "auth")}>填入自己的 API Key</button>
              </div>
            )}
            {chatMode === "offline" && (
              <div className="connection-notice error" role="alert">
                {connection.error || "暂时无法连接服务，请检查网络。"}
                {connection.configured && <button type="button" className="notice-link" onClick={() => window.location.reload()}>重新连接</button>}
              </div>
            )}
            {contextTrimmed && (
              <div className="connection-notice">
                历史记录已保留，本次使用最近的对话上下文
              </div>
            )}
            {recording && (
              <div className="connection-notice recording">
                正在录音，点麦克风停止并识别为文字
              </div>
            )}
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                send();
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                hidden
                multiple
                accept={provider === 'openrouter' ? "image/*,.pdf,text/*,.txt,.md,.csv,.json" : "image/*,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.md,.csv,.json,.epub"}
                onChange={(event) => {
                  addFiles(event.target.files);
                  event.target.value = '';
                }}
              />
              {attachments.length > 0 && (
                <div className="attachment-row">
                  {attachments.map((item) => (
                    <div className={"attachment-chip " + item.status} key={item.id}>
                      {item.kind === 'image' && item.preview
                        ? <img src={item.preview} alt="" />
                        : <FileText size={15} />}
                      <span>{item.name}</span>
                      <small>{item.status === 'uploading' ? '上传中…' : item.status === 'error' ? '失败' : '就绪'}</small>
                      <button type="button" aria-label={'移除 ' + item.name} onClick={() => removeAttachment(item.id)}><X size={13} /></button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                ref={inputRef}
                aria-label="发送消息"
                rows={2}
                maxLength={60000}
                placeholder="发消息或按住说话"
                value={draft}
                disabled={busy}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing &&
                    window.matchMedia("(pointer:fine)").matches
                  ) {
                    event.preventDefault();
                    send();
                  }
                }}
              />
              {draft.length > 54000 && (
                <div className="composer-count warning" aria-live="polite">
                  {draft.length.toLocaleString()} / 60,000 字
                </div>
              )}
              <div className="composer-toolbar">
                <div className="composer-modes">
                  <button
                    className={"thinking-button " + (thinking ? "enabled" : "")}
                    type="button"
                    aria-pressed={thinking}
                    disabled={Boolean(streaming)}
                    onClick={() => setThinking(!thinking)}
                  >
                    <Sparkles size={16} />
                    深度思考
                  </button>
                </div>
                <div className="send-tools">
                  {voiceEnabled && (
                    <IconButton label={recording ? '停止录音' : '语音输入'}
                      className={recording ? 'recording' : ''}
                      disabled={Boolean(streaming) || chatMode !== 'live'} onClick={toggleVoice}>
                      <Mic size={20} />
                    </IconButton>
                  )}
                  <IconButton
                    label={fileEnabled ? '上传图片或文件' : '导入聊天记录'}
                    disabled={fileEnabled && (Boolean(streaming) || chatMode !== 'live')}
                    onClick={() => fileEnabled ? fileInputRef.current?.click() : openDialog("import")}
                  >
                    <Plus size={22} />
                  </IconButton>
                  {generating ? (
                    <button
                      className="send-button stop"
                      type="button"
                      aria-label="停止生成"
                      disabled={stopping}
                      onClick={stop}
                    >
                      <Square size={15} fill="currentColor" />
                    </button>
                  ) : (
                    <button
                      className="send-button"
                      aria-label="发送"
                      type="submit"
                      disabled={
                        !draft.trim() ||
                        Boolean(streaming) ||
                        busy ||
                        chatMode === "offline" ||
                        chatMode === "loading"
                      }
                    >
                      <ArrowUp size={22} />
                    </button>
                  )}
                </div>
              </div>
            </form>
            <p className="disclaimer">AI 生成内容，请核实重要信息。<button type="button" className="notice-link" onClick={()=>setNoticeOpen(true)}>使用须知</button><button type="button" className="notice-link" onClick={()=>openDialog(user?'byok':'auth')}>模型与密钥</button></p>
          </div>
        </section>}
      </main>
      {dialog === "auth" && (
        <AuthDialog
          onNotice={()=>setNoticeOpen(true)}
          allowRegistration={config.allowRegistration === true && !["offline", "loading"].includes(config.mode)}
          onClose={() => {
            setDialog(null);
            intentRef.current = null;
          }}
          onComplete={async (value) => {
            setUser(value);
            setDialog(intentRef.current);
            intentRef.current = null;
            await refreshList();
          }}
        />
      )}
      {dialog === "import" && (
        <ImportDialog onClose={() => setDialog(null)} onImport={importChats} />
      )}
      {dialog === 'export' && <Modal title="导出聊天记录" subtitle="此对话的文字消息将保存为明文 JSON。你可以通过「导入聊天记录」恢复这些文字。" onClose={()=>setDialog(null)}><button className="button primary full" type="button" onClick={exportChat}><Download size={17}/>{connection.native?'选择保存位置':'下载备份文件'}</button></Modal>}
      {dialog === 'server' && (
        <ServerDialog
          current={connection.configured ? connection.baseUrl.replace(/\/api$/u, '') : ''}
          required={!connection.configured}
          onClose={() => setDialog(null)}
          onSave={(value) => { setNativeBaseUrl(value); window.location.reload(); }}
        />
      )}
      {dialog === 'byok' && (
        <ByokDialog
          current={byok}
          serverMode={config.mode}
          onClose={() => setDialog(null)}
          onSave={async (value) => { const saved = await saveByok(value); setByok(saved); setToast('已保存模型密钥'); }}
          onClear={async () => { await clearByok(); setByok(null); setToast('已清除模型密钥'); }}
        />
      )}
      {dialog === "settings" && (
        <Modal title="账号与设置" className="settings-dialog" onClose={() => setDialog(null)}>
          <div className="settings-list">
            <div>
              <span>账号</span>
              <strong>{user?.username}</strong>
            </div>
            <div>
              <span>模型</span>
              <strong>{displayMode === "live" ? displayModel || displayProvider : "未连接模型"}</strong>
            </div>
            <div>
              <span>服务状态</span>
              <strong>
                {displayMode === "live"
                  ? "已连接"
                  : displayMode === "demo"
                    ? "演示模式（未配置密钥）"
                    : "未连接"}
              </strong>
            </div>
            {connection.native && (
              <div>
                <span>服务地址</span>
                <button className="text-button" type="button" onClick={() => setDialog('server')}>
                  {connection.configured ? connection.baseUrl.replace(/\/api$/u, '') : '未设置，点击填写'}
                </button>
              </div>
            )}
            <div>
              <span>模型密钥</span>
              <button className="text-button" type="button" onClick={() => setDialog('byok')}>
                <KeyRound size={15} />{byokActive ? '已配置，点击修改' : '填入自己的 API Key'}
              </button>
            </div>
            <div>
              <span>主题</span>
              <button className="text-button" type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
                {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
                {theme === 'dark' ? '切换为浅色' : '切换为深色'}
              </button>
            </div>
            <div>
              <span>头像大小</span>
              <div className="choice-row">
                {[['small', '小'], ['medium', '标准'], ['large', '大']].map(([value, label]) => (
                  <button key={value} type="button" className={appearance.avatar === value ? 'selected' : ''}
                    onClick={() => setAppearance({ ...appearance, avatar: value })}>{label}</button>
                ))}
              </div>
            </div>
            <div>
              <span>正文字号</span>
              <div className="choice-row">
                {[['small', '小'], ['medium', '标准'], ['large', '大']].map(([value, label]) => (
                  <button key={value} type="button" className={appearance.font === value ? 'selected' : ''}
                    onClick={() => setAppearance({ ...appearance, font: value })}>{label}</button>
                ))}
              </div>
            </div>
            <div>
              <span>对话宽度</span>
              <div className="choice-row">
                {[['narrow', '窄'], ['medium', '标准'], ['wide', '宽']].map(([value, label]) => (
                  <button key={value} type="button" className={appearance.width === value ? 'selected' : ''}
                    onClick={() => setAppearance({ ...appearance, width: value })}>{label}</button>
                ))}
              </div>
            </div>
            <div>
              <span>消息间距</span>
              <div className="choice-row">
                {[['compact', '紧凑'], ['medium', '标准'], ['loose', '宽松']].map(([value, label]) => (
                  <button key={value} type="button" className={appearance.density === value ? 'selected' : ''}
                    onClick={() => setAppearance({ ...appearance, density: value })}>{label}</button>
                ))}
              </div>
            </div>
            <div>
              <span>恢复默认外观</span>
              <button className="text-button" type="button"
                onClick={() => setAppearance({ avatar: 'medium', font: 'medium', width: 'medium', density: 'medium' })}>
                重置
              </button>
            </div>
            <div>
              <span>文件 / 图片</span>
              <strong>{fileEnabled ? '支持上传' : '当前渠道暂不支持'}</strong>
            </div>
            {connection.native && (
              <div>
                <span>服务连接</span>
                <strong>{connection.configured ? "已配置" : "未配置"}</strong>
              </div>
            )}
          </div>
          <p className="settings-note">{connection.native ? "聊天记录按账号加密保存在本机，卸载前请先导出需要保留的文字记录。" : config.legacyHistoryEnabled ? "本服务已开启网页历史记录，对话将保存在服务端。" : "网页历史记录未开启。请使用安卓应用保存对话。"}</p>
          {connection.error && <p className="form-error">{connection.error}</p>}
          <button type="button" className="button secondary full" onClick={()=>setNoticeOpen(true)}>使用须知与隐私说明</button>
          <button
            className="button secondary full"
            type="button"
            onClick={logout}
          >
            <LogOut size={17} />
            退出登录
          </button>
        </Modal>
      )}
      {noticeOpen && <UseNotice onClose={()=>setNoticeOpen(false)} native={connection.native} config={config} />}
      {rename && (
        <Modal title="重命名对话" onClose={() => setRename(null)}>
          <form
            className="form-stack"
            onSubmit={async (event) => {
              event.preventDefault();
              try {
                const data = await api("/conversations/" + rename.id, {
                  method: "PATCH",
                  body: { title: rename.title },
                });
                setActive(data.conversation);
                setRename(null);
                await refreshList();
              } catch (error) {
                report(error);
              }
            }}
          >
            <label>
              名称
              <input
                required
                autoFocus
                maxLength={120}
                value={rename.title}
                onChange={(event) =>
                  setRename({ ...rename, title: event.target.value })
                }
              />
            </label>
            <button className="button primary full">保存</button>
          </form>
        </Modal>
      )}
      {deleteId && (
        <Modal
          title="删除对话？"
          subtitle="删除后无法恢复。"
          onClose={() => setDeleteId(null)}
        >
          <div className="dialog-actions">
            <button
              className="button secondary"
              type="button"
              onClick={() => setDeleteId(null)}
            >
              取消
            </button>
            <button
              className="button destructive"
              type="button"
              onClick={async () => {
                try {
                  const wasActive = active?.id === deleteId;
                  await api("/conversations/" + deleteId, { method: "DELETE" });
                  setDeleteId(null);
                  if (wasActive) newChat();
                  await refreshList();
                } catch (error) {
                  report(error);
                }
              }}
            >
              删除
            </button>
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <IconButton label="关闭提示" onClick={() => setToast("")}>
            <X size={15} />
          </IconButton>
        </div>
      )}
    </div>
  );
}
