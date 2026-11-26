import { useEffect, useRef, useState } from "react";
import { demos } from "../services/speaking-demo.js";
import type { SpeakingTopic } from "../services/speaking-topics.js";
import type { SpeakingPart, SpeakingRecord } from "../shared/speaking.js";
import { SpeakingReview } from "./SpeakingReview.js";
import { Icon } from "./Icon.js";

interface Props { part: SpeakingPart; topic: SpeakingTopic; onExit: () => void }

export function SpeakingDemo({ part, topic, onExit }: Props) {
  const [run, setRun] = useState(0);
  return <DemoPlayer key={run} part={part} topic={topic} onExit={onExit} onReplay={() => setRun(n => n + 1)} />;
}

function DemoPlayer({ part, topic, onExit, onReplay }: Props & { onReplay: () => void }) {
  const script = demos[topic.demo];
  const turns = script.turns;
  const last = turns[turns.length - 1];
  const duration = last.end + 2;
  const player = useRef<HTMLAudioElement>(null);
  const position = useRef(0);
  const [seconds, setSeconds] = useState(0);
  const [paused, setPaused] = useState(false);
  const [quiet, setQuiet] = useState(false);
  const complete = seconds >= duration;
  const [reduceMotion, setReduceMotion] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);

  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduceMotion(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);

  // Keep the visual demonstration running even when a browser blocks playback.
  useEffect(() => {
    const audio = player.current;
    if (!audio || paused || complete) return;
    const origin = performance.now() - position.current * 1000;
    let active = true;
    const synchronize = () => { audio.currentTime = position.current; };
    audio.addEventListener("playing", synchronize, { once: true });
    void audio.play().catch(() => { if (active) setQuiet(true); });
    const tick = window.setInterval(() => {
      position.current = Math.min(duration, (performance.now() - origin) / 1000);
      setSeconds(position.current);
    }, 90);
    return () => {
      active = false;
      window.clearInterval(tick);
      audio.removeEventListener("playing", synchronize);
      audio.pause();
    };
  }, [duration, paused, complete]);

  function toggleSound() {
    const audio = player.current;
    if (!audio) return;
    setQuiet(!quiet);
    if (quiet && !paused) {
      audio.currentTime = position.current;
      void audio.play().catch(() => setQuiet(true));
    }
  }

  const first = turns[0];
  const connecting = seconds < first.start;
  const preparing = part === 2 && seconds >= first.end && seconds < turns[1].start;
  const reviewing = seconds >= last.end;
  const current = turns.filter(turn => turn.start <= seconds).at(-1);
  const role = current?.role === "learner" ? "示例学生" : "考官";
  const status = connecting ? "正在连接考官" : preparing ? "准备陈述" : reviewing ? "正在整理示例反馈" : role + (current?.role === "learner" ? "回答中" : "提问中");
  const stage = connecting ? 0 : reviewing ? 2 : 1;
  const words = current?.text.split(" ") ?? [];
  const progress = current ? Math.min(1, (seconds - current.start) / (current.end - current.start)) : 0;
  const caption = reduceMotion ? current?.text : words.slice(0, Math.max(1, Math.ceil(progress * words.length))).join(" ");
  const talking = current && seconds < current.end && !reviewing && !connecting;
  const level = talking ? .3 + .7 * Math.abs(Math.sin(seconds * 9) * Math.cos(seconds * 3)) : 0;
  const sample = part === 2 ? turns[1].text.split(". ")[0] + "." : turns[1].text;
  const example: Pick<SpeakingRecord, "part" | "topic" | "feedback" | "lines"> = {
    part, topic: topic.title, lines: turns.map((turn, i) => ({ id: String(i), role: turn.role, text: turn.text })),
    feedback: { advice: script.advice, quote: sample, revision: script.revision, criteria: {
      fluency: { band: 6.5, note: part === 2 ? "陈述有先后顺序，可以用一句话收束感受。" : "能接住提问，并用具体细节继续展开。" },
      vocabulary: { band: 6.5, note: "用词贴合话题，可以再尝试一种表达。" },
      grammar: { band: 6, note: "主要意思清晰，可以把相关的短句连起来。" },
      pronunciation: { band: null, note: "演示使用合成语音，发音留待真人练习时评估。" },
    } },
  };

  return <section className="page-content speech-page">
    <header className="page-title-row"><div><p className="page-eyebrow">Speaking · Demo</p><h1>{complete ? "示例复盘" : "口语演示"}</h1>
      <p className="page-subtitle">本地示例 · 无需麦克风，演示结果不计入练习记录。</p></div></header>
    <audio ref={player} src={"/assets/speaking-demo/" + topic.demo + ".mp3"} preload="auto" muted={quiet} />
    {complete ? <>
      <SpeakingReview record={example} example />
      <div className="speech-actions"><button className="button button-primary" onClick={onReplay}><Icon name="refresh" />再看一次</button>
        <button className="button button-outline" onClick={onExit}>返回口语练习</button></div>
    </> : <article className="speech-panel speech-demo">
      <div className="speech-heading"><div><p className="speech-meta">Part {part}</p><h2>{topic.title}</h2></div>
        <button className="speech-link" onClick={onExit}>退出演示</button></div>
      <ol className="demo-stages">{["连接", part === 2 ? "个人陈述" : "问答", "复盘"].map((name, i) =>
        <li key={name} aria-current={i === stage ? "step" : undefined} className={i <= stage ? "reached" : ""}>{name}</li>)}</ol>
      <div className="speech-signal" data-speaker={talking ? current.role : undefined}>
        <div className="speech-wave" aria-hidden="true">{[.45,.75,1,.8,.5].map(weight =>
          <i key={weight} style={{ transform: "scaleY(" + (.14 + level * weight) + ")" }} />)}</div>
        <span role="status">{paused ? "演示已暂停" : status}</span>
      </div>
      {preparing ? <div className="demo-caption"><strong>题卡 · 演示准备 {Math.ceil(turns[1].start - seconds)} 秒</strong>
        <p lang="en">{topic.prompt}</p><ul lang="en">{topic.cues?.map(cue => <li key={cue}>{cue}</li>)}</ul></div>
      : <div className="demo-caption" key={current?.start ?? "opening"}><strong>{connecting ? "本次题目" : reviewing ? "本次回答" : role}</strong>
        <p lang="en">{connecting ? topic.prompt : caption}</p></div>}
      <progress aria-label="演示进度" className="demo-progress" max={duration} value={seconds} />
      <div className="speech-actions"><button className="button button-outline" onClick={() => setPaused(value => !value)}>{paused ? "继续演示" : "暂停演示"}</button>
        <button className="button button-outline" aria-pressed={!quiet} onClick={toggleSound}><Icon name="volume" />{quiet ? "打开声音" : "静音"}</button></div>
    </article>}
  </section>;
}
