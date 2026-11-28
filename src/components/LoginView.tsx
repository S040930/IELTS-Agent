import { useState, type FormEvent } from "react";
import { Icon } from "./Icon.js";

export function LoginView({ onLogin }: { onLogin: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await onLogin(password); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "登录没有成功，请重试。"); }
    finally { setBusy(false); }
  }
  return <main className="login-page">
    <section className="login-card">
      <div className="login-brand">
        <span className="brand-emblem" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6.5C4 5.1 5.1 4 6.5 4H11a2 2 0 0 1 2 2v13.5a1.5 1.5 0 0 0-1.5-1.5H6.5A2.5 2.5 0 0 0 4 20.5z" />
            <path d="M20 6.5C20 5.1 18.9 4 17.5 4H13a2 2 0 0 0-2 2v13.5a1.5 1.5 0 0 1 1.5-1.5h5a2.5 2.5 0 0 1 2.5 2.5z" />
          </svg>
        </span>
        <div className="login-brand-copy">
          <strong>不学雅思</strong>
          <span>English Studio</span>
        </div>
      </div>
      <h1>欢迎回到学习空间</h1>
      <p className="login-copy">输入演示密码，继续你的听力、阅读机考训练与 AI 口语对话。</p>
      <form onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span>演示密码</span>
          <input autoComplete="current-password" className="input" type="password" placeholder="请输入演示密码" value={password} onChange={(event) => setPassword(event.target.value)} required autoFocus />
        </label>
        {error && <p className="login-error" role="alert">{error}</p>}
        <button className="button button-primary login-submit" disabled={busy}>
          {busy ? "正在验证…" : "进入学习空间"}
          {!busy && <Icon name="arrow" size={15} />}
        </button>
      </form>
      <p className="login-footnote">本演示环境使用共享学习档案，所有登录者会看到同一份练习进度与画像记录。</p>
    </section>
  </main>;
}
