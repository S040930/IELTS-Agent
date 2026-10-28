import { useEffect, useMemo, useRef, useState } from "react";
import type { ActivityMode, ActivitySummary } from "../shared/domain.js";

export type Preparation = {
  activity: ActivitySummary;
  mode: ActivityMode;
  taskId?: string;
  reviewIds?: string[];
  questionIds?: string[];
};

export function ExamPreparation({ preparation, busy, onBack, onStart }: {
  preparation: Preparation;
  busy: boolean;
  onBack: () => void;
  onStart: (durations: number[]) => Promise<boolean>;
}) {
  const { activity, mode } = preparation;
  const listening = activity.pluginId === "listening";
  const mock = mode === "mock";
  const sample = useRef<HTMLAudioElement>(null);
  const [playedSample, setPlayedSample] = useState(false);
  const [soundChecked, setSoundChecked] = useState(false);
  const [durations, setDurations] = useState<number[] | null>(null);
  const [error, setError] = useState("");
  const [preflightVersion, setPreflightVersion] = useState(0);
  const sources = useMemo(() => activity.audioSections?.map((part) => part.audioUrl) ?? (activity.audioUrl ? [activity.audioUrl] : []), [activity]);
  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];
    setDurations(null);
    setError("");
    const probes = sources.map((src) => new Promise<number>((resolve, reject) => {
      const audio = new Audio();
      audio.preload = "metadata";
      const timeout = window.setTimeout(() => reject(new Error("Audio check timed out. Check your connection and retry.")), 20000);
      const readDuration = () => { if (Number.isFinite(audio.duration) && audio.duration > 0) resolve(audio.duration); };
      audio.onloadedmetadata = readDuration;
      audio.ondurationchange = readDuration;
      audio.onerror = () => reject(new Error("A recording could not be loaded. Check your connection and retry."));
      audio.src = src;
      audio.load();
      cleanups.push(() => { window.clearTimeout(timeout); audio.onloadedmetadata = null; audio.ondurationchange = null; audio.onerror = null; audio.removeAttribute("src"); audio.load(); });
    }));
    void Promise.all(probes).then((values) => { if (!cancelled) setDurations(values); })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message); })
      .finally(() => cleanups.forEach((cleanup) => cleanup()));
    return () => { cancelled = true; cleanups.forEach((cleanup) => cleanup()); };
  }, [sources, preflightVersion]);
  useEffect(() => { const audio = sample.current; return () => audio?.pause(); }, []);
  const count = preparation.questionIds?.length ?? preparation.reviewIds?.length ?? activity.questionCount;
  const ready = durations !== null && (!mock || !listening || soundChecked);
  const minutes = listening && durations ? Math.ceil((durations.reduce((sum, value) => sum + value, 0) + (mock ? 120 : 0)) / 60) : mock ? 60 : activity.minutes;

  return <div className="exam-preparation">
    <header className="exam-prep-header"><strong>IELTS <span>{mock ? "Computer mock test" : "Computer practice"}</span></strong><button type="button" onClick={onBack} disabled={busy}>Back</button></header>
    <main className="exam-prep-body">
      <h1>{listening ? "Listening" : "Academic Reading"}</h1>
      <p className="exam-prep-subtitle">{mock ? "组合模拟卷 · 由现有分段材料组合" : activity.title}</p>
      <div className="exam-prep-facts"><span><strong>{count}</strong> questions</span><span><strong>{mock ? `${minutes} minutes` : "Untimed"}</strong>{mock ? listening ? " including 2 minutes to check" : " in total" : " practice"}</span>{mock && <span><strong>{listening ? 4 : 3}</strong> {listening ? "parts" : "passages"}</span>}</div>
      <section className="exam-prep-instructions"><h2>Instructions</h2>
        <ul>
          <li>{listening ? "Listen to the recordings and answer the questions on screen." : "Read the passages and answer the questions on screen."}</li>
          <li>You can move between questions and mark questions for review.</li>
          <li>You can highlight text, make notes and adjust the text size.</li>
          {mock ? <>
            <li>{listening ? "Each recording is played ONCE only. You cannot pause, replay or skip the recording." : "You have 60 minutes for all three passages. There is no extra time to transfer answers."}</li>
            {listening && <li>After all four recordings, you have 2 minutes to check your answers.</li>}
            <li>The timer continues if you leave this tab or refresh. Your answers are submitted automatically when time is up.</li>
          </> : <li>Practice tools include audio replay, an AI tutor and a resettable elapsed timer. Answers appear after submission.</li>}
        </ul>
      </section>
      {listening && <section className="exam-sound-check"><h2>Sound check</h2><p>Put on your headphones. Play the sample and adjust the volume.</p>
        {/* preload must be applied before src, otherwise the browser starts fetching on mount. */}
        <audio ref={sample} preload="none" src="/assets/garden-workshop.wav" onPlaying={() => setPlayedSample(true)} />
        <div className="exam-sound-controls"><button type="button" onClick={() => { setError(""); void sample.current?.play().catch(() => setError("The sound sample could not be played. Please try again.")); }}>Play Sound</button><label>Volume <input type="range" aria-label="Sound check volume" min="0" max="1" step="0.05" defaultValue="1" onChange={(event) => { if (sample.current) sample.current.volume = Number(event.target.value); }} /></label></div>
        <label className="exam-sound-confirm"><input type="checkbox" checked={soundChecked} disabled={!playedSample} onChange={(event) => setSoundChecked(event.target.checked)} />I can hear the sound clearly{!mock && " (optional for practice)"}</label>
      </section>}
      <div className="exam-preflight-status" role="status">{durations !== null ? "✓ Test materials are ready" : !error ? "Checking test materials…" : "Material check needs attention"}</div>
      {error && <div className="exam-prep-error" role="alert">{error} <button type="button" onClick={() => { setError(""); setPreflightVersion((value) => value + 1); }}>Retry check</button></div>}
      <footer className="exam-prep-footer"><p>Your timer starts when you select Start test.</p><button type="button" className="exam-start-button" disabled={!ready || busy || Boolean(error)} onClick={() => { sample.current?.pause(); void onStart(durations ?? []); }}>{busy ? "Starting…" : mock ? "Start test" : "Start practice"}<span aria-hidden="true"> →</span></button></footer>
    </main>
  </div>;
}
