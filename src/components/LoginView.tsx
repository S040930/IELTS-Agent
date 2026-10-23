import { useState, type FormEvent } from "react";

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
  return <main className="login-page"><section className="login-card">
    <div className="login-mark" aria-hidden="true">IELTS</div>
    <p className="login-eyebrow">给自己一点时间，慢慢进步</p>
    <h1>欢迎回到暖学</h1>
    <p className="login-copy">输入演示密码，继续你的听力与阅读学习。</p>
    <form onSubmit={(event) => void submit(event)}>
      <label className="field"><span>演示密码</span><input autoComplete="current-password" className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required autoFocus /></label>
      {error && <p className="login-error" role="alert">{error}</p>}
      <button className="button button-primary login-submit" disabled={busy}>{busy ? "正在验证…" : "进入学习空间"}</button>
    </form>
    <p className="login-footnote">本 Demo 使用一个共享学习档案，所有登录者看到同一份进度。</p>
  </section></main>;
}
