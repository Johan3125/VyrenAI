const PACING_BUDGETS = Object.freeze({
  4: Object.freeze({
    durationSeconds: 4,
    anticipation: "omit it, or use no more than 0.3 seconds only when physically necessary",
    primary: "about 2.5–3.5 seconds",
    reaction: "brief and overlapping the primary motion",
    followThrough: "omit it, or use no more than 0.3 seconds",
    combinedSetupAndHoldMaxSeconds: 0.6,
  }),
  6: Object.freeze({
    durationSeconds: 6,
    anticipation: "optional and no more than 1.0 second",
    primary: "about 3.5–4.5 seconds",
    reaction: "brief and immediate",
    followThrough: "optional and no more than 1.0 second",
    combinedSetupAndHoldMaxSeconds: 1.5,
  }),
  8: Object.freeze({
    durationSeconds: 8,
    anticipation: "no more than 1.5 seconds and only when the story beat needs it",
    primary: "about 4.5–5.5 seconds",
    reaction: "visible and immediate",
    followThrough: "no more than 1.5 seconds and only when the story beat needs it",
    combinedSetupAndHoldMaxSeconds: 2,
  }),
});

export function videoPacingBudget(durationSeconds) {
  return PACING_BUDGETS[[4, 6, 8].includes(Number(durationSeconds))
    ? Number(durationSeconds)
    : 8];
}

export function videoPacingLock(durationSeconds) {
  const budget = videoPacingBudget(durationSeconds);
  const fourSecondRule = budget.durationSeconds === 4
    ? "For this 4-second clip, begin the primary motion immediately. Do not add a separate anticipation beat or a final hold unless essential for physical continuity."
    : "Keep any anticipation and final settle subordinate to the visible story action.";
  const eightSecondRule = budget.durationSeconds === 8
    ? "An 8-second runtime is not permission to slow one small gesture. Use extended anticipation or settle only for a source-supported emotional beat or establishing shot."
    : "Do not stretch a small gesture merely to fill the runtime.";

  return [
    "PACING LOCK — HIGH PRIORITY:",
    "Character and camera motion must read at natural real-world speed, like ordinary daylight footage—never slow-motion, floaty, suspended, or dreamlike unless the scene explicitly requires a deliberate emotional beat.",
    "Spend the majority of the clip on the primary visible motion. Primary motion must visibly occupy at least 60% of the clip; do not pad the beginning or end with a static pose.",
    `DURATION BUDGET — ${budget.durationSeconds} SECONDS: anticipation ${budget.anticipation}; primary motion ${budget.primary}; reaction ${budget.reaction}; follow-through/settle ${budget.followThrough}. Anticipation plus final settle must total no more than ${budget.combinedSetupAndHoldMaxSeconds} seconds.`,
    fourSecondRule,
    eightSecondRule,
  ].join("\n");
}
