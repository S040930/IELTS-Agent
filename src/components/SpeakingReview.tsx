import { criteria, type SpeakingLine, type SpeakingRecord } from "../shared/speaking.js";

export const dateLabel = (date: string) => new Date(date).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });

export function Transcript({ lines, example = false }: { lines: SpeakingLine[]; example?: boolean }) {
  return <details className="speech-transcript"><summary>英文对话字幕</summary>
    {lines.length ? <ol>{lines.map(line => <li key={line.id}><strong>{line.role === "examiner" ? "考官" : example ? "示例学生" : "你"}</strong><span lang="en">{line.text}</span></li>)}</ol> : <p>对话开始后会在这里显示字幕。</p>}
  </details>;
}

type ReviewProps = { record: SpeakingRecord; example?: false }
  | { record: Pick<SpeakingRecord, "part" | "topic" | "feedback" | "lines">; example: true };

export function SpeakingReview(props: ReviewProps) {
  const { record, example } = props;
  const feedback = record.feedback;
  return <article className="speech-panel speech-review">
    <header><p className="speech-meta">Part {record.part} · {example ? "演示复盘" : dateLabel(props.record.endedAt)}</p><h2>{record.topic}</h2></header>
    {feedback ? <>
      <h3>下次先练这一点</h3><p>{feedback.advice}</p>
      {feedback.quote && <blockquote lang="en"><small>{example ? "示例学生原话" : "你的原话"}</small>{feedback.quote}</blockquote>}
      {feedback.revision && <blockquote lang="en"><small>可以这样说</small>{feedback.revision}</blockquote>}
      <h3>{example ? "示例评分" : "AI 练习参考分"}</h3>
      <dl className="speech-ratings">{(Object.keys(criteria) as (keyof typeof criteria)[]).map(key => {
        const rating = feedback.criteria[key];
        return <div key={key}><dt>{criteria[key]} <strong>{rating.band === null ? "证据不足" : rating.band.toFixed(1)}</strong></dt><dd>{rating.note}</dd></div>;
      })}</dl>
    </> : <p className="speech-meta">本次没有完整的模型反馈，可查看已确认的对话。</p>}
    <Transcript lines={record.lines} example={example} />
  </article>;
}
