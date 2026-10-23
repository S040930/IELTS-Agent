export function listeningPosition(startedAt, durations, now = Date.now()) {
  let offset = Math.max(0, (now - Date.parse(startedAt)) / 1000);
  for (let index = 0; index < durations.length; index++) {
    if (offset < durations[index]) return { index, offset, checking: false, remaining: 0 };
    offset -= durations[index];
  }
  return { index: durations.length, offset: 0, checking: true, remaining: Math.max(0, Math.ceil(120 - offset)) };
}

// The wall clock owns playback. Browsing questions never changes the recording.
export function mountMockAudio(root, activity, draft, onInterrupted, now = Date.now) {
  const audio = root.querySelector("[data-audio]");
  if (!(audio instanceof HTMLAudioElement)) return () => {};
  const sources = activity.audioSections ?? [];
  const durations = draft.examTiming?.audioDurationsSeconds ?? [];
  const status = root.querySelector("[data-playback-status]");
  const retry = root.querySelector("[data-audio-retry]");
  const volume = root.querySelector("[data-audio-vol]");
  const listeners = [];
  const add = (node, type, fn) => {
    node?.addEventListener(type, fn);
    listeners.push(() => node?.removeEventListener(type, fn));
  };
  let active = -1;
  let blocked = false;
  let pending = false;
  let disposed = false;
  const preload = new Audio();
  preload.preload = "auto";
  const interrupted = (reason) => {
    if (disposed || blocked) return;
    blocked = true;
    if (retry) retry.hidden = false;
    if (status) status.textContent = "Audio interrupted. Resume to continue at the current test position.";
    onInterrupted?.(reason);
  };
  const sync = () => {
    if (disposed) return;
    const position = listeningPosition(draft.startedAt, durations, now());
    if (position.checking) {
      audio.pause();
      if (retry) retry.hidden = true;
      if (status) status.textContent = position.remaining > 0
        ? `Check your answers · ${Math.floor(position.remaining / 60)}:${String(position.remaining % 60).padStart(2, "0")} remaining`
        : "Listening test finished";
      return;
    }
    if (active !== position.index) {
      active = position.index;
      blocked = false;
      audio.src = sources[active].audioUrl;
      audio.load();
      if (sources[active + 1]) { preload.src = sources[active + 1].audioUrl; preload.load(); }
      else { preload.removeAttribute("src"); preload.load(); }
    }
    if (blocked) return;
    if (status) status.textContent = `Recording ${active + 1} of ${sources.length} · Played once only`;
    if (audio.readyState < 1) return;
    if (Math.abs(audio.currentTime - position.offset) > 1) audio.currentTime = position.offset;
    if (audio.ended && position.offset >= audio.duration - 0.8) return;
    if (audio.paused && !pending) {
      pending = true;
      const playingIndex = active;
      void audio.play().then(() => { if (retry) retry.hidden = true; })
        .catch(() => { if (active === playingIndex) interrupted("模考音频未能播放，需要恢复音频"); })
        .finally(() => { pending = false; });
    }
  };
  add(audio, "loadedmetadata", sync);
  add(audio, "playing", sync);
  add(audio, "ended", sync);
  add(audio, "pause", () => {
    if (!audio.ended && audio.readyState >= 2 && !pending && !listeningPosition(draft.startedAt, durations, now()).checking) interrupted("模考音频意外暂停");
  });
  add(audio, "error", () => interrupted("模考音频加载失败"));
  add(audio, "waiting", () => { if (status) status.textContent = "Buffering audio… The test timer continues."; });
  add(retry, "click", () => {
    blocked = false;
    if (audio.error) audio.load();
    sync();
  });
  add(volume, "input", () => { audio.volume = Number(volume.value); });
  add(document, "visibilitychange", sync);
  const timer = window.setInterval(sync, 500);
  sync();
  return () => {
    disposed = true;
    window.clearInterval(timer);
    listeners.forEach((remove) => remove());
    for (const media of [audio, preload]) { media.pause(); media.removeAttribute("src"); media.load(); }
  };
}
