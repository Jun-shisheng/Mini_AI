import React, { useEffect, useRef, useState } from "react";
import {
  X,
  ArrowRight,
  ShieldCheck,
  Check,
  MessageCircle,
  CircleHelp,
  Upload,
  KeyRound,
} from "lucide-react";
import { api } from "./api.js";

function IconButton({ label, children, className = "", ...props }) {
  return (
    <button
      className={`icon-button ${className}`.trim()}
      type="button"
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}

function Modal({ title, subtitle, children, onClose, className = "", dismissible = true }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      previous?.focus?.();
    };
  }, []);
  return (
    <dialog
      aria-label={title}
      className={"modal " + className}
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(event) => {
        if (dismissible && event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {dismissible && (
          <IconButton label="关闭" onClick={onClose}>
            <X size={20} />
          </IconButton>
        )}
      </div>
      {children}
    </dialog>
  );
}

function AuthDialog({ onClose, onComplete, allowRegistration, onNotice }) {
  const [register, setRegister] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const data = await api("/auth/" + (register ? "register" : "login"), {
        method: "POST",
        body: { username, password },
      });
      await onComplete(data.user);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={register ? "注册账号" : "登录"}
      subtitle={register ? "创建账号后即可开始对话。" : allowRegistration ? undefined : "请使用服务方提供的账号和密码。"}
      onClose={onClose}
      className="auth-modal"
    >
      <form onSubmit={submit} className="form-stack">
        <label>
          用户名
          <input
            autoFocus
            required
            autoComplete="username"
            minLength={2}
            maxLength={32}
            placeholder={register ? "2–32 位中文、字母、数字或下划线" : "输入用户名"}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label>
          密码
          <input
            required
            type="password"
            autoComplete={register ? "new-password" : "current-password"}
            minLength={8}
            maxLength={128}
            placeholder={register ? "至少 8 位" : "输入密码"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <button className="button primary full" disabled={busy}>
          {busy ? register ? "正在注册…" : "正在登录…" : register ? "创建账号" : "登录"}
          <ArrowRight size={17} />
        </button>
        {allowRegistration && (
          <button
            className="text-button"
            type="button"
            onClick={() => {
              setRegister(!register);
              setError("");
            }}
          >
            {register ? "已有账号？去登录" : "没有账号？注册"}
          </button>
        )}
      </form>
      <div className="modal-footnote">
        <ShieldCheck size={15} /><button type="button" className="notice-link" onClick={onNotice}>查看使用须知与隐私说明</button>
      </div>
    </Modal>
  );
}

function ImportDialog({ onClose, onImport }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="导入聊天记录"
      subtitle="先预览文字记录，确认后会添加为新对话。"
      onClose={onClose}
    >
      <label className="upload-zone">
        <Upload size={23} />
        <strong>{busy ? "正在读取…" : "选择聊天记录文件"}</strong>
        <small>JSON、ZIP、TXT 或 Markdown，最大 20 MB</small>
        <input type="file" accept=".json,.zip,.txt,.md,.markdown" disabled={busy}
          onChange={async event => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            setBusy(true); setError(""); setPreview(null);
            try {
              const { readHistoryFile } = await import("./importFiles.js");
              setPreview(await readHistoryFile(file));
            }
            catch (error) { setError(error.message); }
            finally { setBusy(false); }
          }} />
      </label>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {preview && (
        <div className="import-preview">
          <div>
            <Check size={17} />
            <span>{preview.conversations.length} 段对话，{preview.conversations.reduce((sum, item) => sum + item.messages.length, 0)} 条消息</span>
          </div>
          {preview.warnings?.length > 0 && <ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
          <button className="button primary full" type="button" disabled={busy}
            onClick={() => onImport(preview.conversations)}>确认导入</button>
        </div>
      )}
      <div className="modal-footnote">
        <CircleHelp size={15} />
        <span>支持 PalmChat 导出的 JSON，或 DeepSeek 导出的记录文件。图片和附件不会随文字记录恢复。</span>
      </div>
    </Modal>
  );
}

function UseNotice({ onClose, native, config }) {
  return <Modal title="使用须知与隐私说明" onClose={onClose}>
    <div className="use-notice">
      <section><h3>关于 PalmChat</h3><p>PalmChat 是开源的聊天应用。DeepSeek 和 OpenRouter 是可接入的第三方模型服务。角色的身份、感情表达和承诺均属于生成的对话情节。</p></section>
      <section><h3>如何看待回复</h3><p>AI 可能编造事实、人物或引用，也可能遗漏早先的对话。涉及健康、法律、财务等重要决定，请核对原始资料，并向具备相应资质的专业人士咨询。遇到紧急情况，请联系现实中的求助渠道。</p></section>
      <section><h3>发送消息时会传输什么</h3><p>本次消息和选取的历史上下文会通过你自建的服务端发送到模型服务。通过 OpenRouter 时，承接请求的模型提供方也会处理这些内容。</p>
        <p>{native ? '安卓聊天记录按账号加密保存在本机。卸载或清除应用数据可能丢失记录；手动导出的 JSON 包含明文，请妥善保管。' : '网页预览的历史存储取决于当前服务配置；启用云端历史时，服务端会保存对话。手动导出的 JSON 包含明文。'} 服务端另行保存账号和用量等运行记录。</p></section>
      <section><h3>自备 API Key</h3><p>你在“模型与密钥”中填写的 Key 只保存在本机（安卓使用 Keystore 加密），随对话请求发送到你自建的服务端，再由服务端转发给模型提供方。请使用 HTTPS 访问服务端，不要把 Key 填入不可信的公共部署。</p></section>
      <section><h3>导入、分享与未成年人使用</h3><p>请只导入、复制或分享有权使用的内容，分享前移除私人信息，保留 AI 生成提示。未成年人请在监护人指导下使用。</p></section>
    </div>
  </Modal>;
}

function ByokDialog({ onClose, current, onSave, onClear, serverMode }) {
  const [provider, setProvider] = useState(current?.provider || "deepseek");
  const [key, setKey] = useState("");
  const [model, setModel] = useState(current?.model || "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const hasSaved = Boolean(current?.key);
  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (!key.trim() && current?.key && provider !== current.provider)
        throw new Error("切换服务商后请重新填写 API Key。");
      const nextKey = key.trim() || current?.key || "";
      if (!nextKey) throw new Error("请填写 API Key。");
      await onSave({ provider, key: nextKey, model });
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="模型与密钥" subtitle="使用你自己的 DeepSeek 或 OpenRouter API Key。" onClose={onClose} className="byok-modal">
      <form className="form-stack" onSubmit={submit}>
        <label>
          服务商
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="deepseek">DeepSeek</option>
            <option value="openrouter">OpenRouter</option>
          </select>
        </label>
        <label>
          API Key
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={hasSaved ? "已保存；留空表示不修改" : "sk-..."}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        <label>
          模型（可选）
          <input
            autoComplete="off"
            spellCheck={false}
            placeholder={provider === "deepseek" ? "deepseek-flash" : "openrouter/free"}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>
        <p className="settings-note">
          <ShieldCheck size={15} /> Key 只保存在本机（安卓使用 Keystore 加密），随对话请求发送到你自建的服务端，不会写入仓库或安装包。
          {serverMode === "demo" ? " 当前服务端未配置密钥，填入后即可开始真实对话。" : ""}
        </p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button primary full" disabled={busy}>{busy ? "保存中…" : "保存密钥"}</button>
        {hasSaved && (
          <button type="button" className="button secondary full" disabled={busy}
            onClick={async () => { setBusy(true); try { await onClear(); onClose(); } catch (e) { setError(e.message); } finally { setBusy(false); } }}>
            清除已保存的密钥
          </button>
        )}
        <p className="modal-footnote"><KeyRound size={15} /><span>也可以在服务端 .env 中配置 DEEPSEEK_API_KEY / OPENROUTER_API_KEY；应用内的 Key 会覆盖服务端默认值。</span></p>
      </form>
    </Modal>
  );
}

export { IconButton, Modal, AuthDialog, ImportDialog, UseNotice, ByokDialog };
