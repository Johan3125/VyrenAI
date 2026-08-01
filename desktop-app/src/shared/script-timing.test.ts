import assert from "node:assert/strict";
import test from "node:test";
import { buildScriptTimingPlan } from "./script-timing";

test("buildScriptTimingPlan creates a continuous valid SRT timeline", () => {
  const result = buildScriptTimingPlan(
    "# Mở đầu\n\nMột cô gái bước vào căn phòng tối. Cô bật đèn và nhìn thấy chiếc hộp trên bàn.",
  );
  assert.ok(result.cues.length >= 2);
  assert.match(result.srtText, /00:00:00,000 --> 00:00:0[468],000/);
  assert.equal(result.cues[0].startSeconds, 0);
  for (let index = 1; index < result.cues.length; index += 1) {
    assert.equal(result.cues[index].startSeconds, result.cues[index - 1].endSeconds);
  }
  assert.ok(result.cues.every((cue) => [4, 6, 8].includes(cue.durationSeconds)));
});

test("buildScriptTimingPlan strips common markdown and splits long passages", () => {
  const result = buildScriptTimingPlan(
    `## Cảnh 1\n- ${Array.from({ length: 55 }, (_, index) => `từ${index + 1}`).join(" ")}`,
    "quick",
  );
  assert.ok(result.cues.length >= 3);
  assert.ok(!result.srtText.includes("##"));
  assert.ok(!result.srtText.includes("\n- "));
});

test("cinematic pacing is not shorter than quick pacing", () => {
  const text = "Nhân vật đi qua hành lang, dừng trước cánh cửa và chậm rãi đặt tay lên tay nắm.";
  assert.ok(
    buildScriptTimingPlan(text, "cinematic").durationSeconds >=
      buildScriptTimingPlan(text, "quick").durationSeconds,
  );
});

test("empty scripts are rejected", () => {
  assert.throws(() => buildScriptTimingPlan(" \n "), /không được để trống/);
});
