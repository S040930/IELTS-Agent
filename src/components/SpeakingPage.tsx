import "./speaking.css";
import { useEffect, useRef, useState } from "react";
import { api } from "../services/api.js";
import { SpeakingCall, type CallPhase } from "../services/speaking-call.js";
import { parts } from "../services/speaking-topics.js";
import type { SpeakingLine, SpeakingPart, SpeakingRecord, SpeakingSummary } from "../shared/speaking.js";
import { SpeakingDemo } from "./SpeakingDemo.js";
import { SpeakingReview, Transcript, dateLabel } from "./SpeakingReview.js";
import { Icon } from "./Icon.js";

const message = (error: unknown) => error instanceof Error ? error.message : "请求失败，请重试。";
const phaseLabel: Record<CallPhase, string> = {
  connecting: "正在连接", preparing: "准备陈述", speaking: "通话中", reviewing: "正在生成复盘",
};
export function SpeakingPage() {
  const [demo, setDemo] = useState(false);
  const [part, setPart] = useState<SpeakingPart>(1);
  const [topicIndex, setTopicIndex] = useState(0);
  const topic = parts[part].topics[topicIndex];
  const [sessions, setSessions] = useState<SpeakingSummary[]>([]);
  const [configuration, setConfiguration] = useState<string | null>("正在检查口语服务…");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [record, setRecord] = useState<SpeakingRecord>();
  const [saving, setSaving] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<CallPhase>();
  const [status, setStatus] = useState("");
  const [lines, setLines] = useState<SpeakingLine[]>([]);
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [needsPlay, setNeedsPlay] = useState(false);
  const call = useRef<SpeakingCall | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const mounted = useRef(false);
  const selection = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      selection.current++;
      call.current?.interrupt();
      call.current = null;
    };
  }, []);
  useEffect(() => {
    let active = true;
    api.speakingHistory().then(value => {
      if (active) { setSessions(value.sessions); setConfiguration(value.configurationError); }
    }).catch(reason => { if (active) setConfiguration(message(reason)); });
    return () => { active = false; };
  }, [loadAttempt]);
  useEffect(() => {
    if (!phase) return;
    let active = true;
    const tick = () => {
      const current = call.current;
      if (!current) return;
      setSeconds(current.remaining());
      void current.level().then(value => { if (active) setLevel(value); }).catch(() => {});
    };
    tick();
    const timer = window.setInterval(tick, 160);
    return () => { active = false; window.clearInterval(timer); };
  }, [phase]);

  async function save(value: SpeakingRecord) {
    if (mounted.current) { setSaving(true); setUnsaved(false); }
    try {
      await api.saveSpeaking(value);
      if (mounted.current) setSessions(previous => [value, ...previous.filter(item => item.id !== value.id)]);
    } catch (reason) {
      if (mounted.current) { setError(message(reason)); setUnsaved(true); }
    } finally { if (mounted.current) setSaving(false); }
  }

  async function playAudio() {
    const player = audio.current;
    if (!player?.srcObject) return;
    try { await player.play(); if (mounted.current) setNeedsPlay(false); }
    catch { if (mounted.current) setNeedsPlay(true); }
  }

  function start() {
    if (call.current || configuration) return;
    const id = crypto.randomUUID();
    selection.current++;
    setError(""); setLines([]); setStatus(""); setMuted(false); setNeedsPlay(false);
    setRecord(undefined); setPhase("connecting");
    const session = new SpeakingCall(part, topic, {
      phase: setPhase, status: setStatus, lines: setLines,
      audio(stream) {
        if (audio.current) { audio.current.srcObject = stream; void playAudio(); }
      },
      finished(transcript, feedback, reason) {
        call.current = null;
        if (mounted.current) {
          setPhase(undefined); setError(reason); setLevel(0);
          if (audio.current) { audio.current.pause(); audio.current.srcObject = null; }
        }
        if (!transcript.length && !feedback) return;
        const result: SpeakingRecord = { id, part, topic: topic.title, endedAt: new Date().toISOString(), lines: transcript, feedback };
        if (mounted.current) setRecord(result);
        void save(result);
      },
    });
    call.current = session;
    void session.start();
  }

  async function openRecord(id: string) {
    const version = ++selection.current;
    try {
      const result = await api.speakingRecord(id);
      if (version === selection.current) { setRecord(result); setError(""); }
    } catch (reason) { if (version === selection.current) setError(message(reason)); }
  }

  const question = [...lines].reverse().find(line => line.role === "examiner")?.text || topic.prompt;
  const timed = phase === "preparing" || (part === 2 && phase === "speaking");
  if (demo) return <SpeakingDemo part={part} topic={topic} onExit={() => setDemo(false)} />;
  return <section className="page-content speech-page">
    <header className="page-title-row"><div><p className="page-eyebrow">Speaking</p><h1>{record ? "口语复盘" : "口语练习"}</h1>
      <p className="page-subtitle">{record ? "回看这次练习和考官反馈。" : "与 AI 考官用英语对话，练完回看自己的表达。"}</p></div></header>
    <audio ref={audio} autoPlay />
    {error && <p className="speech-notice" role="alert">{error}</p>}
    {record ? <>
      <SpeakingReview record={record} />
      <div className="speech-actions">
        {unsaved && <button className="button button-primary" onClick={() => void save(record)}>重试保存</button>}
        <button className="button button-outline" disabled={saving || unsaved} onClick={() => { setRecord(undefined); setError(""); }}>返回口语练习</button>
        {saving && <span role="status">正在保存…</span>}
      </div>
    </> : <>
      {!phase && <div className="speech-segments" aria-label="口语考试分段">{([1, 2, 3] as const).map(value =>
        <button key={value} aria-pressed={part === value} onClick={() => { setPart(value); setTopicIndex(0); }}>Part {value}<span>{parts[value].title}</span></button>)}</div>}
      <article className="speech-panel speech-studio">
        <div className="speech-heading"><div><p className="speech-meta">Part {part} · {parts[part].title}</p><h2>{topic.title}</h2></div>
          {timed && <span className="speech-clock">{phase === "preparing" ? "准备" : "陈述"} {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>}</div>
        <p className="speech-question" lang="en">{!phase || part === 2 ? topic.prompt : question}</p>
        {topic.cues && <ul lang="en" className="speech-cues">{topic.cues.map(cue => <li key={cue}>{cue}</li>)}</ul>}
        {!phase ? <>
          <label className="speech-topic">练习话题<select value={topicIndex} onChange={event => setTopicIndex(Number(event.target.value))}>
            {parts[part].topics.map((entry, index) => <option key={entry.title} value={index}>{entry.title}</option>)}</select></label>
          <p className="speech-meta">{part === 2 && "准备 1 分钟，陈述最多 2 分钟。"}开始后将使用麦克风与百炼通话。文字复盘保存在你的账号下。</p>
          <div className="speech-actions"><button className={"button " + (configuration ? "button-outline" : "button-primary")} disabled={!!configuration} onClick={start}><Icon name="mic" size={18} />开始练习</button>
          <button className={"button " + (configuration ? "button-primary" : "button-outline")} onClick={() => { selection.current++; setError(""); setDemo(true); }}><Icon name="play" size={16} />播放口语演示</button>
          {configuration && <span className="speech-config" role="status">{configuration} <button className="speech-link" onClick={() => setLoadAttempt(n => n + 1)}>重新检查</button></span>}</div>
        </> : <>
          <div className="speech-signal"><div className="speech-wave" aria-hidden="true">
            {[0.35, 0.65, 1, 0.8, 0.5].map(n => <i key={n} style={{ transform: "scaleY(" + (0.14 + level * n) + ")" }} />)}</div>
            <span role="status">{phase === "speaking" ? (muted ? "麦克风已静音" : status || phaseLabel[phase]) : phaseLabel[phase]}</span></div>
          <div className="speech-actions">
            {phase === "preparing" && <button className="button button-primary" onClick={() => void call.current?.beginSpeaking()}>提前开始陈述</button>}
            {phase === "speaking" && <button className="button button-outline" aria-pressed={muted} onClick={() => { call.current?.mute(!muted); setMuted(!muted); }}>{muted ? "取消静音" : "静音"}</button>}
            {needsPlay && <button className="button button-outline" onClick={() => void playAudio()}>播放考官声音</button>}
            <button className="button button-outline" disabled={phase === "reviewing"} onClick={() => call.current?.finish()}>{phase === "connecting" || phase === "preparing" ? "取消练习" : "结束并复盘"}</button>
          </div>
          <Transcript lines={lines} />
        </>}
      </article>
      {!phase && <section className="speech-history"><h2>最近练习</h2>{sessions.length ? <ul>{sessions.map(item =>
        <li key={item.id}><button onClick={() => void openRecord(item.id)}><span>Part {item.part} · {item.topic}</span><small>{dateLabel(item.endedAt)}</small><Icon name="arrow" size={16} /></button></li>
      )}</ul> : <p className="speech-meta">完成一次口语练习后，可以在这里回看。</p>}</section>}
    </>}
  </section>;
}
