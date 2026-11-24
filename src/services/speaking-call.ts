import { parseFeedback, type SpeakingFeedback, type SpeakingLine, type SpeakingPart } from "../shared/speaking.js";
import { api } from "./api.js";
import { examinerInstructions, feedbackInstructions, type SpeakingTopic } from "./speaking-topics.js";

export type CallPhase = "connecting" | "preparing" | "speaking" | "reviewing";
interface Events {
  phase: (value: CallPhase) => void;
  lines: (value: SpeakingLine[]) => void;
  status: (value: string) => void;
  audio: (stream: MediaStream) => void;
  finished: (lines: SpeakingLine[], feedback: SpeakingFeedback | null, reason: string) => void;
}
interface ModelEvent {
  type: string; event_id?: string; item_id?: string; response_id?: string;
  delta?: string; text?: string; stash?: string; transcript?: string;
  response?: { id: string; status: string };
}

export class SpeakingCall {
  private peer?: RTCPeerConnection;
  private stream?: MediaStream;
  private sender?: RTCRtpSender;
  private eventsChannel?: RTCDataChannel;
  private channels = new Set<RTCDataChannel>();
  private seen = new Set<string>();
  private captions = new Map<string, SpeakingLine>();
  private confirmed = new Set<string>();
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private phase: CallPhase = "connecting";
  private configured = false;
  private muted = false;
  private learnerSpeaking = false;
  private activeResponse?: string;
  private waitingCommit = false;
  private pendingResponse = false;
  private pendingTranscripts = new Set<string>();
  private reviewStep: "idle" | "drain" | "configure" | "respond" = "idle";
  private reviewText = "";
  private reviewResponse?: string;
  private deadline = 0;

  constructor(private part: SpeakingPart, private topic: SpeakingTopic, private events: Events) {}

  private get closed() { return this.controller.signal.aborted; }

  private setPhase(phase: CallPhase) {
    this.phase = phase;
    this.events.phase(phase);
  }

  private send(type: string, data: Record<string, unknown> = {}) {
    if (this.eventsChannel?.readyState !== "open") throw new Error("实时事件通道已关闭。");
    this.eventsChannel.send(JSON.stringify({ type, event_id: crypto.randomUUID(), ...data }));
  }

  private limit(ms: number, callback: () => void) {
    clearTimeout(this.timer);
    this.deadline = Date.now() + ms;
    this.timer = setTimeout(callback, ms);
  }

  remaining(): number { return Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000)); }

  async start() {
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") throw new Error("请用支持 WebRTC 的浏览器，通过 HTTPS 或 localhost 打开口语练习。");
      this.limit(45_000, () => this.complete(null, "连接超时，请检查网络与麦克风权限后重试。"));
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true }, video: false });
      if (this.closed) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const peer = new RTCPeerConnection();
      this.peer = peer;
      this.sender = peer.addTransceiver("audio", { direction: "sendrecv" }).sender;
      peer.ontrack = ({ track }) => this.events.audio(new MediaStream([track]));
      peer.ondatachannel = ({ channel }) => this.bind(channel);
      this.bind(peer.createDataChannel("oai-events"));
      peer.onconnectionstatechange = () => {
        if (["disconnected", "failed", "closed"].includes(peer.connectionState)) this.complete(null, "通话连接中断。");
        else this.initialize();
      };
      await peer.setLocalDescription(await peer.createOffer());
      if (peer.iceGatheringState !== "complete") {
        await new Promise<void>((resolve, reject) => {
          const cancel = () => reject(new Error("连接已取消。"));
          if (this.closed) return cancel();
          this.controller.signal.addEventListener("abort", cancel, { once: true });
          peer.onicegatheringstatechange = () => {
            if (peer.iceGatheringState !== "complete") return;
            this.controller.signal.removeEventListener("abort", cancel);
            peer.onicegatheringstatechange = null;
            resolve();
          };
        });
      }
      const answer = await api.speakingOffer(peer.localDescription!.sdp, this.controller.signal);
      if (!this.closed) await peer.setRemoteDescription({ type: "answer", sdp: answer.trim().replace(/\r?\n/g, "\r\n") + "\r\n" });
    } catch (error) {
      const reason = error instanceof Error ? error : new Error("无法开始语音练习。");
      const message = reason.name === "NotAllowedError" ? "麦克风权限被拒绝，请在浏览器中允许后重试。"
        : reason.name === "NotFoundError" ? "未找到麦克风，请连接设备后重试。" : reason.message;
      this.complete(null, message);
    }
  }

  private bind(channel: RTCDataChannel) {
    this.channels.add(channel);
    channel.onopen = () => this.initialize();
    channel.onclose = () => { if (channel === this.eventsChannel) this.complete(null, "实时事件通道已关闭。"); };
    channel.onmessage = ({ data }) => {
      if (this.closed) return;
      let event: ModelEvent;
      try { event = JSON.parse(data); } catch { return; }
      if (!event?.type || (event.event_id && this.seen.has(event.event_id))) return;
      if (event.event_id) this.seen.add(event.event_id);
      try {
        if (event.type === "session.created") {
          this.eventsChannel = channel;
          this.initialize();
        } else this.receive(event);
      } catch { this.complete(null, "实时事件处理失败，请重新开始练习。"); }
    };
  }

  private initialize() {
    if (this.closed || this.configured || this.peer?.connectionState !== "connected" || this.eventsChannel?.readyState !== "open") return;
    this.configured = true;
    this.send("session.update", { session: {
      modalities: ["text", "audio"], instructions: examinerInstructions(this.part, this.topic),
      input_audio_transcription: { model: "qwen3-asr-flash-realtime" },
      turn_detection: this.part === 2 ? null : { type: "server_vad", silence_duration_ms: 900 },
    } });
  }

  private receive(event: ModelEvent) {
    const type = event.type;
    if (type === "error") { this.complete(null, "实时模型未能完成本次请求。"); return; }
    if (type === "session.updated") {
      if (this.reviewStep === "configure") {
        this.reviewStep = "respond";
        this.send("conversation.item.create", { item: { type: "message", role: "user", content: [{ type: "input_text", text: "Give the written review. Quote only from these ASR transcripts of the learner: " + JSON.stringify([...this.captions.values()].filter(line => line.role === "learner" && this.confirmed.has(line.id)).map(line => line.text)) }] } });
        this.send("response.create");
      } else if (this.phase === "connecting" && this.configured) {
        clearTimeout(this.timer);
        if (this.part === 2) {
          this.setPhase("preparing");
          this.limit(60_000, () => void this.beginSpeaking());
        } else void this.beginSpeaking();
      }
      return;
    }
    if (type === "input_audio_buffer.speech_started") {
      this.learnerSpeaking = true;
      if (this.phase === "speaking") this.events.status("正在听你说");
    }
    if (type === "input_audio_buffer.speech_stopped") this.learnerSpeaking = false;
    if (type === "input_audio_buffer.committed") {
      this.waitingCommit = false;
      if (event.item_id && !this.confirmed.has(event.item_id)) this.pendingTranscripts.add(event.item_id);
      if (this.part !== 2 && this.reviewStep !== "respond") this.pendingResponse = true;
      this.configureReviewWhenReady();
    }
    if (type === "response.created") {
      this.pendingResponse = false;
      this.activeResponse = event.response?.id;
      if (this.reviewStep === "drain") this.send("response.cancel");
      if (this.reviewStep === "respond") this.reviewResponse = this.activeResponse;
    }
    this.caption(event);
    if (event.item_id && (type === "conversation.item.input_audio_transcription.completed" || type === "conversation.item.input_audio_transcription.failed")) {
      this.pendingTranscripts.delete(event.item_id);
      this.configureReviewWhenReady();
    }
    if (type === "response.text.done" && this.reviewStep === "respond" && event.response_id === this.reviewResponse) {
      this.reviewText = event.text ?? "";
    }
    if (type !== "response.done") return;
    if (this.activeResponse === event.response?.id) this.activeResponse = undefined;
    if (this.reviewStep === "respond" && this.reviewResponse && this.reviewResponse === event.response?.id) {
      let feedback: SpeakingFeedback | null = null;
      if (event.response.status === "completed") {
        try { feedback = parseFeedback(JSON.parse(this.reviewText.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi, ""))); } catch { /* Preserve the transcript if the model returns incomplete JSON. */ }
      }
      this.complete(feedback, feedback ? "" : "模型未返回完整反馈。");
    } else if (this.phase === "speaking") this.events.status("轮到你了");
    else this.configureReviewWhenReady();
  }

  private caption(event: ModelEvent) {
    const id = event.item_id;
    if (!id || this.confirmed.has(id)) return;
    const learner = event.type.startsWith("conversation.item.input_audio_transcription.");
    const examiner = event.type.startsWith("response.audio_transcript.");
    if (!learner && !examiner) return;
    let text: string;
    if (event.type.endsWith(".delta")) {
      text = learner ? (event.text ?? "") + (event.stash ?? "") : (this.captions.get(id)?.text ?? "") + (event.delta ?? "");
    } else if (event.type.endsWith(".completed") || event.type.endsWith(".done")) {
      text = event.transcript ?? "";
      this.confirmed.add(id);
    } else return;
    this.captions.set(id, { id, role: learner ? "learner" : "examiner", text });
    this.events.lines([...this.captions.values()]);
    if (examiner && this.phase === "speaking") this.events.status("考官提问中");
  }

  async beginSpeaking() {
    if (this.closed || (this.phase !== "preparing" && this.phase !== "connecting")) return;
    this.setPhase("speaking");
    clearTimeout(this.timer);
    try {
      const track = this.stream!.getAudioTracks()[0];
      track.enabled = !this.muted;
      await this.sender!.replaceTrack(track);
      if (this.closed || this.reviewStep !== "idle") return;
      if (this.part === 2) this.limit(120_000, () => this.finish());
      else {
        this.send("conversation.item.create", { item: { type: "message", role: "user", content: [{ type: "input_text", text: "Start the speaking interview. Ask the opening question now." }] } });
        this.pendingResponse = true;
        this.send("response.create");
      }
      this.events.status(this.part === 2 ? "正在听你陈述" : "等待考官提问");
    } catch { this.complete(null, "无法开启麦克风音轨。"); }
  }

  mute(value: boolean) {
    this.muted = value;
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !value;
  }

  async level(): Promise<number> {
    if (!this.peer || this.closed || this.phase !== "speaking") return 0;
    const stats = await this.peer.getStats();
    let volume = 0;
    stats.forEach(entry => {
      if (entry.kind === "audio" && (entry.type === "inbound-rtp" || (!this.muted && entry.type === "media-source"))) {
        volume = Math.max(volume, Number(entry.audioLevel) || 0);
      }
    });
    return Math.min(1, volume * 4);
  }

  finish() {
    if (this.closed || this.phase === "reviewing") return;
    if (this.phase !== "speaking") { this.complete(null, ""); return; }
    this.setPhase("reviewing");
    this.reviewStep = "drain";
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.limit(30_000, () => this.complete(null, "反馈生成超时。"));
    try {
      if (this.part === 2 || this.learnerSpeaking) {
        this.waitingCommit = true;
        if (this.part === 2) this.send("input_audio_buffer.commit");
      }
      if (this.activeResponse) this.send("response.cancel");
      this.configureReviewWhenReady();
    } catch { this.complete(null, "未能连接到模型生成反馈。"); }
  }

  private configureReviewWhenReady() {
    if (this.reviewStep !== "drain" || this.activeResponse || this.pendingResponse || this.waitingCommit || this.pendingTranscripts.size) return;
    this.reviewStep = "configure";
    this.send("session.update", { session: { modalities: ["text"], turn_detection: null, instructions: feedbackInstructions } });
  }

  private complete(feedback: SpeakingFeedback | null, reason: string) {
    if (this.closed) return;
    const lines = [...this.captions.values()].filter(line => this.confirmed.has(line.id) && line.text.trim());
    if (feedback) {
      const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const quote = words(feedback.quote);
      const sample = lines.filter(line => line.role === "learner");
      if (!quote || !sample.some(line => (" " + words(line.text) + " ").includes(" " + quote + " "))) {
        feedback.quote = "";
        feedback.revision = "";
      }
      if (!sample.length) feedback = null;
    }
    this.close();
    this.events.finished(lines, feedback, reason);
  }

  interrupt() { this.complete(null, "练习已中断。"); }

  private close() {
    if (this.closed) return;
    this.controller.abort();
    clearTimeout(this.timer);
    this.stream?.getTracks().forEach(track => track.stop());
    this.peer?.getReceivers().forEach(receiver => receiver.track?.stop());
    for (const channel of this.channels) channel.close();
    this.peer?.close();
  }
}
