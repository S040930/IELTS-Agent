import { useState, type FormEvent } from "react";

type Mode = "login" | "register";

export function LoginView({ initialError, onSubmit }: {
  initialError: string;
  onSubmit: (mode: Mode, identifier: string, password: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<Mode>("login");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const registering = mode === "register";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try { await onSubmit(mode, identifier, password); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "暂时无法登录，请重试。"); }
    finally { setBusy(false); }
  }

  return <main className="login-page"><section className="login-card">
    <div className="login-mark" aria-hidden="true">IELTS</div>
    <h1>{registering ? "创建暖学账号" : "欢迎回到暖学"}</h1>
    <p className="login-copy">{registering ? "使用邮箱创建你的个人学习账号。" : "登录后继续你的雅思练习。"}</p>
    <form onSubmit={(event) => void submit(event)}>
      <label className="field"><span>{registering ? "邮箱" : "邮箱或用户名"}</span><input type={registering ? "email" : "text"}
        autoComplete="username" autoCapitalize="none" spellCheck={false} className="input" value={identifier}
        onChange={(event) => setIdentifier(event.target.value)} required maxLength={254} autoFocus /></label>
      <label className="field"><span>密码</span><input autoComplete={registering ? "new-password" : "current-password"}
        className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)}
        minLength={registering ? 12 : undefined} maxLength={256} required aria-describedby={registering ? "password-requirements" : undefined} /></label>
      {registering && <p className="login-hint" id="password-requirements">至少 12 个字符。</p>}
      {error && <p className="login-error" role="alert">{error}</p>}
      <button className="button button-primary login-submit" disabled={busy}>{busy ? "正在处理…" : registering ? "注册并登录" : "登录"}</button>
    </form>
    <div className="login-footnote">
      {registering ? "已有账号？" : "第一次使用暖学？"}
      <button className="button button-soft button-small" type="button" disabled={busy} onClick={() => {
        setMode(registering ? "login" : "register");
        setError("");
        setPassword("");
      }}>{registering ? "返回登录" : "注册账号"}</button>
    </div>
  </section></main>;
}
