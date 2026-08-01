import { WorkerConnection } from "./worker-connection.js";
import { videoPacingLock } from "./video-pacing.js";

const RECONNECT_ALARM = "flowx-worker-reconnect";
const PROFILE_TAG_KEY = "flowxProfileTag";
const DETECTED_ROLE_KEY = "flowxDetectedRole";
const CHARACTER_ASSET_CACHE_KEY = "flowxCharacterAssetCacheV1";
const REGISTRATION_BY_ROLE = Object.freeze({
  "chat-worker": {
    provider: "chatgpt",
    capabilities: ["GENERATE_TIMELINE", "REWRITE_POLICY_PROMPT", "GENERATE_CHATGPT_IMAGE"],
  },
  "flow-worker": {
    provider: "google-flow",
    capabilities: ["GENERATE_IMAGE", "GENERATE_VIDEO"],
  },
  "claude-worker": {
    provider: "claude",
    capabilities: ["GENERATE_TIMELINE", "REWRITE_POLICY_PROMPT"],
  },
  "gemini-worker": {
    provider: "gemini",
    capabilities: [
      "GENERATE_TIMELINE",
      "REWRITE_POLICY_PROMPT",
      "GENERATE_PROVIDER_IMAGE",
      "GENERATE_PROVIDER_VIDEO",
    ],
  },
  "grok-worker": {
    provider: "grok",
    capabilities: [
      "GENERATE_TIMELINE",
      "REWRITE_POLICY_PROMPT",
      "GENERATE_PROVIDER_IMAGE",
      "GENERATE_PROVIDER_VIDEO",
    ],
  },
  "capcut-worker": {
    provider: "capcut",
    capabilities: ["GENERATE_PROVIDER_VIDEO"],
  },
});

const TEXT_WORKER_BY_ROLE = Object.freeze({
  "chat-worker": {
    label: "ChatGPT",
    tabPatterns: ["https://chatgpt.com/*"],
    urlPattern: /^https:\/\/chatgpt\.com\//i,
  },
  "claude-worker": {
    label: "Claude",
    tabPatterns: ["https://claude.ai/*"],
    urlPattern: /^https:\/\/claude\.ai\//i,
  },
  "gemini-worker": {
    label: "Gemini",
    tabPatterns: ["https://gemini.google.com/*"],
    urlPattern: /^https:\/\/gemini\.google\.com\//i,
  },
  "grok-worker": {
    label: "Grok",
    tabPatterns: ["https://grok.com/*"],
    urlPattern: /^https:\/\/grok\.com\//i,
  },
  "capcut-worker": {
    label: "CapCut",
    tabPatterns: ["https://www.capcut.com/*", "https://capcut.com/*"],
    urlPattern: /^https:\/\/(?:www\.)?capcut\.com\//i,
  },
});

let profileTagPromise = null;
let roleRefreshTimer = null;
const activeJobsByConnection = new Map();
const activeJobsById = new Map();
const activeJobHeartbeatTimers = new Map();
let defaultConnection = null;
const pause = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function roleForUrl(url = "") {
  if (/^https:\/\/chatgpt\.com\//i.test(url)) return "chat-worker";
  if (/^https:\/\/(?:labs\.google\/fx\/|flow\.google\/)/i.test(url)) return "flow-worker";
  if (/^https:\/\/claude\.ai\//i.test(url)) return "claude-worker";
  if (/^https:\/\/gemini\.google\.com\//i.test(url)) return "gemini-worker";
  if (/^https:\/\/grok\.com\//i.test(url)) return "grok-worker";
  if (/^https:\/\/(?:www\.)?capcut\.com\//i.test(url)) return "capcut-worker";
  return null;
}

async function getProfileTag() {
  if (profileTagPromise) return profileTagPromise;

  profileTagPromise = (async () => {
    const stored = await chrome.storage.local.get(PROFILE_TAG_KEY);
    if (typeof stored[PROFILE_TAG_KEY] === "string") {
      return stored[PROFILE_TAG_KEY];
    }

    const profileTag = `profile-${crypto.randomUUID().slice(0, 8)}`;
    await chrome.storage.local.set({ [PROFILE_TAG_KEY]: profileTag });
    return profileTag;
  })();

  return profileTagPromise;
}

async function detectRegistration() {
  const tabs = await chrome.tabs.query({});
  const matchingTabs = tabs
    .map((tab) => ({ tab, role: roleForUrl(tab.url) }))
    .filter((entry) => entry.role);
  const availableRoles = new Set(matchingTabs.map((entry) => entry.role));

  if (availableRoles.size === 0) return null;

  let role = null;
  if (availableRoles.size === 1) {
    role = [...availableRoles][0];
    await chrome.storage.local.set({ [DETECTED_ROLE_KEY]: role });
  } else {
    role = matchingTabs.find((entry) => entry.tab.active)?.role || null;

    if (!role) {
      const stored = await chrome.storage.local.get(DETECTED_ROLE_KEY);
      const storedRole = stored[DETECTED_ROLE_KEY];
      if (availableRoles.has(storedRole)) role = storedRole;
    }
  }

  if (!role) return null;
  const metadata = REGISTRATION_BY_ROLE[role];
  if (!metadata) return null;
  return {
    role,
    profileTag: await getProfileTag(),
    workerVersion: chrome.runtime.getManifest().version,
    provider: metadata.provider,
    capabilities: [...metadata.capabilities],
  };
}

function updateActionState(state, registration) {
  const presentation = {
    connected: { text: "ON", color: "#167c5a" },
    connecting: { text: "...", color: "#a36a00" },
    disconnected: { text: "OFF", color: "#b42318" },
    waiting: { text: "", color: "#667085" },
    idle: { text: "", color: "#667085" },
  }[state];

  void chrome.action.setBadgeText({ text: presentation.text });
  void chrome.action.setBadgeBackgroundColor({ color: presentation.color });
  void chrome.action.setTitle({
    title: registration
      ? `Vyren AI Worker - ${registration.role} - ${state}`
      : "Vyren AI Worker - waiting for ChatGPT, Claude, Gemini, Grok, CapCut, or Google Flow",
  });
}

function activeJobForConnection(connection) {
  return connection ? activeJobsByConnection.get(connection) || null : null;
}

function activeJobForId(jobId) {
  return typeof jobId === "string" ? activeJobsById.get(jobId) || null : null;
}

function isCurrentJob(job) {
  return Boolean(
    job &&
    activeJobsById.get(job.jobId) === job &&
    (!job.connection || activeJobsByConnection.get(job.connection) === job)
  );
}

function isJobStopped(jobId) {
  const job = activeJobForId(jobId);
  return !job || job.stopping;
}

function setActiveJob(job) {
  if (job.connection) activeJobsByConnection.set(job.connection, job);
  activeJobsById.set(job.jobId, job);
}

function clearActiveJob(job) {
  if (!job) return;
  if (job.connection && activeJobsByConnection.get(job.connection) === job) {
    activeJobsByConnection.delete(job.connection);
  }
  if (activeJobsById.get(job.jobId) === job) {
    activeJobsById.delete(job.jobId);
  }
  stopActiveJobHeartbeat(job.jobId);
}

function jobConnection(job = null) {
  return job?.connection || defaultConnection || null;
}

function sendJobError(jobId, error, code = "INTERNAL_ERROR", retryable = false, targetConnection = null) {
  console.error(`[Vyren AI Worker][${jobId}][${code}] ${error}`);
  (targetConnection || activeJobForId(jobId)?.connection || defaultConnection)?.send?.({
    type: "JOB_ERROR",
    jobId,
    error,
    code,
    retryable,
  });
}

function progressDetails(value = {}) {
  const result = {};
  for (const field of ["phase", "provider"]) {
    if (typeof value[field] === "string") result[field] = value[field].slice(0, 80);
  }
  for (const field of [
    "batchIndex",
    "batchCount",
    "attempt",
    "maxAttempts",
    "sceneCount",
    "totalScenes",
    "elapsedSeconds",
  ]) {
    const number = Number(value[field]);
    if (Number.isFinite(number) && number >= 0) result[field] = Math.floor(number);
  }
  return result;
}

function sendJobProgress(jobId, status, message, details = {}) {
  console.info(`[Vyren AI Worker][${jobId}][${status}] ${message}`);
  const job = activeJobForId(jobId);
  jobConnection(job)?.send({
    type: "JOB_PROGRESS",
    jobId,
    status,
    message,
    ...progressDetails(details),
  });
}

function startActiveJobHeartbeat(jobId) {
  stopActiveJobHeartbeat(jobId);
  const timer = setInterval(() => {
    const job = activeJobForId(jobId);
    if (!job || job.stopping) {
      stopActiveJobHeartbeat(jobId);
      return;
    }
    jobConnection(job)?.send({
      type: "JOB_PROGRESS",
      jobId,
      status: "generating",
      message: "Worker vẫn đang xử lý trên trang AI",
      heartbeat: true,
    });
  }, 5_000);
  activeJobHeartbeatTimers.set(jobId, timer);
}

function stopActiveJobHeartbeat(jobId = null) {
  if (jobId === null) {
    for (const timer of activeJobHeartbeatTimers.values()) clearInterval(timer);
    activeJobHeartbeatTimers.clear();
    return;
  }
  const timer = activeJobHeartbeatTimers.get(jobId);
  if (!timer) return;
  clearInterval(timer);
  activeJobHeartbeatTimers.delete(jobId);
}

async function findChatGptTab() {
  return findTextProviderTab("chat-worker");
}

function connectionKeyForTab(role, tabId) {
  return `${role}:${tabId}`;
}

function tabMatchesRole(tab, role) {
  return Boolean(tab?.id && roleForUrl(tab.url) === role);
}

async function registrationForTab(role, tabId) {
  const metadata = REGISTRATION_BY_ROLE[role];
  if (!metadata) return null;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tabMatchesRole(tab, role)) return null;
  const profileTag = await getProfileTag();
  return {
    role,
    profileTag: `${profileTag}:tab-${tabId}`,
    workerVersion: chrome.runtime.getManifest().version,
    provider: metadata.provider,
    capabilities: [...metadata.capabilities],
    tabId,
  };
}

async function findTextProviderTab(role) {
  const config = TEXT_WORKER_BY_ROLE[role];
  if (!config) return null;
  const tabs = await chrome.tabs.query({ url: config.tabPatterns });
  if (tabs.length === 0) return null;
  const lastFocused = await chrome.windows.getLastFocused().catch(() => null);
  return tabs.find((tab) => tab.active && tab.windowId === lastFocused?.id) ||
    tabs.find((tab) => tab.active) ||
    tabs[0];
}

async function tabForConnection(sourceConnection, role, fallbackFinder) {
  const tabId = Number(sourceConnection?.registration?.tabId);
  if (Number.isInteger(tabId)) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tabMatchesRole(tab, role)) return tab;
    return null;
  }
  return fallbackFinder ? fallbackFinder(role) : null;
}

async function findFlowTab() {
  const tabs = await chrome.tabs.query({
    url: ["https://labs.google/fx/*", "https://flow.google/*"],
  });
  if (tabs.length === 0) return null;
  const lastFocused = await chrome.windows.getLastFocused().catch(() => null);
  return tabs.find((tab) => tab.active && tab.windowId === lastFocused?.id) ||
    tabs.find((tab) => tab.active) ||
    tabs[0];
}

async function activateFlowWorkspace(tab) {
  if (!tab?.id) throw new Error("Flow workspace tab is unavailable");
  if (Number.isInteger(tab.windowId)) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  await chrome.tabs.update(tab.id, { active: true });
  await pause(300);
  const activeTab = await chrome.tabs.get(tab.id);
  if (!activeTab.active) {
    throw new Error("Chrome không thể kích hoạt tab Google Flow đã chọn");
  }
  return activeTab;
}

async function activateProviderTab(tab, providerLabel) {
  if (!tab?.id) throw new Error(`${providerLabel} tab is unavailable`);
  if (Number.isInteger(tab.windowId)) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  await chrome.tabs.update(tab.id, { active: true });
  await pause(300);
  const activeTab = await chrome.tabs.get(tab.id);
  if (!activeTab.active) {
    throw new Error(`Chrome không thể kích hoạt tab ${providerLabel} đã chọn`);
  }
  return activeTab;
}

async function waitForTabReady(tabId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      await pause(800);
      return tab;
    }
    await pause(250);
  }
  throw new Error("Trang AI tải quá thời gian");
}

async function prepareProviderMediaTab(role, tab, mediaType) {
  const providerLabel = role === "gemini-worker" ? "Gemini" : role === "grok-worker" ? "Grok" : "CapCut";
  let activeTab = await activateProviderTab(tab, providerLabel);
  if (
    role === "grok-worker" &&
    !/^https:\/\/grok\.com\/imagine(?:\/|$|[?#])/i.test(activeTab.url || "")
  ) {
    await chrome.tabs.update(tab.id, { url: "https://grok.com/imagine" });
    activeTab = await waitForTabReady(tab.id);
  }
  if (mediaType === "video" && role === "gemini-worker") {
    await pause(300);
  }
  if (
    mediaType === "video" &&
    role === "capcut-worker" &&
    !/^https:\/\/(?:www\.)?capcut\.com\/ai-creator\/start(?:\/|$|[?#])/i.test(activeTab.url || "")
  ) {
    await chrome.tabs.update(tab.id, { url: "https://www.capcut.com/ai-creator/start" });
    activeTab = await waitForTabReady(tab.id);
  }
  return activeTab;
}

async function ensureFlowMediaMode(tabId, mediaType) {
  await pressEscape(tabId).catch(() => {});
  await pause(120);
  const picker = await sendImageToFlowTab(tabId, {
    type: "FLOWX_GET_MEDIA_MODE_PICKER",
    mediaType,
  });
  if (!picker?.ok || picker.alreadySelected) return picker;

  let popupOpen = false;
  let completed = false;
  try {
    await clickAt(tabId, picker.x, picker.y);
    popupOpen = true;
    const option = await sendImageToFlowTab(tabId, {
      type: "FLOWX_GET_MEDIA_MODE_OPTION",
      mediaType,
    });
    if (!option?.ok) return option;
    await clickAt(tabId, option.x, option.y);
    const confirmed = await sendImageToFlowTab(tabId, {
      type: "FLOWX_CONFIRM_MEDIA_MODE",
      mediaType,
    });
    completed = confirmed?.ok === true;
    return confirmed;
  } finally {
    if (popupOpen && !completed) {
      await pressEscape(tabId).catch(() => {});
    }
  }
}

function isTimelinePayload(payload) {
  return (
    payload &&
    typeof payload.srtText === "string" &&
    payload.srtText.trim() &&
    typeof payload.scriptText === "string" &&
    payload.scriptText.trim()
  );
}

function isPolicyRewritePayload(payload) {
  return Boolean(
    payload &&
    /^scene-\d{3,4}$/.test(payload.sceneId || "") &&
    (payload.mediaType === "image" || payload.mediaType === "video") &&
    typeof payload.prompt === "string" &&
    payload.prompt.trim() &&
    typeof payload.policyError === "string"
  );
}

function isSceneJobPayload(payload) {
  const validVideoSettings = payload?.mediaType !== "video" || (
    payload.videoSettings &&
    (
      payload.videoSettings.mode === "text-to-video" ||
      payload.videoSettings.mode === "ingredients" ||
      payload.videoSettings.mode === "first-frame" ||
      payload.videoSettings.mode === "frames"
    ) &&
    [4, 6, 8].includes(Number(payload.videoSettings.durationSeconds)) &&
    (payload.videoSettings.mode !== "frames" || (
      typeof payload.startFramePath === "string" &&
      /^(?:[A-Za-z]:[\\/]|\/)/.test(payload.startFramePath) &&
      /\.(?:png|jpe?g|webp)$/i.test(payload.startFramePath)
    ))
  );
  return Boolean(
    payload &&
    /^scene-\d{3,4}$/.test(payload.sceneId || "") &&
    (payload.mediaType === "image" || payload.mediaType === "video") &&
    typeof payload.prompt === "string" &&
    payload.prompt.trim() &&
    (payload.mediaType !== "video" || payload.videoSettings?.mode === "text-to-video" || (
      typeof payload.sourceImagePath === "string" &&
      /^(?:[A-Za-z]:[\\/]|\/)/.test(payload.sourceImagePath) &&
      /\.(?:png|jpe?g|webp)$/i.test(payload.sourceImagePath)
    )) &&
    validVideoSettings
  );
}

function validReferenceImages(value) {
  return Array.isArray(value) && value.length <= 10 && value.every((reference) =>
    reference &&
    /^@[A-Z0-9_]{1,40}$/.test(reference.token || "") &&
    typeof reference.name === "string" &&
    ["image/png", "image/jpeg", "image/webp"].includes(reference.mimeType) &&
    typeof reference.imageBase64 === "string" &&
    reference.imageBase64.length > 0 &&
    typeof reference.localPath === "string" &&
    /^(?:[A-Za-z]:[\\/]|\/)/.test(reference.localPath)
  );
}

function isMissingContentReceiver(error) {
  const message = String(error?.message || error);
  return (
    message.includes("Could not establish connection") ||
    message.includes("Receiving end does not exist") ||
    message.includes("message channel closed") ||
    message.includes("asynchronous response")
  );
}

async function sendTextWorkerMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!isMissingContentReceiver(error)) throw error;
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: ["content-chat.js"],
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function sendImageToFlowTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!isMissingContentReceiver(error)) throw error;
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      files: ["content-flow.js"],
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

function safeOutputFolder(value) {
  return String(value || "default-session")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "default-session";
}

function safeSceneFileName(sceneId, mimeType, outputFolder) {
  const extension = mimeType === "image/webp" ? "webp" : mimeType === "image/jpeg" ? "jpg" : "png";
  return `Vyren AI/${safeOutputFolder(outputFolder)}/${sceneId}-${Date.now()}.${extension}`;
}

function safeVideoFileName(sceneId, mimeType, outputFolder) {
  const extension = mimeType === "video/webm" ? "webm" : "mp4";
  return `Vyren AI/${safeOutputFolder(outputFolder)}/${sceneId}-${Date.now()}.${extension}`;
}

async function waitForDownload(downloadId, timeoutMs = 120000, mediaLabel = "nội dung") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item?.state === "complete" && item.filename) return item.filename;
    if (item?.state === "interrupted") {
      throw new Error(`Tải ${mediaLabel} bị gián đoạn: ${item.error || "unknown"}`);
    }
    await pause(250);
  }
  throw new Error(`Hết thời gian chờ Chrome lưu ${mediaLabel}`);
}

function isNativeFlowVideoDownload(item, knownIds, startedAt) {
  if (!item || knownIds.has(item.id)) return false;
  const itemStartedAt = Date.parse(item.startTime || "");
  if (Number.isFinite(itemStartedAt) && itemStartedAt < startedAt - 2_000) return false;
  const urls = `${item.url || ""} ${item.finalUrl || ""}`.toLocaleLowerCase();
  const filename = String(item.filename || "").toLocaleLowerCase();
  const mime = String(item.mime || "").toLocaleLowerCase();
  return mime.startsWith("video/") ||
    /\.(?:mp4|webm|mov)(?:$|[?#])/.test(`${filename} ${urls}`) ||
    /(?:labs\.google\/fx|flow\.google|media\.getmediaurlredirect|googlevideo)/.test(urls);
}

async function downloadNewestVideoThroughFlow(tabId, videoBaseline, payload, jobId, viewerAlreadyOpen = false) {
  const existing = await chrome.downloads.search({});
  const knownIds = new Set(existing.map((item) => item.id));
  const startedAt = Date.now();
  let capturedItem = null;
  let resolveCreated;
  const createdPromise = new Promise((resolve) => {
    resolveCreated = resolve;
  });
  const capture = (item) => {
    if (capturedItem || !isNativeFlowVideoDownload(item, knownIds, startedAt)) return false;
    capturedItem = item;
    resolveCreated(item);
    return true;
  };
  const onCreated = (item) => {
    capture(item);
  };
  const onDeterminingFilename = (item, suggest) => {
    if (capturedItem?.id !== item.id && !capture(item)) return;
    const mimeType = String(item.mime || "").toLocaleLowerCase() === "video/webm"
      ? "video/webm"
      : "video/mp4";
    suggest({
      filename: safeVideoFileName(payload.sceneId, mimeType, payload.outputFolder),
      conflictAction: "uniquify",
    });
  };

  chrome.downloads.onCreated.addListener(onCreated);
  chrome.downloads.onDeterminingFilename.addListener(onDeterminingFilename);
  try {
    sendJobProgress(
      jobId,
      "downloading",
      viewerAlreadyOpen
        ? "Video trong viewer đã render xong; đang bấm Tải xuống"
        : "Đang mở video mới nhất và bấm nút Tải xuống gốc của Flow",
    );
    let item = null;
    if (viewerAlreadyOpen) {
      sendJobProgress(jobId, "generating", "Viewer đã mở; kiểm tra nút Download mỗi 2 giây và chỉ bấm một lần khi nút sẵn sàng");
      const deadline = Date.now() + 600_000;
      let attempt = 0;
      while (!capturedItem && Date.now() < deadline) {
        if (isJobStopped(jobId)) {
          throw new Error("Đã dừng vòng lặp bấm nút Tải xuống Flow");
        }
        attempt += 1;
        const attemptStartedAt = Date.now();
        const viewerFailure = await sendImageToFlowTab(tabId, {
          type: "FLOWX_CHECK_AND_CLOSE_FAILED_VIDEO_VIEWER",
        });
        if (viewerFailure?.viewerFailure) {
          const failureError = new Error(
            viewerFailure.error || "Google Flow không tạo được video trong cửa sổ render",
          );
          failureError.code = viewerFailure.code || "FLOW_GENERATION_FAILED";
          failureError.policyViolation = viewerFailure.policyViolation === true;
          throw failureError;
        }
        const response = await sendImageToFlowTab(tabId, {
          type: "FLOWX_CLICK_VIDEO_VIEWER_DOWNLOAD",
        });
        if (response?.error && (response.code === "FLOW_POLICY_VIOLATION" || response.code === "FLOW_GENERATION_FAILED")) {
          const failureError = new Error(response.error);
          failureError.code = response.code;
          failureError.policyViolation = response.policyViolation === true;
          throw failureError;
        }
        if (response?.viewerOpen === false) {
          throw new Error(response?.error || "Viewer video Flow đã đóng trước khi tải xuống");
        }
        sendJobProgress(
          jobId,
          "downloading",
          response?.disabled
            ? `Đang kiểm tra nút Tải xuống · lần ${attempt} · nút còn khóa`
            : response?.clicked
              ? "Nút Tải xuống đã sẵn sàng; đã bấm đúng một lần và đang chờ Chrome lưu file"
              : `Đang kiểm tra nút Tải xuống · lần ${attempt} · nút chưa xuất hiện`,
        );
        if (response?.clicked) {
          item = capturedItem || await Promise.race([createdPromise, pause(30_000).then(() => null)]);
          if (!item) {
            const recent = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 50 });
            item = recent.find((entry) => isNativeFlowVideoDownload(entry, knownIds, startedAt)) || null;
          }
          if (!item) {
            throw new Error("Chrome không ghi nhận lượt tải video sau một lần bấm nút Flow");
          }
          break;
        }
        const remaining = Math.max(0, 2_000 - (Date.now() - attemptStartedAt));
        await pause(remaining);
      }
    } else {
      const response = await sendImageToFlowTab(tabId, {
        type: "FLOWX_NATIVE_DOWNLOAD_NEW_VIDEO",
        videoBaseline,
      });
      if (!response?.ok) throw new Error(response?.error || "Flow không mở được nút tải video");
      item = capturedItem || await Promise.race([createdPromise, pause(15_000).then(() => null)]);
    }
    if (!item) {
      const recent = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 50 });
      item = recent.find((entry) => isNativeFlowVideoDownload(entry, knownIds, startedAt)) || null;
    }
    if (!item) throw new Error("Chrome không ghi nhận lượt tải video sau khi bấm nút Flow");
    const resultPath = await waitForDownload(item.id, 300_000, "video");
    return resultPath;
  } finally {
    chrome.downloads.onCreated.removeListener(onCreated);
    chrome.downloads.onDeterminingFilename.removeListener(onDeterminingFilename);
    if (viewerAlreadyOpen) {
      await sendImageToFlowTab(tabId, { type: "FLOWX_CLOSE_VIDEO_VIEWER" }).catch(() => {});
    }
  }
}

async function downloadFlowImage(response, payload) {
  const url = typeof response.dataUrl === "string" && response.dataUrl.startsWith("data:image/")
    ? response.dataUrl
    : response.src;
  if (typeof url !== "string" || !/^(data:image\/|https?:|blob:)/i.test(url)) {
    throw new Error("Google Flow không trả về URL ảnh hợp lệ");
  }
  const mimeType = response.dataUrl?.match(/^data:(image\/(?:png|jpeg|webp));/)?.[1] || "image/png";
  const downloadId = await chrome.downloads.download({
    url,
    filename: safeSceneFileName(payload.sceneId, mimeType, payload.outputFolder),
    conflictAction: "uniquify",
    saveAs: false,
  });
  return waitForDownload(downloadId, 120000, "ảnh");
}

async function downloadChatGptImage(response, payload) {
  const url = typeof response.dataUrl === "string" && response.dataUrl.startsWith("data:image/")
    ? response.dataUrl
    : response.src;
  if (typeof url !== "string" || !/^(data:image\/|https?:|blob:)/i.test(url)) {
    throw new Error("ChatGPT không trả về URL ảnh hợp lệ");
  }
  const mimeType =
    response.mimeType ||
    response.dataUrl?.match(/^data:(image\/(?:png|jpeg|webp));/)?.[1] ||
    "image/png";
  const downloadId = await chrome.downloads.download({
    url,
    filename: safeSceneFileName(payload.sceneId, mimeType, payload.outputFolder),
    conflictAction: "uniquify",
    saveAs: false,
  });
  return waitForDownload(downloadId, 180000, "ảnh ChatGPT");
}

async function downloadProviderImage(response, payload, providerLabel) {
  const url = typeof response.dataUrl === "string" && response.dataUrl.startsWith("data:image/")
    ? response.dataUrl
    : response.src;
  if (typeof url !== "string" || !/^(data:image\/|https?:|blob:)/i.test(url)) {
    throw new Error(`${providerLabel} không trả về URL ảnh hợp lệ`);
  }
  const mimeType =
    response.mimeType ||
    response.dataUrl?.match(/^data:(image\/(?:png|jpeg|webp));/)?.[1] ||
    "image/png";
  const downloadId = await chrome.downloads.download({
    url,
    filename: safeSceneFileName(payload.sceneId, mimeType, payload.outputFolder),
    conflictAction: "uniquify",
    saveAs: false,
  });
  return waitForDownload(downloadId, 180000, `ảnh ${providerLabel}`);
}

function isProviderVideoDownload(item, knownIds, startedAt) {
  if (!item || knownIds.has(item.id)) return false;
  const itemStartedAt = Date.parse(item.startTime || "");
  if (Number.isFinite(itemStartedAt) && itemStartedAt < startedAt - 2_000) return false;
  const source = `${item.url || ""} ${item.finalUrl || ""} ${item.filename || ""}`.toLowerCase();
  const mime = String(item.mime || "").toLowerCase();
  return mime.startsWith("video/") ||
    /\.(?:mp4|webm|mov)(?:$|[?#])/.test(source) ||
    /(?:gemini\.google\.com|googlevideo|grok\.com|x\.ai|twimg\.com|capcut\.com|byteoversea|byteimg|bytedance|muscdn|tiktokcdn)/.test(source);
}

async function downloadProviderVideo(tabId, response, payload, providerLabel) {
  const existing = await chrome.downloads.search({});
  const knownIds = new Set(existing.map((item) => item.id));
  const startedAt = Date.now();
  let capturedItem = null;
  let resolveCreated;
  const createdPromise = new Promise((resolve) => {
    resolveCreated = resolve;
  });
  const capture = (item) => {
    if (capturedItem || !isProviderVideoDownload(item, knownIds, startedAt)) return false;
    capturedItem = item;
    resolveCreated(item);
    return true;
  };
  const onCreated = (item) => {
    capture(item);
  };
  const onDeterminingFilename = (item, suggest) => {
    if (capturedItem?.id !== item.id && !capture(item)) return;
    const mimeType = String(item.mime || "").toLowerCase() === "video/webm"
      ? "video/webm"
      : "video/mp4";
    suggest({
      filename: safeVideoFileName(payload.sceneId, mimeType, payload.outputFolder),
      conflictAction: "uniquify",
    });
  };

  chrome.downloads.onCreated.addListener(onCreated);
  chrome.downloads.onDeterminingFilename.addListener(onDeterminingFilename);
  try {
    const native = await sendTextWorkerMessage(tabId, { type: "FLOWX_PROVIDER_DOWNLOAD_VIDEO" });
    if (native?.clicked) {
      const item = capturedItem || await Promise.race([
        createdPromise,
        pause(30_000).then(() => null),
      ]);
      if (item) return waitForDownload(item.id, 300_000, `video ${providerLabel}`);
    }

    const url = typeof native?.src === "string" && native.src
      ? native.src
      : response?.src;
    if (typeof url !== "string" || !/^(https?:|data:video\/)/i.test(url)) {
      throw new Error(
        `${providerLabel} không cung cấp URL video tải được và không tìm thấy nút Download`,
      );
    }
    const mimeType = native?.mimeType || response?.mimeType || "video/mp4";
    const downloadId = await chrome.downloads.download({
      url,
      filename: safeVideoFileName(payload.sceneId, mimeType, payload.outputFolder),
      conflictAction: "uniquify",
      saveAs: false,
    });
    return waitForDownload(downloadId, 300_000, `video ${providerLabel}`);
  } finally {
    chrome.downloads.onCreated.removeListener(onCreated);
    chrome.downloads.onDeterminingFilename.removeListener(onDeterminingFilename);
  }
}

function stripConflictingRenderPhrases(prompt) {
  return String(prompt || "")
    .replace(/\b(?:photorealistic|hyperrealistic|realistic rendering)\b/gi, "")
    .replace(/\b(?:subtle\s+)?paper\s+(?:grain|texture)\b/gi, "")
    .replace(/\b(?:subtle\s+)?(?:film\s+)?grain\b/gi, "")
    .replace(/\bshallow\s+(?:cinematic\s+)?depth(?:\s+of\s+field)?\b/gi, "")
    .replace(/\bsoft\s+(?:directional\s+)?shadows?\b/gi, "")
    .replace(/\bvolumetric\s+(?:light|lighting)\b/gi, "")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/([,;])\s*([,;])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function isStickFigureStyle(style) {
  return /\bstick\s*[- ]?\s*(?:man|men|figure|figures)\b/i.test(String(style || ""));
}

function promptWithReferences(payload) {
  const sections = [];
  const bible = payload.visualBible || {};
  const graphicStyle = String(bible.style || "").trim();
  const stickFigureMode = isStickFigureStyle(graphicStyle);
  const continuity = [
    graphicStyle ? `Graphic style: ${graphicStyle}` : "",
    bible.palette ? `Color palette: ${bible.palette}` : "",
    bible.lighting ? `Lighting: ${bible.lighting}` : "",
    bible.continuityNotes ? `Continuity rules: ${bible.continuityNotes}` : "",
  ].filter(Boolean);
  if (continuity.length) {
    sections.push(`PROJECT VISUAL BIBLE — keep these properties consistent:\n${continuity.join("\n")}`);
  }
  if (payload.refImages.length) {
    const mapping = payload.refImages
      .map((reference) => `${reference.token} = ${reference.name} in the attached asset ${reference.token.replace(/^@/, "")}`)
      .join("; ");
    sections.push(stickFigureMode
      ? `Character reference mapping: ${mapping}. Translate every reference into the locked stick-figure design. Preserve only recognizable clothing colors, accessories, relative age, and proportions; do not copy realistic facial anatomy, skin, hands, or texture.`
      : `Character reference mapping: ${mapping}. Preserve each referenced character's facial identity, hair, age, clothing, and body proportions.`);
  }
  sections.push(`SCENE CONTENT:\n${stripConflictingRenderPhrases(payload.prompt)}`);
  sections.push([
    "SCENE COMPLETENESS LOCK:",
    "Render the complete story setting described in SETTING AND BACKGROUND and all three DEPTH LAYERS. Do not output an isolated character, portrait, character sheet, or empty backdrop unless the scene content explicitly calls for one.",
    "Every visible character must show the specified emotion through readable eyes, eyebrows, mouth, head angle, posture, and gesture. Keep every prop and subject in the stated spatial position and camera composition.",
  ].join("\n"));
  if (graphicStyle) {
    sections.push([
      "FINAL GRAPHIC STYLE LOCK — HIGHEST PRIORITY:",
      graphicStyle,
      "Replace any conflicting art style, medium, realism, texture, depth-of-field, lighting, or shadow wording in the scene content with this graphic style.",
      stickFigureMode
        ? "Every visible person must be an unmistakably human 2D stick figure, never a tree or plant: one circular head, one line torso, exactly two arms attached at the shoulders, and exactly two legs attached at the hips. Add only a simple expressive face with dot eyes, line eyebrows, and a small readable mouth. White canvas is only the base color; always draw the required foreground, middle-ground, and background setting. No branch-like limbs, wood texture, realistic anatomy, realistic hands, skin texture, 3D body, photo style, or cinematic depth of field. Keep identity through colors, simple clothing shapes, accessories, scale, and pose only."
        : "Do not let scene-content rendering adjectives override this style lock.",
    ].join("\n"));
  }
  return sections.join("\n\n");
}

async function clickAt(tabId, x, y) {
  await ensureAttached(tabId);
  // Give Radix popovers enough time to finish layout before using the
  // coordinates returned by the content script. The mouse move plus the
  // short holds also make each automated action visible to the operator.
  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
  });
  await pause(220);
  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await pause(650);
}

async function pressEscape(tabId) {
  await ensureAttached(tabId);
  await sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
}

function waitForDebuggerEvent(tabId, method, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.debugger.onEvent.removeListener(listener);
      reject(new Error(`Google Flow không mở hộp chọn file (${method}).`));
    }, timeoutMs);
    const listener = (source, eventMethod, params) => {
      if (source.tabId !== tabId || eventMethod !== method) return;
      clearTimeout(timer);
      chrome.debugger.onEvent.removeListener(listener);
      resolve(params);
    };
    chrome.debugger.onEvent.addListener(listener);
  });
}

async function chooseLocalFile(tabId, x, y, localPath) {
  await ensureAttached(tabId);
  await sendCommand(tabId, "Page.enable");
  await sendCommand(tabId, "Page.setInterceptFileChooserDialog", { enabled: true });
  try {
    const chooser = waitForDebuggerEvent(tabId, "Page.fileChooserOpened");
    await clickAt(tabId, x, y);
    const event = await chooser;
    await sendCommand(tabId, "DOM.setFileInputFiles", {
      backendNodeId: event.backendNodeId,
      files: [localPath],
    });
  } finally {
    await sendCommand(tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
  }
}

function reusableCharacterReference(reference) {
  return /^@(?!STYLE_ANCHOR_|CHAIN_)[A-Z0-9_]{1,40}$/.test(reference?.token || "");
}

async function referenceContentHash(reference) {
  const bytes = new TextEncoder().encode(String(reference?.imageBase64 || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function flowWorkspaceCacheKey(tabId) {
  const tab = await chrome.tabs.get(tabId);
  try {
    const url = new URL(tab.url || "");
    return `${url.origin}${url.pathname.replace(/\/+$/, "") || "/"}`;
  } catch {
    return `tab:${tabId}`;
  }
}

async function characterAssetCacheIdentity(tabId, reference) {
  return [
    await flowWorkspaceCacheKey(tabId),
    reference.token,
    await referenceContentHash(reference),
  ].join("|");
}

async function cachedCharacterAsset(tabId, reference) {
  if (!reusableCharacterReference(reference)) return { identity: "", assetLocator: null };
  const identity = await characterAssetCacheIdentity(tabId, reference);
  const stored = await chrome.storage.local.get(CHARACTER_ASSET_CACHE_KEY);
  const cache = stored[CHARACTER_ASSET_CACHE_KEY];
  const cached = cache && typeof cache === "object" ? cache[identity] : null;
  return {
    identity,
    assetLocator: typeof cached === "string"
      ? { assetKey: cached, rawSrc: "", hints: [] }
      : cached && typeof cached === "object"
        ? cached
        : null,
  };
}

async function rememberCharacterAsset(identity, assetLocator) {
  if (!identity || !assetLocator || typeof assetLocator !== "object") return;
  const hasLocator = Boolean(
    String(assetLocator.assetKey || "").trim() ||
    String(assetLocator.rawSrc || "").trim() ||
    (Array.isArray(assetLocator.hints) && assetLocator.hints.length > 0),
  );
  if (!hasLocator) return;
  const stored = await chrome.storage.local.get(CHARACTER_ASSET_CACHE_KEY);
  const cache = stored[CHARACTER_ASSET_CACHE_KEY] && typeof stored[CHARACTER_ASSET_CACHE_KEY] === "object"
    ? { ...stored[CHARACTER_ASSET_CACHE_KEY] }
    : {};
  cache[identity] = assetLocator;
  const entries = Object.entries(cache);
  const compact = entries.length > 200 ? Object.fromEntries(entries.slice(-200)) : cache;
  await chrome.storage.local.set({ [CHARACTER_ASSET_CACHE_KEY]: compact });
}

function localFileName(localPath) {
  return String(localPath || "").split(/[\\/]/).filter(Boolean).at(-1) || "";
}

function storedFlowAssetLocator(value) {
  const stored = String(value || "").trim();
  if (!stored) return null;
  if (stored.startsWith("locator:")) {
    try {
      const locator = JSON.parse(stored.slice("locator:".length));
      return locator && typeof locator === "object" ? locator : null;
    } catch {
      return null;
    }
  }
  // This redirect path is shared by many Flow thumbnails and can select the
  // wrong scene. Old sessions using it must safely fall back to local import.
  if (/media\.getMediaUrlRedirect\/?$/i.test(stored)) return null;
  return { assetKey: stored, rawSrc: "", hints: [] };
}

function storedFlowAssetIdentity(imageResult) {
  const locator = imageResult?.flowAssetLocator;
  if (locator && typeof locator === "object") {
    const encoded = `locator:${JSON.stringify(locator)}`;
    if (encoded.length <= 4_096) return encoded;
  }
  return String(imageResult?.flowAssetKey || "").slice(0, 4_096);
}

async function addSelectedAssetToPrompt(tabId, assetLocator = null, filenameHint = "") {
  const addToPrompt = await sendImageToFlowTab(tabId, { type: "FLOWX_GET_ADD_TO_PROMPT_BUTTON" });
  if (!addToPrompt?.ok) return addToPrompt;
  await clickAt(tabId, addToPrompt.x, addToPrompt.y);
  return sendImageToFlowTab(tabId, {
    type: "FLOWX_CONFIRM_INGREDIENT_DROP",
    expectedCount: 1,
    assetLocator,
    filenameHint,
  });
}

async function attachReferenceWithPickerOnce(tabId, reference) {
  const cached = await cachedCharacterAsset(tabId, reference);
  const filenameHint = localFileName(reference.localPath);
  if (cached.assetLocator) {
    const attached = await sendImageToFlowTab(tabId, {
      type: "FLOWX_GET_ATTACHED_PROMPT_INGREDIENT",
      assetLocator: cached.assetLocator,
      filenameHint,
    });
    if (attached?.ok && attached.found) {
      return { ok: true, reusedProjectAsset: true, alreadyAttached: true };
    }
  }

  const add = await sendImageToFlowTab(tabId, { type: "FLOWX_GET_PROMPT_ADD_BUTTON" });
  if (!add?.ok) return add;
  await clickAt(tabId, add.x, add.y);

  if (cached.assetLocator) {
    const existing = await sendImageToFlowTab(tabId, {
      type: "FLOWX_GET_EXISTING_PROJECT_ASSET",
      assetLocator: cached.assetLocator,
      filenameHint,
    });
    if (existing?.ok && existing.found) {
      await clickAt(tabId, existing.x, existing.y);
      const confirmed = await addSelectedAssetToPrompt(tabId, existing.assetLocator || cached.assetLocator, filenameHint);
      if (confirmed?.ok && existing.assetLocator) {
        await rememberCharacterAsset(cached.identity, existing.assetLocator);
      }
      return confirmed?.ok ? { ...confirmed, reusedProjectAsset: true } : confirmed;
    }
  }

  const upload = await sendImageToFlowTab(tabId, { type: "FLOWX_GET_UPLOAD_MEDIA_BUTTON" });
  if (!upload?.ok) return upload;
  await chooseLocalFile(tabId, upload.x, upload.y, reference.localPath);

  const asset = await sendImageToFlowTab(tabId, { type: "FLOWX_GET_FRESH_UPLOADED_ASSET" });
  if (!asset?.ok) return asset;
  await clickAt(tabId, asset.x, asset.y);

  const confirmed = await addSelectedAssetToPrompt(tabId, asset.assetLocator || null, filenameHint);
  if (!confirmed?.ok) return confirmed;
  const latest = asset.assetLocator
    ? { assetLocator: asset.assetLocator }
    : await sendImageToFlowTab(tabId, { type: "FLOWX_GET_LATEST_PROMPT_ASSET_KEY" });
  await rememberCharacterAsset(cached.identity, latest?.assetLocator || null);
  return {
    ...confirmed,
    reusedProjectAsset: false,
    cachedAssetKey: latest?.assetLocator?.assetKey || "",
    cachedAssetLocator: Boolean(latest?.assetLocator),
  };
}

async function attachReferenceWithPicker(tabId, reference) {
  let lastResult = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    lastResult = await attachReferenceWithPickerOnce(tabId, reference);
    if (lastResult?.ok) return { ...lastResult, attachAttempt: attempt };
    await pressEscape(tabId).catch(() => {});
    await pause(900 + attempt * 500);
  }
  return {
    ...(lastResult || {}),
    ok: false,
    code: lastResult?.code || "FLOW_REF_ATTACH_FAILED",
    error: `${lastResult?.error || "Không gắn được ảnh nhân vật vào prompt"} Đã kiểm tra lại sau 2 lần.`,
  };
}

async function attachVideoIngredient(tabId, payload) {
  const sourceLocator = storedFlowAssetLocator(payload.sourceFlowAssetKey);
  const alreadyAttached = await sendImageToFlowTab(tabId, {
    type: "FLOWX_GET_ATTACHED_PROMPT_INGREDIENT",
    assetLocator: sourceLocator,
  });
  if (alreadyAttached?.ok && alreadyAttached.found) {
    return {
      ok: true,
      reusedProjectAsset: true,
      alreadyAttached: true,
      verification: "matching-ingredient-already-present",
    };
  }

  const add = await sendImageToFlowTab(tabId, { type: "FLOWX_GET_PROMPT_ADD_BUTTON" });
  if (!add?.ok) return add;
  await clickAt(tabId, add.x, add.y);

  const existing = await sendImageToFlowTab(tabId, {
    type: "FLOWX_GET_EXISTING_PROJECT_ASSET",
    assetLocator: sourceLocator,
  });
  if (existing?.ok && existing.found) {
    await clickAt(tabId, existing.x, existing.y);
    const addToPrompt = await sendImageToFlowTab(tabId, { type: "FLOWX_GET_ADD_TO_PROMPT_BUTTON" });
    if (!addToPrompt?.ok) return addToPrompt;
    await clickAt(tabId, addToPrompt.x, addToPrompt.y);
    const confirmed = await sendImageToFlowTab(tabId, {
      type: "FLOWX_CONFIRM_INGREDIENT_DROP",
      expectedCount: 1,
      assetLocator: existing.assetLocator || sourceLocator,
      filenameHint: localFileName(payload.sourceImagePath),
    });
    return confirmed?.ok ? { ...confirmed, reusedProjectAsset: true } : confirmed;
  }

  const upload = await sendImageToFlowTab(tabId, { type: "FLOWX_GET_UPLOAD_MEDIA_BUTTON" });
  if (!upload?.ok) return upload;
  await chooseLocalFile(tabId, upload.x, upload.y, payload.sourceImagePath);
  const asset = await sendImageToFlowTab(tabId, { type: "FLOWX_GET_FRESH_UPLOADED_ASSET" });
  if (!asset?.ok) return asset;
  await clickAt(tabId, asset.x, asset.y);
  const addToPrompt = await sendImageToFlowTab(tabId, { type: "FLOWX_GET_ADD_TO_PROMPT_BUTTON" });
  if (!addToPrompt?.ok) return addToPrompt;
  await clickAt(tabId, addToPrompt.x, addToPrompt.y);
  const confirmed = await sendImageToFlowTab(tabId, {
    type: "FLOWX_CONFIRM_INGREDIENT_DROP",
    expectedCount: 1,
    assetLocator: asset.assetLocator || null,
    filenameHint: localFileName(payload.sourceImagePath),
  });
  return confirmed?.ok ? { ...confirmed, reusedProjectAsset: false } : confirmed;
}

async function typeAndConfirmFlowPrompt(tabId, prepareType, text, jobId = "") {
  let lastResult = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (jobId) sendJobProgress(jobId, "preparing", `Đang dán prompt vào Flow · lần ${attempt}/3`);
    const target = await sendImageToFlowTab(tabId, { type: prepareType });
    if (!target?.ok) return target;
    await typePrompt(tabId, target.x, target.y, text);
    const filled = await sendImageToFlowTab(tabId, {
      type: "FLOWX_CONFIRM_PROMPT_TEXT",
      expectedText: text,
    });
    if (!filled?.ok) {
      lastResult = filled;
      if (jobId) {
        sendJobProgress(
          jobId,
          "preparing",
          `Prompt chưa nằm ổn định trong ô Flow (${Number(filled?.actualLength) || 0}/${Number(filled?.expectedLength) || text.length} ký tự); chưa gửi và sẽ thử lại`,
        );
      }
      await pause(900 + attempt * 350);
      continue;
    }
    if (jobId) {
      sendJobProgress(jobId, "preparing", `Đã xác nhận đủ ${Number(filled.actualLength) || text.length} ký tự trong ô prompt; đang bấm Gửi`);
    }
    await submitPrompt(tabId);
    lastResult = await sendImageToFlowTab(tabId, { type: "FLOWX_CONFIRM_SUBMIT" });
    if (lastResult?.ok) {
      return {
        ...lastResult,
        attempt,
        verifiedPromptLength: Number(filled.actualLength) || text.length,
        videoBaseline: Array.isArray(target.videoBaseline) ? target.videoBaseline : [],
      };
    }
    await pause(900 + attempt * 350);
  }
  return lastResult || {
    ok: false,
    code: "FLOW_SUBMIT_FAILED",
    error: "Google Flow không nhận prompt sau 3 lần thử.",
  };
}

async function typeAndSubmitFlowPromptDirectly(tabId, prepareType, text, jobId = "") {
  if (jobId) {
    sendJobProgress(
      jobId,
      "preparing",
      "Ảnh nhân vật đã xuất hiện trong ô prompt; đang dán prompt và Gửi ngay",
    );
  }
  const target = await sendImageToFlowTab(tabId, { type: prepareType });
  if (!target?.ok) return target;
  await typeAndSubmit(tabId, target.x, target.y, text);
  return {
    ok: true,
    attempt: 1,
    verification: "debugger-type-and-submit-dispatched",
    videoBaseline: Array.isArray(target.videoBaseline) ? target.videoBaseline : [],
  };
}

async function openLatestViewerWithRetries(tabId, jobId) {
  const deadline = Date.now() + 600_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    if (isJobStopped(jobId)) {
      return { ok: false, stopped: true, code: "STOPPED", error: "Đã dừng vòng lặp mở card video Flow." };
    }
    const attemptStartedAt = Date.now();
    attempt += 1;
    try {
      const before = await sendImageToFlowTab(tabId, { type: "FLOWX_CHECK_VIDEO_VIEWER" });
      if (before?.viewerOpen) {
        // A viewer that existed before we clicked the card selected for this
        // prompt belongs to an older render. Close it without attributing its
        // success or failure to the current scene.
        await sendImageToFlowTab(tabId, { type: "FLOWX_CLOSE_VIDEO_VIEWER" });
        await pause(250);
      }
      const clicked = await sendImageToFlowTab(tabId, {
        type: "FLOWX_CLICK_ACTIVE_RENDER_VIDEO",
      });
      if (clicked?.error && (clicked.code === "FLOW_POLICY_VIOLATION" || clicked.code === "FLOW_GENERATION_FAILED")) {
        return clicked;
      }
      const openedViewerFailure = await sendImageToFlowTab(tabId, {
        type: "FLOWX_CHECK_AND_CLOSE_FAILED_VIDEO_VIEWER",
      });
      if (openedViewerFailure?.viewerFailure) return openedViewerFailure;
      const after = await sendImageToFlowTab(tabId, { type: "FLOWX_CHECK_VIDEO_VIEWER" });
      sendJobProgress(
        jobId,
        "generating",
        `Đang thử mở đúng ô video render · lần ${attempt}${clicked?.cardFound === false ? " · chưa thấy ô %" : ` · ${Number(clicked?.progress) || 0}%`}`,
      );
      if (after?.viewerOpen) return { ok: true, attempts: attempt };
    } catch (error) {
      if (error?.code === "FLOW_POLICY_VIOLATION" || error?.code === "FLOW_GENERATION_FAILED") {
        return {
          ok: false,
          code: error.code,
          error: String(error.message || error),
          policyViolation: error.policyViolation === true,
        };
      }
      sendJobProgress(jobId, "generating", `Lần ${attempt} chưa mở được card render: ${String(error?.message || error)}`);
    }
    await pause(Math.max(0, 2_000 - (Date.now() - attemptStartedAt)));
  }
  return { ok: false, timeout: true, code: "TIMEOUT", error: "Không mở được card video Flow sau 10 phút thử mỗi 2 giây." };
}

async function waitForFlowVideoIdle(tabId, jobId) {
  const deadline = Date.now() + 600_000;
  let stableIdlePolls = 0;
  let lastProgressAt = 0;
  while (Date.now() < deadline) {
    if (isJobStopped(jobId)) {
      return { ok: false, stopped: true, code: "STOPPED", error: "Đã dừng trong khi chờ Google Flow rảnh." };
    }
    const state = await sendImageToFlowTab(tabId, { type: "FLOWX_GET_VIDEO_RENDER_ACTIVITY" });
    if (!state?.ok) return state;
    const activeCount = Number(state.activeRenderCount) || 0;
    if (activeCount === 0) {
      stableIdlePolls += 1;
      if (stableIdlePolls >= 2) return { ok: true };
    } else {
      stableIdlePolls = 0;
      if (Date.now() - lastProgressAt >= 6_000) {
        lastProgressAt = Date.now();
        const values = Array.isArray(state.progressValues) ? state.progressValues.join("%, ") : "";
        sendJobProgress(
          jobId,
          "preparing",
          `Google Flow còn ${activeCount} video đang render${values ? ` (${values}%)` : ""}; chưa dán prompt scene mới để tránh chạy chồng`,
        );
      }
    }
    await pause(2_000);
  }
  return {
    ok: false,
    code: "FLOW_RENDER_BUSY",
    error: "Google Flow vẫn còn video đang render sau 10 phút; chưa gửi prompt mới để tránh tạo hai video cùng lúc.",
  };
}

async function waitForFlowVideo(tabId, videoBaseline, jobId) {
  const deadline = Date.now() + 600_000;
  const baseline = Array.isArray(videoBaseline) ? videoBaseline.slice(0, 2_000) : [];
  let stableIdentity = "";
  let stablePolls = 0;
  let lastProgressAt = 0;

  while (Date.now() < deadline) {
    if (isJobStopped(jobId)) {
      return { ok: false, stopped: true, code: "STOPPED", error: "Đã dừng chờ video Google Flow." };
    }
    let check;
    try {
      check = await sendImageToFlowTab(tabId, {
        type: "FLOWX_CHECK_NEW_VIDEO",
        videoBaseline: baseline,
      });
    } catch (error) {
      // A short poll can safely recover after a Flow reload/content-script
      // reinjection; unlike the old ten-minute message it holds no fragile port.
      stableIdentity = "";
      stablePolls = 0;
      if (Date.now() - lastProgressAt >= 10_000) {
        lastProgressAt = Date.now();
        sendJobProgress(jobId, "generating", `Đang nối lại bộ dò video: ${String(error?.message || error)}`);
      }
      await pause(2_000);
      continue;
    }
    if (!check?.ok) return check;
    if (check.found && typeof check.src === "string" && check.src) {
      const identity = String(check.identity || check.src);
      if (identity === stableIdentity) {
        stablePolls += 1;
      } else {
        stableIdentity = identity;
        stablePolls = 1;
      }
      if (stablePolls >= 2) {
        return { ok: true, src: check.src, identity };
      }
    } else {
      stableIdentity = "";
      stablePolls = 0;
    }
    if (Date.now() - lastProgressAt >= 15_000) {
      lastProgressAt = Date.now();
      sendJobProgress(
        jobId,
        "generating",
        `Vẫn đang chờ đúng video mới từ Flow; thấy ${Number(check.visibleVideos) || 0} video, loại ${Number(check.rejectedVideos) || 0} kết quả cũ`,
      );
    }
    await pause(2_000);
  }
  return {
    ok: false,
    timeout: true,
    code: "TIMEOUT",
    error: "Google Flow không xuất hiện video mới trong 10 phút.",
  };
}

async function ensureFreeNanoBananaPro(tabId) {
  // Close a stale model popup left behind by an interrupted/older job.
  await pressEscape(tabId).catch(() => {});
  await pause(150);
  const picker = await sendImageToFlowTab(tabId, { type: "FLOWX_GET_IMAGE_MODEL_PICKER" });
  if (!picker?.ok) return picker;
  // Flow sometimes hides the selected model label behind an icon-only control.
  // Continue with the account's current image preset instead of blocking the job
  // on a DOM label that Flow does not expose.
  if (picker.pickerUnavailable) {
    return {
      ok: true,
      model: "account-image-preset",
      credits: "not-exposed-in-dom",
      verification: "picker-not-exposed",
    };
  }
  if (/nano\s*banana\s*pro/i.test(String(picker.label || ""))) {
    return {
      ok: true,
      model: "nano-banana-pro",
      credits: "account-preset",
    };
  }

  let popupOpen = false;
  let completed = false;
  try {
    await clickAt(tabId, picker.x, picker.y);
    popupOpen = true;

    const option = await sendImageToFlowTab(tabId, { type: "FLOWX_GET_NANO_BANANA_PRO_OPTION" });
    if (!option?.ok) return option;
    await clickAt(tabId, option.x, option.y);

    const confirmed = await sendImageToFlowTab(tabId, { type: "FLOWX_CONFIRM_NANO_BANANA_PRO" });
    completed = confirmed?.ok === true;
    return confirmed;
  } finally {
    if (popupOpen && !completed) {
      await pressEscape(tabId).catch(() => {});
    }
  }
}

async function generateFlowImage(tabId, payload, jobId) {
  const cleared = await sendImageToFlowTab(tabId, { type: "FLOWX_CLEAR_PROMPT_MEDIA" });
  if (!cleared?.ok) return cleared;
  if (cleared.removed > 0) {
    sendJobProgress(jobId, "preparing", `Đã gỡ ${cleared.removed} ảnh cũ khỏi prompt trước khi tạo scene độc lập`);
  }
  const modelReady = await ensureFreeNanoBananaPro(tabId);
  if (!modelReady?.ok) return modelReady;

  for (const reference of payload.refImages) {
    const attached = await attachReferenceWithPicker(tabId, reference);
    if (!attached?.ok) return attached;
    sendJobProgress(
      jobId,
      "preparing",
      attached.alreadyAttached
        ? `${reference.token}: ảnh nhân vật đã có trong prompt`
        : attached.reusedProjectAsset
          ? `${reference.token}: đã chọn lại ảnh nhân vật có sẵn trong thư viện Flow`
          : `${reference.token}: đã upload ảnh nhân vật lần đầu và lưu vị trí để tái sử dụng`,
    );
  }

  const imagePrompt = promptWithReferences(payload);
  const submitted = payload.refImages.length > 0
    ? await typeAndSubmitFlowPromptDirectly(
      tabId,
      "FLOWX_PREPARE_PROMPT",
      imagePrompt,
      jobId,
    )
    : await typeAndConfirmFlowPrompt(
      tabId,
      "FLOWX_PREPARE_PROMPT",
      imagePrompt,
      jobId,
    );
  if (!submitted?.ok) return submitted;
  sendJobProgress(jobId, "generating", "Đã gửi prompt; Google Flow đang tạo ảnh scene");
  const image = await sendImageToFlowTab(tabId, { type: "WAIT_IMAGE" });
  if (!image?.ok) return image;

  const converted = await sendImageToFlowTab(tabId, { type: "TODATAURL", src: image.src });
  return {
    ok: true,
    src: image.src,
    dataUrl: typeof converted?.dataUrl === "string" ? converted.dataUrl : null,
    flowAssetKey: storedFlowAssetIdentity(image),
  };
}

function videoPromptFromComponent(payload) {
  const stickFigureMode = isStickFigureStyle(payload.visualBible?.style);
  const sections = [
    "USE THE ATTACHED SCENE IMAGE AS THE PRIMARY VIDEO INGREDIENT.",
    "Preserve the exact characters, proportions, clothing, colors, objects, environment, framing, and graphic style visible in the attached image. Animate this same scene; do not redesign it or introduce a new subject.",
    `Create one continuous ${payload.videoSettings.durationSeconds}-second 16:9 shot. Follow only this motion direction:`,
    stripConflictingRenderPhrases(payload.prompt),
    [
      "MOTION STABILITY LOCK — HIGH PRIORITY:",
      "Use one slow primary action per character and one slow camera move. Preserve the opening silhouette and body topology throughout the shot.",
      "No extra, missing, fused, duplicated, stretched, or detached limbs; no body morphing; no full-body spins; no crossed limbs; no hands passing behind the torso; no complex finger motion; no sudden pose changes; no subject replacement.",
      "Keep hands separated from the torso and other limbs, keep joint connections visible, and finish in the stable END FRAME described above.",
    ].join("\n"),
  ];
  if (stickFigureMode) {
    sections.push([
      "STICK-FIGURE JOINT LOCK:",
      "Each character must keep exactly one circular head, one torso line, two arms connected only at the shoulders, and two legs connected only at the hips for every frame.",
      "Animate with small joint-consistent rotations and short translation only. Keep line length, line thickness, head size, facial marks, and clothing-color shapes unchanged. Never turn a limb into a branch or merge one arm with the body, prop, or another character.",
    ].join("\n"));
  }
  return sections.join("\n\n");
}

function videoPromptFromFrames(payload) {
  const stickFigureMode = isStickFigureStyle(payload.visualBible?.style);
  return [
    "USE THE ATTACHED START FRAME AND END FRAME AS HARD VISUAL BOUNDARIES.",
    `Create one continuous ${payload.videoSettings.durationSeconds}-second 16:9 transition from the exact Start frame to the exact End frame. Preserve character identity, proportions, clothing, colors, line style, environment, lighting, and camera continuity. Do not replace or redesign any subject.`,
    `MOTION DIRECTION:\n${stripConflictingRenderPhrases(payload.prompt)}`,
    [
      "MOTION STABILITY LOCK — HIGH PRIORITY:",
      "Use the smallest natural movement needed to connect both frames. Keep body topology and object count fixed. No extra, missing, fused, duplicated, stretched, detached, or morphing limbs; no sudden pose or camera jump.",
      stickFigureMode
        ? "Every person remains one circular head, one torso line, two arms connected at the shoulders, and two legs connected at the hips. Use small joint-consistent rotations only."
        : "Preserve anatomy and silhouettes throughout the interpolation.",
    ].join("\n"),
  ].join("\n\n");
}

function videoPromptFromText(payload) {
  const stickFigureMode = isStickFigureStyle(payload.visualBible?.style);
  const sections = [
    "TEXT-TO-VIDEO: CREATE THE VIDEO DIRECTLY FROM THIS PROMPT. NO SOURCE IMAGE IS ATTACHED.",
    `Create one complete ${payload.videoSettings.durationSeconds}-second landscape 16:9 shot using the scene description and motion direction below. Do not ask for an image; render the scene directly from text.`,
    payload.visualBible?.style
      ? `VISUAL STYLE:\n${payload.visualBible.style}`
      : "",
    payload.visualBible?.palette
      ? `PALETTE:\n${payload.visualBible.palette}`
      : "",
    payload.visualBible?.lighting
      ? `LIGHTING:\n${payload.visualBible.lighting}`
      : "",
    payload.visualBible?.continuityNotes
      ? `CONTINUITY NOTES:\n${payload.visualBible.continuityNotes}`
      : "",
    `SCENE AND MOTION:\n${stripConflictingRenderPhrases(payload.prompt)}`,
    [
      "OUTPUT LOCK:",
      "One continuous shot, no cuts, no captions, no subtitles, no interface, no watermarks beyond the provider's mandatory provenance mark.",
      "Use a stable composition, readable subject silhouettes, natural real-time motion, and a clear final frame.",
    ].join("\n"),
    videoPacingLock(payload.videoSettings.durationSeconds),
  ].filter(Boolean);
  if (stickFigureMode) {
    sections.push([
      "STICK-FIGURE MOTION LOCK:",
      "Each character remains one circular head, one torso line, two arms connected at the shoulders, and two legs connected at the hips in every frame.",
      "Use small joint-consistent rotations and short translation only. Keep line length, line thickness, head size, facial marks, and clothing-color shapes stable.",
    ].join("\n"));
  }
  return sections.join("\n\n");
}

function videoPromptFromFirstFrame(payload) {
  const stickFigureMode = isStickFigureStyle(payload.visualBible?.style);
  const sections = [
    "USE THE ATTACHED IMAGE AS THE EXACT OPENING FRAME, THEN ANIMATE FORWARD FROM IT.",
    "Preserve the characters, proportions, clothing, colors, objects, environment, composition, and graphic style already visible in the opening frame. Do not redesign or replace any subject.",
    `Create one continuous ${payload.videoSettings.durationSeconds}-second 16:9 cinematic shot. Follow this visible action direction:`,
    stripConflictingRenderPhrases(payload.prompt),
    [
      "NATURAL MOTION AND ANATOMY — HIGH PRIORITY:",
      "Stage one coherent visible action with clear main movement and immediate reaction. Add anticipation or follow-through only when the duration budget below permits it. Use natural acceleration and deceleration, visible weight transfer, balanced foot placement, and secondary overlap in the head, torso, clothing, and nearby environment.",
      "Choose a purposeful camera move that supports the action at an appropriate speed; keep it static when movement would weaken the shot. Preserve body topology and object count throughout. Keep joints connected and silhouettes readable; do not fuse, duplicate, detach, stretch, or morph limbs.",
    ].join("\n"),
    videoPacingLock(payload.videoSettings.durationSeconds),
  ];
  if (stickFigureMode) {
    sections.push([
      "STICK-FIGURE MOTION LOCK:",
      "Each character remains one circular head, one torso line, two arms connected at the shoulders, and two legs connected at the hips in every frame.",
      "Animate coordinated shoulder, elbow, hip, and knee arcs with clear weight transfer and follow-through. Keep line length, line thickness, head size, facial marks, and clothing-color shapes unchanged; keep hands and limbs visually separated during motion.",
    ].join("\n"));
  }
  return sections.join("\n\n");
}

async function openFlowVideoSettingsPopup(tabId) {
  await pressEscape(tabId).catch(() => {});
  await pause(350);
  const picker = await sendImageToFlowTab(tabId, { type: "FLOWX_GET_VIDEO_SETTINGS_PICKER" });
  if (!picker?.ok) return picker;
  await clickAt(tabId, picker.x, picker.y);
  // Keep the popup visible long enough for Radix to finish rendering and for
  // the operator to see which control is about to be selected.
  await pause(1100);
  return {
    ok: true,
    pickerLabel: picker.label || "",
    identity: picker.identity || "",
  };
}

async function configureFlowVideoSettings(tabId, payload, jobId) {
  const mode = payload.videoSettings?.mode === "ingredients" ||
    payload.videoSettings?.mode === "text-to-video"
    ? "ingredients"
    : "frames";
  const durationSeconds = [4, 6, 8].includes(Number(payload.videoSettings?.durationSeconds))
    ? Number(payload.videoSettings.durationSeconds)
    : 8;
  let lastResult = null;
  let failedStep = "mở popup";

  // Mode, ratio, and duration are tabs inside one Flow popup. Configure all
  // three during the same opening so a later coordinate lookup cannot hit the
  // top-level IMAGE tab after the prompt layout changes to Frames.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    sendJobProgress(jobId, "preparing", `Cấu hình video: mở popup duy nhất (lần ${attempt}/2)`);
    const opened = await openFlowVideoSettingsPopup(tabId);
    if (!opened?.ok) {
      lastResult = opened;
      failedStep = "mở popup Video";
      continue;
    }
    sendJobProgress(
      jobId,
      "preparing",
      `Đã mở popup Video [${opened.identity || opened.pickerLabel || "Video"}]`,
    );

    const modeName = mode === "frames" ? "Khung hình" : "Thành phần";
    sendJobProgress(jobId, "preparing", `Cấu hình video 1/3: chọn ${modeName}`);
    const modeOption = await sendImageToFlowTab(tabId, {
      type: "FLOWX_GET_VIDEO_GENERATION_MODE",
      mode,
    });
    if (!modeOption?.ok) {
      lastResult = modeOption;
      failedStep = `chọn ${modeName}`;
      await pause(3000);
      continue;
    }
    sendJobProgress(
      jobId,
      "preparing",
      `Đã tìm thấy ${modeName}: ${modeOption.label || modeName} [${modeOption.identity || "không có id"}]`,
    );
    if (!modeOption.alreadySelected) {
      await clickAt(tabId, modeOption.x, modeOption.y);
      await pause(900);
    }
    const modeConfirmed = await sendImageToFlowTab(tabId, {
      type: "FLOWX_CONFIRM_VIDEO_GENERATION_MODE",
      mode,
    });
    if (!modeConfirmed?.ok) {
      lastResult = modeConfirmed;
      failedStep = `xác nhận ${modeName}`;
      await pause(3000);
      continue;
    }

    sendJobProgress(jobId, "preparing", "Cấu hình video 2/3: chọn 16:9 trong cùng popup");
    const aspect = await sendImageToFlowTab(tabId, { type: "FLOWX_GET_VIDEO_ASPECT_RATIO" });
    if (!aspect?.ok) {
      lastResult = aspect;
      failedStep = "tìm tỷ lệ 16:9";
      await pause(3000);
      continue;
    }
    sendJobProgress(
      jobId,
      "preparing",
      `Đã tìm thấy 16:9 [${aspect.identity || aspect.label || "LANDSCAPE"}]`,
    );
    if (!aspect.alreadySelected) await clickAt(tabId, aspect.x, aspect.y);
    const aspectConfirmed = await sendImageToFlowTab(tabId, { type: "FLOWX_CONFIRM_VIDEO_ASPECT_RATIO" });
    if (!aspectConfirmed?.ok) {
      lastResult = aspectConfirmed;
      failedStep = "xác nhận tỷ lệ 16:9";
      await pause(3000);
      continue;
    }

    sendJobProgress(jobId, "preparing", `Cấu hình video 3/3: chọn ${durationSeconds}s trong cùng popup`);
    const duration = await sendImageToFlowTab(tabId, {
      type: "FLOWX_GET_VIDEO_DURATION",
      durationSeconds,
    });
    if (!duration?.ok) {
      lastResult = duration;
      failedStep = `tìm thời lượng ${durationSeconds}s`;
      await pause(3000);
      continue;
    }
    sendJobProgress(
      jobId,
      "preparing",
      `Đã tìm thấy ${durationSeconds}s [${duration.identity || duration.label || `${durationSeconds}s`}]`,
    );
    if (!duration.alreadySelected) await clickAt(tabId, duration.x, duration.y);
    const durationConfirmed = await sendImageToFlowTab(tabId, {
      type: "FLOWX_CONFIRM_VIDEO_DURATION",
      durationSeconds,
    });
    if (!durationConfirmed?.ok) {
      lastResult = durationConfirmed;
      failedStep = `xác nhận thời lượng ${durationSeconds}s`;
      await pause(3000);
      continue;
    }

    await pressEscape(tabId).catch(() => {});
    sendJobProgress(
      jobId,
      "preparing",
      `Đã khóa Video: ${modeName} · 16:9 · ${durationSeconds}s chỉ trong một lần mở popup`,
    );
    return { ok: true, mode, aspectRatio: "16:9", durationSeconds };
  }

  return {
    ...(lastResult || {}),
    ok: false,
    code: lastResult?.code || "FLOW_VIDEO_SETTINGS_FAILED",
    error: `Cấu hình Video thất bại ở bước ${failedStep} sau 2 lần. ${lastResult?.error || "Flow không trả về phần tử hoặc trạng thái cần chọn."}`,
  };
}

async function attachStartFrameWithPicker(tabId, localPath, assetKey = "") {
  return attachFrameWithPicker(tabId, localPath, "start", assetKey);
}

async function attachFrameWithPicker(tabId, localPath, position, assetKey = "") {
  const frame = await sendImageToFlowTab(tabId, {
    type: position === "end" ? "FLOWX_GET_END_FRAME_BUTTON" : "FLOWX_GET_START_FRAME_BUTTON",
  });
  if (!frame?.ok) return frame;
  await clickAt(tabId, frame.x, frame.y);

  const assetLocator = storedFlowAssetLocator(assetKey);
  if (assetLocator) {
    const existing = await sendImageToFlowTab(tabId, {
      type: "FLOWX_GET_EXISTING_PROJECT_ASSET",
      assetLocator,
      filenameHint: localFileName(localPath),
    });
    if (existing?.ok && existing.found) {
      await clickAt(tabId, existing.x, existing.y);
      const apply = await sendImageToFlowTab(tabId, { type: "FLOWX_GET_FRAME_APPLY_BUTTON" });
      if (apply?.ok && !apply.unavailable) {
        await clickAt(tabId, apply.x, apply.y);
      }
      const confirmed = await sendImageToFlowTab(tabId, {
        type: position === "end" ? "FLOWX_CONFIRM_END_FRAME" : "FLOWX_CONFIRM_START_FRAME",
      });
      return confirmed?.ok ? { ...confirmed, reusedProjectAsset: true } : confirmed;
    }
  }

  const upload = await sendImageToFlowTab(tabId, { type: "FLOWX_GET_UPLOAD_MEDIA_BUTTON" });
  if (!upload?.ok) return upload;
  await chooseLocalFile(tabId, upload.x, upload.y, localPath);

  const asset = await sendImageToFlowTab(tabId, { type: "FLOWX_GET_FRESH_UPLOADED_ASSET" });
  if (!asset?.ok) return asset;
  await clickAt(tabId, asset.x, asset.y);

  const apply = await sendImageToFlowTab(tabId, { type: "FLOWX_GET_FRAME_APPLY_BUTTON" });
  if (apply?.ok && !apply.unavailable) {
    await clickAt(tabId, apply.x, apply.y);
  }
  const confirmed = await sendImageToFlowTab(tabId, {
    type: position === "end" ? "FLOWX_CONFIRM_END_FRAME" : "FLOWX_CONFIRM_START_FRAME",
  });
  return confirmed?.ok ? { ...confirmed, reusedProjectAsset: false } : confirmed;
}

async function generateFlowVideo(tabId, payload, jobId) {
  await pressEscape(tabId).catch(() => {});
  await pause(150);
  const idle = await waitForFlowVideoIdle(tabId, jobId);
  if (!idle?.ok) return idle;
  const cleared = await sendImageToFlowTab(tabId, { type: "FLOWX_CLEAR_PROMPT_MEDIA" });
  if (!cleared?.ok) return cleared;
  if (cleared.removed > 0) {
    sendJobProgress(jobId, "preparing", `Đã gỡ ${cleared.removed} ảnh cũ khỏi prompt Video`);
  }
  const configured = await configureFlowVideoSettings(tabId, payload, jobId);
  if (!configured?.ok) return configured;
  await pressEscape(tabId).catch(() => {});

  if (payload.videoSettings.mode === "text-to-video") {
    sendJobProgress(
      jobId,
      "preparing",
      "Đang tạo video trực tiếp từ prompt trên Google Flow; không gắn ảnh mở đầu",
    );
  } else if (payload.videoSettings.mode === "first-frame") {
    const startAttached = await attachStartFrameWithPicker(
      tabId,
      payload.sourceImagePath,
      payload.sourceFlowAssetKey,
    );
    if (!startAttached?.ok) return startAttached;
    sendJobProgress(
      jobId,
      "preparing",
      startAttached.reusedProjectAsset
        ? "Đã chọn ảnh scene có sẵn trong thư viện Flow làm Start frame; không dùng End frame"
        : "Không tìm thấy ảnh scene trong thư viện Flow nên đã import từ máy làm Start frame; không dùng End frame",
    );
  } else if (payload.videoSettings.mode === "frames") {
    const startAttached = await attachStartFrameWithPicker(tabId, payload.startFramePath);
    if (!startAttached?.ok) return startAttached;
    const endAttached = await attachFrameWithPicker(tabId, payload.sourceImagePath, "end");
    if (!endAttached?.ok) return endAttached;
    sendJobProgress(jobId, "preparing", "Đã gắn frame cuối clip trước và ảnh scene hiện tại vào Start/End frame");
  } else {
    const attached = await attachVideoIngredient(tabId, payload);
    if (!attached?.ok) return attached;
    sendJobProgress(
      jobId,
      "preparing",
      attached.alreadyAttached
        ? "Ảnh scene đã có sẵn trong Thành phần; tiếp tục dán prompt video"
        : attached.reusedProjectAsset
          ? "Đã chọn lại ảnh scene có sẵn trong project Flow"
          : "Đã dùng file ảnh scene trên máy làm Thành phần",
    );
    if ((payload.refImages || []).length > 0) {
      sendJobProgress(
        jobId,
        "preparing",
        "Video chỉ dùng ảnh scene đã duyệt; không gắn lại ảnh nhân vật vì nhân vật đã nằm trong scene",
      );
    }
  }

  const submitted = await typeAndConfirmFlowPrompt(
    tabId,
    "FLOWX_PREPARE_VIDEO_PROMPT",
    payload.videoSettings.mode === "first-frame"
      ? videoPromptFromFirstFrame(payload)
      : payload.videoSettings.mode === "frames"
        ? videoPromptFromFrames(payload)
        : payload.videoSettings.mode === "text-to-video"
          ? videoPromptFromText(payload)
          : videoPromptFromComponent(payload),
    jobId,
  );
  if (!submitted?.ok) return submitted;
  if (payload.videoSettings?.delivery === "submit-only") {
    sendJobProgress(
      jobId,
      "generating",
      "Đã gửi prompt lên Google Flow; bỏ qua chờ render và tải file theo chế độ nhanh",
    );
    return {
      ok: true,
      submitted: true,
      submittedAt: new Date().toISOString(),
      videoBaseline: submitted.videoBaseline || [],
    };
  }
  sendJobProgress(
    jobId,
    "generating",
    `Đã gửi prompt; Google Flow đang tạo video ${payload.videoSettings.durationSeconds} giây`,
  );

  sendJobProgress(jobId, "generating", "Bắt đầu dò ô video có phần trăm ngay sau khi gửi prompt; thử lại mỗi 2 giây");
  const viewerOpened = await openLatestViewerWithRetries(tabId, jobId);
  if (viewerOpened?.ok) {
    try {
      const resultPath = await downloadNewestVideoThroughFlow(
        tabId,
        submitted.videoBaseline,
        payload,
        jobId,
        true,
      );
      return { ok: true, resultPath };
    } catch (error) {
      if (error?.code === "FLOW_POLICY_VIOLATION" || error?.code === "FLOW_GENERATION_FAILED") {
        return {
          ok: false,
          code: error.code,
          error: String(error.message || error),
          policyViolation: error.policyViolation === true,
          viewerClosed: true,
        };
      }
      return {
        ok: false,
        code: "FLOW_NATIVE_DOWNLOAD_FAILED",
        error: `Flow đã được yêu cầu tải video nhưng Chrome chưa xác nhận file: ${String(error?.message || error)}. App không tải lại bằng URL để tránh tạo hai bản video.`,
      };
    }
  }
  return viewerOpened || {
    ok: false,
    code: "FLOW_VIDEO_VIEWER_FAILED",
    error: "Không mở được viewer video Google Flow.",
  };
}

async function handleTimelineJob(message, sourceConnection) {
  const { jobId, action, payload } = message;
  const rewritingPolicy = action === "REWRITE_POLICY_PROMPT";
  if (typeof jobId !== "string" || (action !== "GENERATE_TIMELINE" && !rewritingPolicy)) {
    if (typeof jobId === "string") {
      sendJobError(jobId, "Unsupported or malformed job", "INVALID_JOB");
    }
    return;
  }
  const role = sourceConnection?.registration?.role;
  const provider = TEXT_WORKER_BY_ROLE[role];
  if (!provider) {
    sendJobError(jobId, `${action} requires a text-provider worker`, "WRONG_ROLE");
    return;
  }
  if (!sourceConnection?.registration?.capabilities?.includes(action)) {
    sendJobError(jobId, `${provider.label} worker did not register ${action}`, "WRONG_ROLE");
    return;
  }
  if (activeJobForConnection(sourceConnection)) {
    sendJobError(jobId, "Worker is already processing another job", "INVALID_JOB");
    return;
  }
  if (rewritingPolicy ? !isPolicyRewritePayload(payload) : !isTimelinePayload(payload)) {
    sendJobError(jobId, rewritingPolicy ? "Prompt sửa chính sách không hợp lệ" : "SRT and script text are required", "INVALID_JOB");
    return;
  }

  const tab = await tabForConnection(sourceConnection, role, findTextProviderTab);
  if (!tab?.id) {
    sendJobError(
      jobId,
      `Không tìm thấy tab ${provider.label} trong Chrome profile này`,
      "NOT_LOGGED_IN",
      true,
    );
    return;
  }

  const currentTab = await chrome.tabs.get(tab.id);
  if (!provider.urlPattern.test(currentTab.url || "")) {
    sendJobError(
      jobId,
      `Tab đích không còn là ${provider.label}. Hãy tải lại trang ${provider.label} rồi thử lại.`,
      "NOT_LOGGED_IN",
      true,
    );
    return;
  }

  const job = { kind: "timeline", jobId, tabId: tab.id, stopping: false, connection: sourceConnection };
  setActiveJob(job);
  startActiveJobHeartbeat(jobId);
  sendJobProgress(
    jobId,
    "preparing",
    rewritingPolicy
      ? `Đang chuẩn bị sửa prompt ${payload.sceneId} với ${provider.label}`
      : `Đang chuẩn bị yêu cầu cho ${provider.label}`,
  );

  try {
    const response = await sendTextWorkerMessage(tab.id, {
      type: rewritingPolicy ? "FLOWX_REWRITE_POLICY_PROMPT" : "FLOWX_GENERATE_TIMELINE",
      jobId,
      tabId: tab.id,
      payload,
    });

    if (!isCurrentJob(job)) return;
    if (!response?.ok) {
      sendJobError(
        jobId,
        response?.error || `${provider.label} content worker failed`,
        response?.code || "INTERNAL_ERROR",
        response?.retryable === true,
      );
      return;
    }

    jobConnection(job)?.send({ type: "JOB_DONE", jobId, result: response.result });
  } catch (error) {
    if (isCurrentJob(job)) {
      sendJobError(
        jobId,
        String(error?.message || error),
        job.stopping ? "STOPPED" : "INTERNAL_ERROR",
        !job.stopping,
      );
    }
  } finally {
    clearActiveJob(job);
    await detachDebugger(job.tabId);
  }
}

async function handleChatGptImageJob(message, sourceConnection) {
  const { jobId, action, payload } = message;
  if (typeof jobId !== "string" || action !== "GENERATE_CHATGPT_IMAGE") {
    if (typeof jobId === "string") sendJobError(jobId, "Unsupported ChatGPT image job", "INVALID_JOB");
    return;
  }
  if (sourceConnection?.registration?.role !== "chat-worker") {
    sendJobError(jobId, `${action} requires chat-worker`, "WRONG_ROLE");
    return;
  }
  if (activeJobForConnection(sourceConnection)) {
    sendJobError(jobId, "Worker is already processing another job", "INVALID_JOB");
    return;
  }
  if (!isSceneJobPayload(payload) || payload.mediaType !== "image") {
    sendJobError(jobId, "Scene image job payload is invalid", "INVALID_JOB");
    return;
  }
  if (!validReferenceImages(payload.refImages)) {
    sendJobError(jobId, "Danh sách ảnh tham chiếu không hợp lệ", "INVALID_JOB");
    return;
  }

  const tab = await tabForConnection(sourceConnection, "chat-worker", () => findChatGptTab());
  if (!tab?.id) {
    sendJobError(
      jobId,
      "Không tìm thấy tab ChatGPT trong Chrome profile này",
      "NOT_LOGGED_IN",
      true,
    );
    return;
  }

  const currentTab = await chrome.tabs.get(tab.id);
  if (!/^https:\/\/chatgpt\.com\//i.test(currentTab.url || "")) {
    sendJobError(
      jobId,
      "Tab đích không còn là ChatGPT. Hãy tải lại trang ChatGPT rồi thử lại.",
      "NOT_LOGGED_IN",
      true,
    );
    return;
  }

  const job = { kind: "chat-image", jobId, tabId: tab.id, stopping: false, connection: sourceConnection };
  setActiveJob(job);
  startActiveJobHeartbeat(jobId);
  sendJobProgress(jobId, "preparing", `Đang chuẩn bị tạo ảnh scene ${payload.sceneId} bằng ChatGPT`);

  try {
    const response = await sendTextWorkerMessage(tab.id, {
      type: "FLOWX_GENERATE_CHATGPT_IMAGE",
      jobId,
      tabId: tab.id,
      payload,
    });

    if (!isCurrentJob(job) || job.stopping) return;
    if (!response?.ok) {
      sendJobError(
        jobId,
        response?.error || "ChatGPT image content worker failed",
        response?.code || "INTERNAL_ERROR",
        response?.retryable === true,
      );
      return;
    }

    sendJobProgress(jobId, "downloading", "Đang lưu ảnh ChatGPT vào Downloads/Vyren AI");
    const resultPath = response.resultPath || await downloadChatGptImage(response.result || response, payload);
    if (!isCurrentJob(job) || job.stopping) return;
    jobConnection(job)?.send({
      type: "JOB_DONE",
      jobId,
      result: {
        sceneId: payload.sceneId,
        mediaType: "image",
        resultPath,
        flowAssetKey: "",
      },
    });
  } catch (error) {
    if (isCurrentJob(job)) {
      sendJobError(jobId, String(error?.message || error), job.stopping ? "STOPPED" : "INTERNAL_ERROR", !job.stopping);
    }
  } finally {
    clearActiveJob(job);
    await detachDebugger(job.tabId);
  }
}

async function handleProviderMediaJob(message, sourceConnection) {
  const { jobId, action, payload } = message;
  if (
    typeof jobId !== "string" ||
    (action !== "GENERATE_PROVIDER_IMAGE" && action !== "GENERATE_PROVIDER_VIDEO")
  ) {
    if (typeof jobId === "string") {
      sendJobError(jobId, "Unsupported Gemini/Grok media job", "INVALID_JOB");
    }
    return;
  }
  const role = sourceConnection?.registration?.role;
  if (role !== "gemini-worker" && role !== "grok-worker" && role !== "capcut-worker") {
    sendJobError(jobId, `${action} requires gemini-worker, grok-worker, or capcut-worker`, "WRONG_ROLE");
    return;
  }
  if (!sourceConnection?.registration?.capabilities?.includes(action)) {
    sendJobError(jobId, `${role} did not register ${action}`, "WRONG_ROLE");
    return;
  }
  if (activeJobForConnection(sourceConnection)) {
    sendJobError(jobId, "Worker is already processing another job", "INVALID_JOB");
    return;
  }
  const mediaType = action === "GENERATE_PROVIDER_IMAGE" ? "image" : "video";
  if (!isSceneJobPayload(payload) || payload.mediaType !== mediaType) {
    sendJobError(jobId, "Provider media payload is invalid", "INVALID_JOB");
    return;
  }
  if (!validReferenceImages(payload.refImages)) {
    sendJobError(jobId, "Danh sách ảnh tham chiếu không hợp lệ", "INVALID_JOB");
    return;
  }
  if (
    mediaType === "video" &&
    payload.videoSettings?.mode !== "text-to-video" &&
    !validReferenceImages([payload.sourceImage])
  ) {
    sendJobError(jobId, "Ảnh nguồn video không hợp lệ", "INVALID_JOB");
    return;
  }

  const expectedProvider = role === "gemini-worker"
    ? mediaType === "image" ? "gemini-image" : "gemini-video"
    : role === "grok-worker"
      ? mediaType === "image" ? "grok-image" : "grok-video"
      : "capcut-video";
  const requestedProvider = mediaType === "image"
    ? payload.imageSettings?.provider
    : payload.videoSettings?.provider;
  if (requestedProvider !== expectedProvider) {
    sendJobError(
      jobId,
      `${role} cannot process provider ${requestedProvider || "unknown"}`,
      "WRONG_ROLE",
    );
    return;
  }

  const providerLabel = role === "gemini-worker" ? "Gemini" : role === "grok-worker" ? "Grok" : "CapCut";
  const tab = await tabForConnection(sourceConnection, role, findTextProviderTab);
  if (!tab?.id) {
    sendJobError(
      jobId,
      `Không tìm thấy tab ${providerLabel} trong Chrome profile này`,
      "NOT_LOGGED_IN",
      true,
    );
    return;
  }

  try {
    await prepareProviderMediaTab(role, tab, mediaType);
  } catch (error) {
    sendJobError(
      jobId,
      `Không thể chuẩn bị tab ${providerLabel}: ${String(error?.message || error)}`,
      "PROVIDER_TAB_ACTIVATION_FAILED",
      true,
    );
    return;
  }

  const job = { kind: "provider-media", jobId, tabId: tab.id, stopping: false, connection: sourceConnection };
  setActiveJob(job);
  startActiveJobHeartbeat(jobId);
  sendJobProgress(
    jobId,
    "preparing",
    `Đang chuẩn bị tạo ${mediaType === "image" ? "ảnh" : "video"} scene ${payload.sceneId} bằng ${providerLabel}`,
  );

  try {
    const response = await sendTextWorkerMessage(tab.id, {
      type: "FLOWX_GENERATE_PROVIDER_MEDIA",
      jobId,
      tabId: tab.id,
      payload,
    });
    if (!isCurrentJob(job) || job.stopping) return;
    if (!response?.ok) {
      sendJobError(
        jobId,
        response?.error || `${providerLabel} media content worker failed`,
        response?.code || "INTERNAL_ERROR",
        response?.retryable === true,
      );
      return;
    }

    sendJobProgress(
      jobId,
      "downloading",
      `Đang lưu ${mediaType === "image" ? "ảnh" : "video"} ${providerLabel} vào Downloads/Vyren AI`,
    );
    const resultPath = mediaType === "image"
      ? await downloadProviderImage(response.result || response, payload, providerLabel)
      : await downloadProviderVideo(tab.id, response.result || response, payload, providerLabel);
    if (!isCurrentJob(job) || job.stopping) return;
    jobConnection(job)?.send({
      type: "JOB_DONE",
      jobId,
      result: {
        sceneId: payload.sceneId,
        mediaType,
        resultPath,
        flowAssetKey: "",
      },
    });
  } catch (error) {
    if (isCurrentJob(job)) {
      sendJobError(
        jobId,
        String(error?.message || error),
        job.stopping ? "STOPPED" : error?.code || "INTERNAL_ERROR",
        !job.stopping,
      );
    }
  } finally {
    clearActiveJob(job);
    await detachDebugger(job.tabId);
  }
}

async function handleSceneJob(message, sourceConnection) {
  const { jobId, action, payload } = message;
  if (
    typeof jobId !== "string" ||
    (action !== "GENERATE_IMAGE" && action !== "GENERATE_VIDEO")
  ) {
    if (typeof jobId === "string") {
      sendJobError(jobId, "Unsupported scene job", "INVALID_JOB");
    }
    return;
  }
  if (sourceConnection?.registration?.role !== "flow-worker") {
    sendJobError(jobId, `${action} requires flow-worker`, "WRONG_ROLE");
    return;
  }
  if (activeJobForConnection(sourceConnection)) {
    sendJobError(jobId, "Worker is already processing another job", "INVALID_JOB");
    return;
  }
  if (!isSceneJobPayload(payload)) {
    sendJobError(jobId, "Scene id, media type, and prompt are required", "INVALID_JOB");
    return;
  }

  if (!validReferenceImages(payload.refImages)) {
    sendJobError(jobId, "Danh sách ảnh tham chiếu không hợp lệ", "INVALID_JOB");
    return;
  }

  const tab = await tabForConnection(sourceConnection, "flow-worker", () => findFlowTab());
  if (!tab?.id) {
    sendJobError(
      jobId,
      "Không tìm thấy tab Google Flow đang mở trong Chrome profile này.",
      "FLOW_WORKSPACE_NOT_FOUND",
      true,
    );
    return;
  }

  try {
    await activateFlowWorkspace(tab);
    const modeReady = await ensureFlowMediaMode(tab.id, payload.mediaType);
    if (!modeReady?.ok) {
      sendJobError(
        jobId,
        modeReady?.error || "Google Flow không đổi được chế độ Hình ảnh/Video",
        modeReady?.code || "FLOW_MODE_CHANGE_FAILED",
        true,
      );
      return;
    }
  } catch (error) {
    sendJobError(
      jobId,
      `Không thể tự chuyển tab hoặc chế độ Google Flow: ${String(error?.message || error)}`,
      "FLOW_WORKSPACE_ACTIVATION_FAILED",
      true,
    );
    return;
  }

  const job = { kind: "scene", jobId, tabId: tab.id, stopping: false, connection: sourceConnection };
  setActiveJob(job);
  startActiveJobHeartbeat(jobId);
  try {
    if (payload.mediaType === "image") {
      sendJobProgress(jobId, "preparing", "Đã tự chuyển tab Flow sang chế độ Hình ảnh");
      sendJobProgress(jobId, "preparing", `Đang gắn ${payload.refImages.length} ảnh tham chiếu cần thiết vào Flow`);
    } else {
      sendJobProgress(jobId, "preparing", "Đã tự chuyển tab Flow sang chế độ Video");
      sendJobProgress(
        jobId,
        "preparing",
        payload.videoSettings.mode === "text-to-video"
          ? "Đang tạo video trực tiếp từ prompt, không cần ảnh mở đầu"
          : payload.videoSettings.mode === "first-frame"
          ? "Đang gắn ảnh scene hiện tại làm Start frame; không gắn End frame"
          : payload.videoSettings.mode === "frames"
          ? "Đang gắn Start/End frame trong Flow"
          : "Đang gắn ảnh scene làm Thành phần trong Flow",
      );
    }
    const response = payload.mediaType === "image"
      ? await generateFlowImage(tab.id, payload, jobId)
      : await generateFlowVideo(tab.id, payload, jobId);
    if (!isCurrentJob(job) || job.stopping) return;
    if (!response?.ok) {
      const code = response?.timeout ? "TIMEOUT" : response?.code || "INTERNAL_ERROR";
      sendJobError(
        jobId,
        response?.error || (response?.timeout ? `Google Flow tạo ${payload.mediaType === "image" ? "ảnh" : "video"} quá thời gian` : `Google Flow không tạo được ${payload.mediaType === "image" ? "ảnh" : "video"}`),
        code,
        ["TIMEOUT", "FLOW_RENDER_BUSY", "FLOW_UI_CHANGED", "FLOW_REF_UPLOAD_FAILED", "FLOW_REF_ATTACH_FAILED", "FLOW_START_FRAME_ATTACH_FAILED", "FLOW_END_FRAME_ATTACH_FAILED", "FLOW_STALE_MEDIA_CLEAR_FAILED", "FLOW_VIDEO_MODE_NOT_FOUND", "FLOW_VIDEO_MODE_CHANGE_FAILED", "FLOW_VIDEO_SETTINGS_NOT_FOUND", "FLOW_VIDEO_ASPECT_RATIO_NOT_FOUND", "FLOW_VIDEO_ASPECT_RATIO_CHANGE_FAILED", "FLOW_VIDEO_DURATION_NOT_FOUND", "FLOW_VIDEO_DURATION_CHANGE_FAILED", "FLOW_VIDEO_READ_FAILED", "FLOW_PROMPT_NOT_FILLED", "FLOW_PROMPT_NOT_VERIFIED", "FLOW_SUBMIT_FAILED"].includes(code),
      );
      return;
    }
    if (payload.mediaType === "video" && response.submitted) {
      jobConnection(job)?.send({
        type: "JOB_DONE",
        jobId,
        result: {
          sceneId: payload.sceneId,
          mediaType: payload.mediaType,
          resultPath: "",
          flowAssetKey: "",
          status: "submitted",
          submittedAt: response.submittedAt,
        },
      });
      return;
    }
    sendJobProgress(jobId, "downloading", `Đang lưu ${payload.mediaType === "image" ? "ảnh" : "video"} vào Downloads/Vyren AI`);
    if (payload.mediaType === "video" && !response.resultPath) {
      sendJobError(
        jobId,
        "Video không có đường dẫn từ lượt tải gốc Google Flow; app sẽ không tải URL lần hai.",
        "FLOW_NATIVE_DOWNLOAD_REQUIRED",
        false,
      );
      return;
    }
    const resultPath = response.resultPath || await downloadFlowImage(response, payload);
    if (!isCurrentJob(job) || job.stopping) return;
    jobConnection(job)?.send({
      type: "JOB_DONE",
      jobId,
      result: {
        sceneId: payload.sceneId,
        mediaType: payload.mediaType,
        resultPath,
        flowAssetKey: payload.mediaType === "image" ? response.flowAssetKey || "" : "",
        status: "downloaded",
      },
    });
  } catch (error) {
    if (isCurrentJob(job)) {
      sendJobError(jobId, String(error?.message || error), job.stopping ? "STOPPED" : "INTERNAL_ERROR", !job.stopping);
    }
  } finally {
    clearActiveJob(job);
    await detachDebugger(job.tabId);
  }
}

async function handleStop(message, sourceConnection) {
  const job = typeof message.jobId === "string"
    ? activeJobForId(message.jobId)
    : activeJobForConnection(sourceConnection);
  if (!job) return;

  const connection = job.connection || sourceConnection || defaultConnection;
  job.stopping = true;
  sendJobProgress(
    job.jobId,
    "stopping",
    job.kind === "chat-image"
      ? "Đang dừng tạo ảnh ChatGPT"
      : job.kind === "provider-media"
        ? "Đang dừng adapter media Gemini/Grok"
        : "Đang dừng tạo timeline",
  );
  clearActiveJob(job);
  if (job.kind === "scene") {
    if (job.tabId) {
      try {
        await chrome.tabs.sendMessage(job.tabId, { type: "STOP" });
      } catch (_) {
        // The Flow tab may already be closed.
      }
    }
    await detachDebugger(job.tabId);
    sendJobError(job.jobId, "Scene job stopped", "STOPPED", false, connection);
    return;
  }
  try {
    await chrome.tabs.sendMessage(job.tabId, {
      type: job.kind === "chat-image"
        ? "FLOWX_STOP_CHATGPT_IMAGE"
        : job.kind === "provider-media"
          ? "FLOWX_STOP_PROVIDER_MEDIA"
          : "FLOWX_STOP_TIMELINE",
      jobId: job.jobId,
    });
  } catch {
    sendJobError(job.jobId, "Timeline generation stopped", "STOPPED", false, connection);
  }
  await detachDebugger(job.tabId);
}

function handleDesktopMessage(message, sourceConnection) {
  defaultConnection = sourceConnection || defaultConnection;
  if (message?.type === "JOB") {
    if (message.action === "GENERATE_TIMELINE" || message.action === "REWRITE_POLICY_PROMPT") {
      void handleTimelineJob(message, sourceConnection);
    } else if (message.action === "GENERATE_CHATGPT_IMAGE") {
      void handleChatGptImageJob(message, sourceConnection);
    } else if (
      message.action === "GENERATE_PROVIDER_IMAGE" ||
      message.action === "GENERATE_PROVIDER_VIDEO"
    ) {
      void handleProviderMediaJob(message, sourceConnection);
    } else {
      void handleSceneJob(message, sourceConnection);
    }
  } else if (message?.type === "STOP") {
    void handleStop(message, sourceConnection);
  }
}

const connectionsByTab = new Map();

async function syncTabConnections() {
  const tabs = await chrome.tabs.query({});
  const liveKeys = new Set();
  for (const tab of tabs) {
    const role = roleForUrl(tab.url);
    if (!role || !Number.isInteger(tab.id)) continue;
    const key = connectionKeyForTab(role, tab.id);
    liveKeys.add(key);
    let workerConnection = connectionsByTab.get(key);
    if (!workerConnection) {
      workerConnection = new WorkerConnection({
        getRegistration: () => registrationForTab(role, tab.id),
        onStateChange: updateActionState,
        onMessage: handleDesktopMessage,
      });
      connectionsByTab.set(key, workerConnection);
      if (!defaultConnection) defaultConnection = workerConnection;
      void workerConnection.start();
    } else {
      void workerConnection.refreshRegistration();
    }
  }

  for (const [key, workerConnection] of connectionsByTab) {
    if (liveKeys.has(key)) continue;
    const job = activeJobForConnection(workerConnection);
    if (job) {
      const connection = job.connection || workerConnection;
      job.stopping = true;
      clearActiveJob(job);
      sendJobError(job.jobId, "Tab AI đang xử lý job đã đóng hoặc đổi trang", "WORKER_TAB_CLOSED", true, connection);
    }
    workerConnection.stop();
    connectionsByTab.delete(key);
    if (defaultConnection === workerConnection) {
      defaultConnection = connectionsByTab.values().next().value || null;
    }
  }

  if (!connectionsByTab.size) updateActionState("waiting", null);
}

function ensureKnownConnections() {
  void syncTabConnections().then(() => {
    for (const workerConnection of connectionsByTab.values()) void workerConnection.ensureConnected();
  });
}

function queueRoleRefresh() {
  if (roleRefreshTimer) clearTimeout(roleRefreshTimer);
  roleRefreshTimer = setTimeout(() => {
    roleRefreshTimer = null;
    void syncTabConnections();
  }, 250);
}

async function ensureReconnectAlarm() {
  const existing = await chrome.alarms.get(RECONNECT_ALARM);
  if (!existing) {
    await chrome.alarms.create(RECONNECT_ALARM, {
      delayInMinutes: 0.5,
      periodInMinutes: 0.5,
    });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureReconnectAlarm();
  ensureKnownConnections();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureReconnectAlarm();
  ensureKnownConnections();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) {
    ensureKnownConnections();
  }
});

chrome.tabs.onCreated.addListener(queueRoleRefresh);
chrome.tabs.onRemoved.addListener(queueRoleRefresh);
chrome.tabs.onActivated.addListener(queueRoleRefresh);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "complete") queueRoleRefresh();
});

chrome.action.onClicked.addListener(() => {
  ensureKnownConnections();
});

void ensureReconnectAlarm();
void syncTabConnections();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const attachedTabs = new Set();

chrome.debugger.onDetach.addListener((source) => {
  if (attachedTabs.has(source.tabId)) {
    console.warn("[Vyren AI Worker] Debugger detached from tab", source.tabId);
    attachedTabs.delete(source.tabId);
  }
});

function sendCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

async function ensureAttached(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^https:\/\/(?:chatgpt\.com\/|claude\.ai\/|gemini\.google\.com\/|grok\.com\/|(?:www\.)?capcut\.com\/|labs\.google\/fx\/|flow\.google\/)/i.test(tab.url || "")) {
    throw new Error("Debugger target is not a supported Vyren AI Worker tab");
  }
  if (attachedTabs.has(tabId)) return;

  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
  attachedTabs.add(tabId);
}

async function detachDebugger(tabId = null) {
  if (tabId === null) {
    const tabIds = [...attachedTabs];
    await Promise.all(tabIds.map((id) => detachDebugger(id)));
    return;
  }
  if (!attachedTabs.has(tabId)) return;

  try {
    await chrome.debugger.detach({ tabId });
  } catch (_) {
    // Detaching is idempotent from the worker's perspective.
  }
  attachedTabs.delete(tabId);
}

async function typePrompt(tabId, x, y, prompt) {
  await ensureAttached(tabId);

  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
  });
  await wait(220);
  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await wait(180);

  await sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers: 2,
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
  });
  await sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: 2,
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
  });
  await wait(60);

  await sendCommand(tabId, "Input.insertText", { text: prompt });
}

async function submitPrompt(tabId) {
  await ensureAttached(tabId);

  await sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
}

async function typeAndSubmit(tabId, x, y, prompt) {
  await typePrompt(tabId, x, y, prompt);
  await wait(900);
  await submitPrompt(tabId);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return undefined;

  if (message.type === "WORKER_PAGE_READY") {
    queueRoleRefresh();
    sendResponse({ ok: true });
    return undefined;
  }

  if (message.type === "DEBUG_SUBMIT") {
    const tabId = message.tabId || sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "Cannot determine the active tab" });
      return undefined;
    }
    typeAndSubmit(tabId, message.x, message.y, message.prompt)
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error.message || error) }),
      );
    return true;
  }

  if (message.type === "DEBUG_DETACH") {
    detachDebugger().then(() => sendResponse({ ok: true }));
    return true;
  }

  const progressJob = message.type === "TIMELINE_PROGRESS"
    ? activeJobForId(message.jobId)
    : null;
  if (progressJob) {
    sendJobProgress(
      progressJob.jobId,
      message.status === "preparing" ? "preparing" : "generating",
      typeof message.message === "string" ? message.message.slice(0, 500) : undefined,
      message,
    );
    sendResponse({ ok: true });
    return undefined;
  }

  return undefined;
});
