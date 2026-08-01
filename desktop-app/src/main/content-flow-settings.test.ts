import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

class FakeControl {
  id: string;
  textContent: string;
  title = "";
  currentSrc = "";
  src = "";
  parentElement: FakeGroup | null = null;
  clickCount = 0;
  onClick: (() => void) | null = null;
  private readonly attributes: Record<string, string>;

  constructor(id: string, textContent: string, attributes: Record<string, string>) {
    this.id = id;
    this.textContent = textContent;
    this.attributes = attributes;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  removeAttribute(name: string): void {
    delete this.attributes[name];
  }

  hasAttribute(name: string): boolean {
    return name in this.attributes;
  }

  getBoundingClientRect(): Record<string, number> {
    return { left: 10, top: 10, right: 130, bottom: 50, width: 120, height: 40 };
  }

  querySelector(): null {
    return null;
  }

  dispatchEvent(): boolean {
    return true;
  }

  click(): void {
    this.clickCount += 1;
    this.onClick?.();
  }
}

class FakeGroup {
  parentElement: FakeGroup | null = null;

  constructor(private readonly controls: FakeControl[]) {
    for (const control of controls) control.parentElement = this;
  }

  querySelectorAll(): FakeControl[] {
    return this.controls;
  }

  getBoundingClientRect(): Record<string, number> {
    return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };
  }
}

class FakeRenderAnchor {
  isConnected = true;
  href = "https://labs.google/fx/tools/flow/project/test/render-active";
  completedTrigger: FakeControl | null = null;
  firstElementChild: FakeRenderTarget | null = null;
  parentElement: FakeGroup | null = null;

  getAttribute(name: string): string | null {
    return name === "href" ? this.href : null;
  }

  querySelector(selector: string): FakeControl | null {
    return selector === "button" ? this.completedTrigger : null;
  }
}

class FakeRenderTarget {
  clickCount = 0;
  textContent: string;

  constructor(private readonly anchor: FakeRenderAnchor, private readonly progress: number, text = "") {
    anchor.firstElementChild = this;
    this.textContent = text;
  }

  getBoundingClientRect(): Record<string, number> {
    return { left: 10, top: 10, right: 330, bottom: 190, width: 320, height: 180 };
  }

  querySelectorAll(selector: string): Array<{ textContent: string }> {
    if (selector === "div") return [{ textContent: `${this.progress}%` }];
    if (selector === "i") return [{ textContent: "play_circle" }];
    return [];
  }

  closest(selector: string): FakeRenderAnchor | null {
    return selector === "a" ? this.anchor : null;
  }

  dispatchEvent(): boolean {
    return true;
  }

  click(): void {
    this.clickCount += 1;
  }
}

class FakeVideo {
  src = "";
  poster = "";

  constructor(
    public currentSrc: string,
    poster = "",
    private readonly width = 400,
    private readonly height = 225,
  ) {
    this.src = currentSrc;
    this.poster = poster;
  }

  getAttribute(name: string): string | null {
    if (name === "src") return this.src || null;
    if (name === "poster") return this.poster || null;
    return null;
  }

  getBoundingClientRect(): Record<string, number> {
    return {
      left: 10,
      top: 10,
      right: 10 + this.width,
      bottom: 10 + this.height,
      width: this.width,
      height: this.height,
    };
  }

  querySelector(): null {
    return null;
  }

  querySelectorAll(): [] {
    return [];
  }

  trigger: FakeControl | null = null;

  closest(): FakeControl | null {
    return this.trigger;
  }
}

test("confirms Flow LANDSCAPE and duration tabs by stable identity", async () => {
  const source = await readFile(
    resolve(process.cwd(), "../extension-worker/content-flow.js"),
    "utf8",
  );
  const controls: FakeControl[] = [];
  const videos: FakeVideo[] = [];
  const renderTargets: FakeRenderTarget[] = [];
  const renderAnchors: FakeRenderAnchor[] = [];
  const windowValue: Record<string, unknown> = {};
  const context = {
    window: windowValue,
    document: {
      querySelectorAll: (selector: string) => selector === "video"
        ? videos
        : selector === "a > div"
          ? renderTargets
          : selector === "a"
            ? renderAnchors
          : controls,
      querySelector: () => null,
    },
    chrome: {
      runtime: {
        onMessage: { addListener: () => {} },
        sendMessage: () => Promise.resolve(),
      },
    },
    console,
    setTimeout,
    clearTimeout,
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    URL,
    location: { href: "https://labs.google/fx/tools/flow/project/test" },
    Event: class {},
    InputEvent: class {},
    DataTransfer: class {},
    File: class {},
    HTMLElement: class {},
    HTMLTextAreaElement: class {},
  };
  vm.runInNewContext(source, context);

  const internals = windowValue.__FLOWX_FLOW_INTERNALS__ as {
    assetMatchesLocator: (
      control: FakeControl,
      locator: Record<string, unknown>,
      filenameHint: string,
    ) => boolean;
    cleanFlowOptionLabel: (control: FakeControl) => string;
    confirmVideoAspectRatio: () => Promise<Record<string, unknown>>;
    confirmVideoDuration: (seconds: number) => Promise<Record<string, unknown>>;
    findEndFrameButton: () => FakeControl | null;
    findStartFrameButton: () => FakeControl | null;
    getMediaModeOption: (mediaType: "image" | "video") => Promise<Record<string, unknown>>;
    getVideoGenerationModeOption: (mode: "frames" | "ingredients") => Promise<Record<string, unknown>>;
    getVideoDurationOption: (seconds: number) => Promise<Record<string, unknown>>;
    confirmVideoGenerationMode: (mode: "frames" | "ingredients") => Promise<Record<string, unknown>>;
    checkForNewVideo: (baseline: string[]) => Record<string, unknown>;
    videoBaselineSnapshot: () => Set<string>;
    startNativeVideoDownload: (baseline: string[]) => Promise<Record<string, unknown>>;
    clickActiveRenderingVideoCard: () => Promise<Record<string, unknown>>;
    videoViewerState: () => Record<string, unknown>;
    clickViewerDownload: () => Promise<Record<string, unknown>>;
    inspectAndCloseFailedVideoViewer: () => Promise<Record<string, unknown>>;
    videoViewerGenerationFailure: () => Record<string, unknown> | null;
    generationFailureSnapshot: () => Map<string, number>;
    newGenerationFailure: () => Record<string, unknown> | null;
    promptTextMatches: (actual: string, expected: string) => boolean;
    isPromptIngredientCancelIcon: (control: FakeControl) => boolean;
  };

  const landscape = new FakeControl(
    "radix-:r1cq:-trigger-LANDSCAPE",
    "crop_16_9 16:9",
    {
      "aria-controls": "radix-:r1cq:-content-LANDSCAPE",
      "aria-selected": "true",
      "data-state": "active",
    },
  );
  controls.push(new FakeControl(
    "radix-:r1lo:-trigger-PORTRAIT",
    "crop_9_16 9:16",
    {
      "aria-controls": "radix-:r1lo:-content-PORTRAIT",
      "aria-selected": "false",
      "data-state": "inactive",
    },
  ), landscape);
  assert.equal(internals.cleanFlowOptionLabel(landscape), "16:9");
  assert.deepEqual(
    { ...(await internals.confirmVideoAspectRatio()) },
    {
      ok: true,
      aspectRatio: "16:9",
      label: "16:9",
      identity: "radix-:r1cq:-trigger-LANDSCAPE radix-:r1cq:-content-LANDSCAPE",
    },
  );

  controls.length = 0;
  const imageMode = new FakeControl(
    "radix-:r15f:-trigger-IMAGE",
    "image Hình ảnh",
    {
      "aria-controls": "radix-:r15f:-content-IMAGE",
      "aria-selected": "false",
      "data-state": "inactive",
      role: "tab",
    },
  );
  controls.push(imageMode);
  const imageModeResult = await internals.getMediaModeOption("image");
  assert.equal(imageModeResult.ok, true);
  assert.match(String(imageModeResult.label), /Hình ảnh/);

  controls.length = 0;
  const workspaceImageMode = new FakeControl(
    "radix-:workspace:-trigger-IMAGE",
    "image Hình ảnh",
    {
      "aria-controls": "radix-:workspace:-content-IMAGE",
      "aria-selected": "false",
      "data-state": "inactive",
      role: "tab",
    },
  );
  const workspaceVideoMode = new FakeControl(
    "radix-:workspace:-trigger-VIDEO",
    "play_circle Video",
    {
      "aria-controls": "radix-:workspace:-content-VIDEO",
      "aria-selected": "true",
      "data-state": "active",
      role: "tab",
    },
  );
  new FakeGroup([workspaceImageMode, workspaceVideoMode]);
  const currentFrameMode = new FakeControl(
    "radix-:r1bk:-trigger-VIDEO_FRAMES",
    "crop_free Khung hình",
    {
      "aria-controls": "radix-:r1bk:-content-VIDEO_FRAMES",
      "aria-selected": "false",
      "data-state": "inactive",
      role: "tab",
    },
  );
  const ingredientMode = new FakeControl(
    "radix-:r1bk:-trigger-VIDEO_REFERENCES",
    "chrome_extension Thành phần",
    {
      "aria-controls": "radix-:r1bk:-content-VIDEO_REFERENCES",
      "aria-selected": "true",
      "data-state": "active",
      role: "tab",
    },
  );
  new FakeGroup([currentFrameMode, ingredientMode]);
  controls.push(workspaceImageMode, workspaceVideoMode, currentFrameMode, ingredientMode);
  const frameModeResult = await internals.getVideoGenerationModeOption("frames");
  assert.deepEqual(
    { ...frameModeResult },
    {
      ok: true,
      x: 70,
      y: 30,
      label: "Khung hình",
      identity: "radix-:r1bk:-trigger-VIDEO_FRAMES radix-:r1bk:-content-VIDEO_FRAMES",
      alreadySelected: false,
    },
  );
  const ingredientModeResult = await internals.getVideoGenerationModeOption("ingredients");
  assert.equal(ingredientModeResult.identity, "radix-:r1bk:-trigger-VIDEO_REFERENCES radix-:r1bk:-content-VIDEO_REFERENCES");
  assert.equal(ingredientModeResult.alreadySelected, true);

  currentFrameMode.setAttribute("aria-selected", "true");
  currentFrameMode.setAttribute("data-state", "active");
  ingredientMode.setAttribute("aria-selected", "false");
  ingredientMode.setAttribute("data-state", "inactive");
  assert.deepEqual(
    { ...(await internals.confirmVideoGenerationMode("frames")) },
    {
      ok: true,
      mode: "frames",
      label: "Khung hình",
      identity: "radix-:r1bk:-trigger-VIDEO_FRAMES radix-:r1bk:-content-VIDEO_FRAMES",
    },
  );

  controls.length = 0;
  const startFrame = new FakeControl("", "Bắt đầu", {
    type: "button",
    "aria-haspopup": "dialog",
    "aria-expanded": "false",
  });
  const endFrame = new FakeControl("", "Kết thúc", {
    type: "button",
    "aria-haspopup": "dialog",
    "aria-expanded": "false",
  });
  controls.push(startFrame, endFrame);
  assert.equal(internals.findStartFrameButton(), startFrame);
  assert.equal(internals.findEndFrameButton(), endFrame);

  controls.length = 0;
  const outputCountX4 = new FakeControl(
    "radix-:output-count:-trigger-4",
    "x4",
    {
      "aria-controls": "radix-:output-count:-content-4",
      "aria-selected": "false",
      "data-state": "inactive",
      role: "tab",
    },
  );
  const duration4s = new FakeControl(
    "radix-:r2ap:-trigger-4",
    "4s",
    {
      "aria-controls": "radix-:r2ap:-content-4",
      "aria-selected": "false",
      "data-state": "inactive",
      role: "tab",
    },
  );
  controls.push(outputCountX4, duration4s);
  assert.deepEqual(
    { ...(await internals.getVideoDurationOption(4)) },
    {
      ok: true,
      x: 70,
      y: 30,
      label: "4s",
      identity: "radix-:r2ap:-trigger-4 radix-:r2ap:-content-4",
      alreadySelected: false,
      durationSeconds: 4,
    },
  );

  controls.length = 0;
  controls.push(new FakeControl(
    "radix-:test:-trigger-8",
    "8s",
    {
      "aria-controls": "radix-:test:-content-8",
      "aria-selected": "true",
      "data-state": "active",
      role: "tab",
    },
  ));
  assert.deepEqual(
    { ...(await internals.confirmVideoDuration(8)) },
    {
      ok: true,
      durationSeconds: 8,
      label: "8s",
      identity: "radix-:test:-trigger-8 radix-:test:-content-8",
    },
  );

  videos.length = 0;
  const oldVideo = new FakeVideo(
    "blob:https://flow.google/old-video",
    "https://flow.google/media?name=old-media-id",
  );
  videos.push(oldVideo);
  const videoBaseline = [...internals.videoBaselineSnapshot()];
  oldVideo.currentSrc = "blob:https://flow.google/remounted-old-video";
  oldVideo.src = oldVideo.currentSrc;
  const remountedOnlyResult = internals.checkForNewVideo(videoBaseline);
  assert.equal(remountedOnlyResult.found, false);
  const newVideo = new FakeVideo(
    "blob:https://flow.google/new-video",
    "https://flow.google/media?name=old-media-id",
    180,
    101,
  );
  newVideo.src = "/fx/api/trpc/media.getMediaUrlRedirect?name=881d5c13-8f04-4017-89b3-a6df82a53d78";
  videos.push(newVideo);
  const newVideoResult = internals.checkForNewVideo(videoBaseline);
  assert.equal(newVideoResult.ok, true);
  assert.equal(newVideoResult.found, true);
  assert.equal(
    newVideoResult.src,
    "https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=881d5c13-8f04-4017-89b3-a6df82a53d78",
  );

  controls.length = 0;
  const videoTrigger = new FakeControl("latest-video", "", {});
  const nativeDownload = new FakeControl("native-download", "download Tải xuống", {});
  const done = new FakeControl("viewer-done", "Xong", {});
  videoTrigger.onClick = () => {
    new FakeGroup([nativeDownload, done]);
    controls.push(nativeDownload, done);
  };
  newVideo.trigger = videoTrigger;
  const nativeDownloadResult = await internals.startNativeVideoDownload(videoBaseline);
  assert.equal(nativeDownloadResult.ok, true);
  assert.equal(videoTrigger.clickCount > 0, true);
  assert.equal(nativeDownload.clickCount, 1);
  assert.equal(done.clickCount > 0, true);

  const oldRenderAnchor = new FakeRenderAnchor();
  oldRenderAnchor.href = "https://labs.google/fx/tools/flow/project/test/render-old";
  const oldRenderingTarget = new FakeRenderTarget(oldRenderAnchor, 88, "An older video prompt");
  const renderAnchor = new FakeRenderAnchor();
  const renderingTarget = new FakeRenderTarget(renderAnchor, 11, "PRIMARY MOTION: the current scene action");
  renderAnchors.push(oldRenderAnchor, renderAnchor);
  renderTargets.push(oldRenderingTarget, renderingTarget);
  windowValue.__flowx_render_anchor_baseline = new Set([oldRenderAnchor]);
  windowValue.__flowx_active_prompt_text = "PRIMARY MOTION: the current scene action";
  const staleFailure = new FakeControl(
    "stale-render-failure",
    "Không thành công Rất tiếc, đã xảy ra lỗi!",
    { role: "alert" },
  );
  controls.push(staleFailure);
  assert.equal(internals.videoViewerGenerationFailure(), null);
  const clickedRenderCard = await internals.clickActiveRenderingVideoCard();
  assert.equal(clickedRenderCard.ok, true);
  assert.equal(clickedRenderCard.progress, 11);
  assert.equal(renderingTarget.clickCount > 0, true);
  assert.equal(oldRenderingTarget.clickCount, 0);
  const completedRenderTrigger = new FakeControl("completed-render", "", {});
  renderAnchor.completedTrigger = completedRenderTrigger;
  renderTargets.length = 0;
  const clickedCompletedCard = await internals.clickActiveRenderingVideoCard();
  assert.equal(clickedCompletedCard.ok, true);
  assert.equal(clickedCompletedCard.progress, 100);
  assert.equal(completedRenderTrigger.clickCount > 0, true);
  assert.equal(internals.videoViewerState().downloadReady, true);
  nativeDownload.setAttribute("disabled", "");
  const downloadCountBeforeDisabledCheck = nativeDownload.clickCount;
  const disabledDownloadAttempt = await internals.clickViewerDownload();
  assert.equal(disabledDownloadAttempt.ok, true);
  assert.equal(disabledDownloadAttempt.disabled, true);
  assert.equal(disabledDownloadAttempt.clicked, false);
  assert.equal(nativeDownload.clickCount, downloadCountBeforeDisabledCheck);
  nativeDownload.removeAttribute("disabled");
  const enabledDownloadAttempt = await internals.clickViewerDownload();
  assert.equal(enabledDownloadAttempt.clicked, true);
  assert.equal(nativeDownload.clickCount, downloadCountBeforeDisabledCheck + 1);

  const titleOnlyWarning = new FakeControl("viewer-title-only-warning", "warning", {});
  const titleOnlyPanel = {
    parentElement: null as FakeGroup | null,
    textContent: "warningKhông thành công",
    getBoundingClientRect: () => ({ left: 410, top: 80, right: 760, bottom: 180, width: 350, height: 100 }),
    querySelectorAll: () => [],
  };
  const titleOnlyViewerRoot = new FakeGroup([done, titleOnlyWarning]);
  titleOnlyWarning.parentElement = titleOnlyPanel as unknown as FakeGroup;
  titleOnlyPanel.parentElement = titleOnlyViewerRoot;
  controls.push(titleOnlyWarning);
  assert.equal(internals.videoViewerGenerationFailure(), null);

  controls.length = 0;
  const failedViewerDone = new FakeControl("failed-viewer-done", "Xong", {});
  const failedViewerWarning = new FakeControl("failed-viewer-warning", "warning", {});
  const failedViewerPanel = {
    parentElement: null as FakeGroup | null,
    textContent: "Không thành công Rất tiếc, đã xảy ra lỗi! Thử lại Xoá",
    getBoundingClientRect: () => ({ left: 10, top: 10, right: 330, bottom: 190, width: 320, height: 180 }),
    querySelectorAll: () => [],
  };
  const failedViewerRoot = new FakeGroup([failedViewerDone, failedViewerWarning]);
  failedViewerWarning.parentElement = failedViewerPanel as unknown as FakeGroup;
  failedViewerPanel.parentElement = failedViewerRoot;
  const outsidePolicyFailure = new FakeControl(
    "outside-policy-failure",
    "Video could not be generated because it might violate our safety policy.",
    { role: "alert" },
  );
  const failedOuterPanel = {
    parentElement: null,
    textContent: outsidePolicyFailure.textContent,
    getBoundingClientRect: () => ({ left: 10, top: 10, right: 330, bottom: 190, width: 320, height: 180 }),
    querySelectorAll: () => [outsidePolicyFailure],
    querySelector: () => null,
  };
  renderAnchor.parentElement = failedOuterPanel as unknown as FakeGroup;
  failedViewerDone.onClick = () => {
    controls.splice(0, controls.length, outsidePolicyFailure);
  };
  controls.push(failedViewerDone, failedViewerWarning);
  windowValue.__flowx_generation_error_baseline = new Map();
  assert.equal(internals.videoViewerGenerationFailure()?.code, "FLOW_GENERATION_FAILED");
  const failedViewerResult = await internals.inspectAndCloseFailedVideoViewer();
  assert.equal(failedViewerResult.viewerFailure, true);
  assert.equal(failedViewerResult.viewerClosed, true);
  assert.equal(failedViewerResult.code, "FLOW_POLICY_VIOLATION");
  assert.match(String(failedViewerResult.outsideError), /safety policy/i);
  assert.equal(internals.newGenerationFailure(), null);

  controls.length = 0;
  const previousFailure = new FakeControl(
    "old-policy-error",
    "This generation might violate our safety policy.",
    { role: "alert" },
  );
  controls.push(previousFailure);
  windowValue.__flowx_generation_error_baseline = internals.generationFailureSnapshot();
  assert.equal(internals.newGenerationFailure(), null);
  controls.push(new FakeControl(
    "new-policy-error",
    "Video could not be generated because it might violate our safety policy.",
    { role: "alert" },
  ));
  assert.deepEqual(
    { ...internals.newGenerationFailure() },
    {
      error: "Video could not be generated because it might violate our safety policy.",
      code: "FLOW_POLICY_VIOLATION",
      policyViolation: true,
    },
  );
  assert.equal(
    internals.promptTextMatches(
      "STARTING STATE: a figure waits.\nPRIMARY MOTION: the figure walks forward.",
      "STARTING STATE: a figure waits. PRIMARY MOTION: the figure walks forward.",
    ),
    true,
  );
  assert.equal(
    internals.promptTextMatches("", "A complete prompt that must be inserted before submit"),
    false,
  );
  assert.equal(
    internals.promptTextMatches("A partial prompt", "A complete prompt that must be inserted before submit"),
    false,
  );

  const attachedCharacterMarker = new FakeControl(
    "character-attachment-marker",
    "cancel",
    { class: "sc-a39c2a59-0 lkKicR google-symbols sc-272106cb-3 husQRa" },
  );
  assert.equal(internals.isPromptIngredientCancelIcon(attachedCharacterMarker), true);
  assert.equal(
    internals.isPromptIngredientCancelIcon(new FakeControl("unrelated-cancel", "cancel", { class: "dialog-action" })),
    false,
  );

  const gullitAsset = new FakeControl("asset-card", "", { alt: "Gullit.png" });
  assert.equal(
    internals.assetMatchesLocator(
      gullitAsset,
      { assetKey: "", rawSrc: "", hints: [] },
      "D:\\characters\\Gullit.png",
    ),
    true,
  );

  const generatedAsset = new FakeControl("generated-card", "", {});
  generatedAsset.currentSrc = "https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=d98ac0e8-d8fb-4d40-8f61-af21fbf6af46&size=thumbnail";
  assert.equal(
    internals.assetMatchesLocator(
      generatedAsset,
      {
        assetKey: "path:https://labs.google/fx/api/trpc/media.getMediaUrlRedirect",
        rawSrc: "https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=d98ac0e8-d8fb-4d40-8f61-af21fbf6af46",
        hints: ["hình ảnh được tạo"],
      },
      "",
    ),
    true,
  );
});
