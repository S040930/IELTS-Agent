import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { demos } from "../src/services/speaking-demo.js";
import { parts } from "../src/services/speaking-topics.js";

test("each selectable topic has local audio and timed captions for its own dialogue", () => {
  for (const [part, { topics }] of Object.entries(parts)) {
    for (const topic of topics) {
      const demo = demos[topic.demo];
      const audio = readFileSync(new URL("../public/assets/speaking-demo/" + topic.demo + ".mp3", import.meta.url));
      assert.ok(audio.length > 1000);
      assert.equal(demo.turns[0].text, topic.prompt);
      let end = 0;
      for (const [index, turn] of demo.turns.entries()) {
        assert.ok(turn.start >= end && turn.end > turn.start);
        assert.equal(turn.role, index % 2 ? "learner" : "examiner");
        end = turn.end;
      }
      if (part === "2") assert.ok(demo.turns[1].start - demo.turns[0].end >= 3.9);
      else assert.equal(demo.turns.length, 4);
    }
  }
});
