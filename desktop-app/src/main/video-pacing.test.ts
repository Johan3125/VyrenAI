import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface PacingBudget {
  durationSeconds: 4 | 6 | 8;
  primary: string;
  combinedSetupAndHoldMaxSeconds: number;
}

test("compiles a duration-aware pacing lock for 4, 6, and 8-second clips", async () => {
  const pacing = await import(pathToFileURL(
    resolve(process.cwd(), "../extension-worker/video-pacing.js"),
  ).href) as {
    videoPacingBudget: (seconds: number) => PacingBudget;
    videoPacingLock: (seconds: number) => string;
  };

  assert.deepEqual(
    [4, 6, 8].map((seconds) => pacing.videoPacingBudget(seconds).durationSeconds),
    [4, 6, 8],
  );
  assert.equal(pacing.videoPacingBudget(4).combinedSetupAndHoldMaxSeconds, 0.6);
  assert.equal(pacing.videoPacingBudget(6).combinedSetupAndHoldMaxSeconds, 1.5);
  assert.equal(pacing.videoPacingBudget(8).combinedSetupAndHoldMaxSeconds, 2);

  const fourSeconds = pacing.videoPacingLock(4);
  assert.match(fourSeconds, /Primary motion must visibly occupy at least 60%/);
  assert.match(fourSeconds, /begin the primary motion immediately/);
  assert.match(fourSeconds, /primary motion about 2.5–3.5 seconds/);
  assert.match(fourSeconds, /no more than 0.6 seconds/);

  const sixSeconds = pacing.videoPacingLock(6);
  assert.match(sixSeconds, /primary motion about 3.5–4.5 seconds/);
  assert.match(sixSeconds, /no more than 1.5 seconds/);

  const eightSeconds = pacing.videoPacingLock(8);
  assert.match(eightSeconds, /primary motion about 4.5–5.5 seconds/);
  assert.match(eightSeconds, /An 8-second runtime is not permission to slow one small gesture/);
  assert.match(eightSeconds, /no more than 2 seconds/);
  assert.equal(pacing.videoPacingBudget(99).durationSeconds, 8);
});
