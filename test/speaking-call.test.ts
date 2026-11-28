import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "../src/services/api.js";
import { SpeakingCall, type CallPhase } from "../src/services/speaking-call.js";
import type { SpeakingLine } from "../src/shared/speaking.js";
import { parts } from "../src/services/speaking-topics.js";

class Channel {
  readyState = "open";
  sent: { type: string; session?: { turn_detection: unknown; modalities: string[] } }[] = [];
  onmessage?: (event: { data: string }) => void;
  send(json: string) { this.sent.push(JSON.parse(json)); }
  emit(type: string, props = {}) { this.onmessage?.({ data: JSON.stringify({ type, ...props }) }); }
  close() { this.readyState = "closed"; }
}

test("manual Part 2 waits for initialization and learner submission, then reviews the same audio session", async t => {
  const local = new Channel(), remote = new Channel();
  let attached = false, stopped = false, closed = false;
  const track = { enabled: true, stop() { stopped = true; } };
  class Peer {
    connectionState = "connected";
    iceGatheringState = "complete";
    localDescription = { sdp: "offer" };
    ondatachannel?: (event: { channel: Channel }) => void;
    createDataChannel() { return local; }
    addTransceiver() { return { sender: { async replaceTrack() { attached = true; } } }; }
    async createOffer() { return this.localDescription; }
    async setLocalDescription() {}
    async setRemoteDescription() { this.ondatachannel?.({ channel: remote }); }
    getReceivers() { return []; }
    close() { closed = true; }
  }
  Object.defineProperty(globalThis, "RTCPeerConnection", { value: Peer, configurable: true });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    async getUserMedia() { return { getTracks: () => [track], getAudioTracks: () => [track] }; },
  } });
  t.mock.method(api, "speakingOffer", async () => ({ answer: "answer", callId: "test-call" }));
  const report = t.mock.method(api, "reportSpeakingUsage", async () => {});
  let phase: CallPhase = "connecting";
  let lines: SpeakingLine[] = [];
  let result: unknown;
  const call = new SpeakingCall(2, parts[2].topics[0], {
    phase: value => { phase = value; }, status() {}, audio() {}, lines: value => { lines = value; },
    finished: (final, feedback, reason) => { result = { final, feedback, reason }; },
  });
  try {
    await call.start();
    remote.emit("session.created");
    assert.equal(remote.sent[0].session?.turn_detection, null);
    assert.equal(attached, false);
    remote.emit("session.updated");
    assert.equal(phase, "preparing");
    assert.equal(attached, false);
    await call.beginSpeaking();
    assert.ok(attached);
    call.mute(true); assert.equal(track.enabled, false);
    call.mute(false); assert.equal(track.enabled, true);
    remote.emit("conversation.item.input_audio_transcription.delta", { item_id: "a", text: "A", stash: " park" });
    remote.emit("input_audio_buffer.speech_stopped");
    assert.deepEqual(remote.sent.map(event => event.type), ["session.update"]);
    call.finish();
    assert.ok(stopped);
    assert.equal(remote.sent.at(-1)?.type, "input_audio_buffer.commit");
    remote.emit("input_audio_buffer.committed", { item_id: "a" });
    assert.equal(remote.sent.at(-1)?.type, "input_audio_buffer.commit");
    remote.emit("conversation.item.input_audio_transcription.completed", { item_id: "a", transcript: "A park." });
    assert.deepEqual(lines, [{ id: "a", role: "learner", text: "A park." }]);
    assert.deepEqual(remote.sent.at(-1)?.session?.modalities, ["text"]);
    remote.emit("session.updated");
    assert.equal(remote.sent.at(-1)?.type, "response.create");
    remote.emit("response.created", { response: { id: "review" } });
    const rating = { band: null, note: "回答太短。" };
    const feedback = { advice: "用一个例子展开。", quote: "A park.", revision: "It is a park.", criteria: {
      fluency: rating, vocabulary: rating, grammar: rating, pronunciation: rating,
    } };
    remote.emit("response.text.done", { response_id: "review", text: JSON.stringify(feedback) });
    const usage = { input_tokens: 42, output_tokens: 17 };
    remote.emit("response.done", { response: { id: "review", status: "completed", usage } });
    assert.deepEqual(report.mock.calls.map((call) => call.arguments), [["test-call", "review", usage]]);
    assert.deepEqual(result, { final: lines, feedback, reason: "" });
    assert.ok(closed);
    assert.equal(remote.readyState, "closed");
  } finally {
    call.interrupt();
    Reflect.deleteProperty(globalThis, "RTCPeerConnection");
    Reflect.deleteProperty(navigator, "mediaDevices");
  }
});
