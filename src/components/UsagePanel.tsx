import { useEffect, useState } from "react";
import { api } from "../services/api.js";
import type { UsageSummary } from "../shared/accounts.js";

const tokenFormat = new Intl.NumberFormat("zh-CN");
const usdFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 8 });

export function UsagePanel() {
  const [usage, setUsage] = useState<UsageSummary>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    void api.usage(controller.signal).then((value) => {
      if (!controller.signal.aborted) setUsage(value);
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "暂时无法读取用量。");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [revision]);

  return <section className="profile-form profile-edit usage-panel" aria-labelledby="usage-title" aria-busy={loading}>
    <div className="usage-heading">
      <div><h2 id="usage-title">AI 用量与费用</h2><p className="profile-note">当前账号累计用量 · 费用为美元估算</p></div>
      <button className="button button-soft button-small" type="button" disabled={loading} onClick={() => {
        setError("");
        setLoading(true);
        setRevision((value) => value + 1);
      }}>刷新</button>
    </div>
    {error && <p className="login-error" role="alert">{error}</p>}
    {loading && !usage && <p className="profile-note" role="status">正在读取用量…</p>}
    {usage && (["text", "voice"] as const).map((category) => {
      const models = usage.models.filter((model) => model.category === category);
      return <div className="usage-group" key={category}>
        <h3>{category === "text" ? "文本模型" : "语音模型"}</h3>
        {models.length ? models.map((model) => <div className="usage-model" key={model.model}>
          <p className="usage-model-name">{model.model}</p>
          <dl className="usage-values">
            <div><dt>输入 tokens</dt><dd>{model.missingUsage === model.responses ? "—" : tokenFormat.format(model.inputTokens)}</dd></div>
            <div><dt>输出 tokens</dt><dd>{model.missingUsage === model.responses ? "—" : tokenFormat.format(model.outputTokens)}</dd></div>
            <div><dt>合计 tokens</dt><dd>{model.missingUsage === model.responses ? "—" : tokenFormat.format(model.inputTokens + model.outputTokens)}</dd></div>
            <div><dt>已估算费用</dt><dd>{model.estimatedUsd === null ? "—" : usdFormat.format(model.estimatedUsd)}</dd></div>
          </dl>
          {model.missingUsage > 0 && <p className="profile-note">{model.missingUsage} 次响应缺少 token 数据。</p>}
          {model.missingPrice > 0 && <p className="profile-note">{model.missingPrice} 次响应缺少计价信息。</p>}
        </div>) : <p className="profile-note">暂无使用记录。</p>}
        {category === "voice" && <>
          {usage.voiceCallsWithoutUsage > 0 && <p className="profile-note">{usage.voiceCallsWithoutUsage} 次通话暂无可统计的 token 数据。</p>}
          <p className="profile-note">语音数据由浏览器转报，可能受连接中断影响。</p>
        </>}
      </div>;
    })}
  </section>;
}
