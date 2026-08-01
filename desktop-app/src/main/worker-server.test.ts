import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { WorkerJobError, WorkerServer } from "./worker-server";
import { EXTENSION_DISPLAY_NAME } from "../shared/brand";
import {
  WORKER_CAPABILITIES_BY_ROLE,
  type WorkerRole,
} from "../shared/worker-status";

function waitForMessage(
  socket: WebSocket,
  type: string,
  timeoutMs = 1_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type !== type) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

async function waitForWorkerStatus(
  server: WorkerServer,
  role: WorkerRole,
  connected: boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (server.getStatuses()[role]?.connected !== connected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(server.getStatuses()[role]?.connected, connected);
}

test("handles heartbeat, timeline results, and stop on an isolated port", async () => {
  const server = new WorkerServer(() => {}, {
    port: 0,
    heartbeatIntervalMs: 30,
    connectionTimeoutMs: 500,
    jobTimeoutMs: 1_000,
    jobAckTimeoutMs: 100,
  });
  await server.start();
  const port = server.getListeningPort();
  assert.ok(port);

  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    await waitForOpen(socket);
    const pingPromise = waitForMessage(socket, "PING");
    const orphanResetPromise = waitForMessage(socket, "STOP");
    socket.send(
      JSON.stringify({
        type: "REGISTER",
        role: "chat-worker",
        profileTag: "isolated-test",
        workerVersion: "2.44.0",
      }),
    );
    const orphanReset = await orphanResetPromise;
    assert.equal(orphanReset.jobId, undefined);
    const ping = await pingPromise;
    socket.send(JSON.stringify({ type: "PONG", timestamp: ping.timestamp }));
    const chatStatus = server.getStatuses()["chat-worker"];
    assert.equal(chatStatus.connected, true);
    assert.equal(chatStatus.provider, "chatgpt");
    assert.deepEqual(
      chatStatus.capabilities,
      WORKER_CAPABILITIES_BY_ROLE["chat-worker"],
    );
    assert.equal(chatStatus.workerVersion, "2.44.0");

    const jobMessagePromise = waitForMessage(socket, "JOB");
    const resultPromise = server.generateTimeline({
      srtText: "1\n00:00:00,000 --> 00:00:08,000\nHello",
      scriptText: "@hero enters",
      visualBible: {
        style: "locked stickman style",
        palette: "locked black, white, and red accents",
        lighting: "",
        continuityNotes: "locked round heads and single-line limbs",
        aspectRatio: "16:9",
      },
      characterRoster: [{ token: "@HERO", name: "Hero" }],
      styleReference: {
        name: "reference.png",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      },
    });
    const job = await jobMessagePromise;
    assert.deepEqual(
      (job.payload as { characterRoster: Array<{ token: string; name: string }> }).characterRoster,
      [{ token: "@HERO", name: "Hero" }],
    );
    socket.send(
      JSON.stringify({
        type: "JOB_DONE",
        jobId: job.jobId,
        result: {
          visualBible: {
            style: "cinematic 3D animation",
            palette: "teal and warm gold",
            lighting: "soft directional sunset light",
            continuityNotes: "Keep @HERO in the same blue jacket",
            aspectRatio: "16:9",
          },
          scenes: [
            {
              timeStart: "00:00:00,000",
              timeEnd: "00:00:08,000",
              imagePrompt: "@hero enters a room",
              videoPrompt: "Slow push in",
            },
          ],
        },
      }),
    );
    const result = await resultPromise;
    assert.equal(result.scenes[0].imagePrompt, "@HERO enters a room");
    assert.equal(
      result.visualBible.style,
      "locked stickman style",
    );
    assert.equal(result.visualBible.palette, "locked black, white, and red accents");
    assert.equal(result.visualBible.lighting, "soft directional sunset light");
    assert.equal(result.visualBible.continuityNotes, "locked round heads and single-line limbs");

    const rewriteJobPromise = waitForMessage(socket, "JOB");
    const rewriteResultPromise = server.rewritePolicyPrompt({
      sceneId: "scene-004",
      mediaType: "video",
      prompt: "Original rejected prompt",
      policyError: "Google Flow safety policy",
      timeStart: "00:00:24,000",
      timeEnd: "00:00:32,000",
      pairedPrompt: "Opening image context",
      visualBible: {
        style: "locked stickman style",
        palette: "black, white, red",
        lighting: "flat light",
        continuityNotes: "same design",
        aspectRatio: "16:9",
      },
    });
    const rewriteJob = await rewriteJobPromise;
    assert.equal(rewriteJob.action, "REWRITE_POLICY_PROMPT");
    assert.equal((rewriteJob.payload as { sceneId: string }).sceneId, "scene-004");
    const rewrittenPrompt = "STARTING STATE: a worried figure pauses beside a closed doorway in a quiet hallway. PRIMARY MOTION: the figure steps backward while keeping both hands visible and turning toward a distant sound. REACTION: concern changes into alert attention through the eyes, eyebrows, head angle, and guarded posture. ENVIRONMENTAL MOTION: a loose curtain moves gently beside the window while soft dust crosses the light. CAMERA MOTION: a steady medium tracking shot follows the retreat at natural speed without sudden movement. END FRAME: the figure stops safely near the hallway corner and looks toward the unseen source.";
    socket.send(JSON.stringify({
      type: "JOB_DONE",
      jobId: rewriteJob.jobId,
      result: { prompt: rewrittenPrompt },
    }));
    assert.equal((await rewriteResultPromise).prompt, rewrittenPrompt);

    const secondJobPromise = waitForMessage(socket, "JOB");
    const stoppedResult = server.generateTimeline({
      srtText: "1\n00:00:00,000 --> 00:00:02,000\nHello",
      scriptText: "Stop this job",
      visualBible: {
        style: "",
        palette: "",
        lighting: "",
        continuityNotes: "",
        aspectRatio: "16:9",
      },
      characterRoster: [],
      styleReference: null,
    });
    const stoppedAssertion = assert.rejects(stoppedResult, (error: unknown) => {
      assert.ok(error instanceof WorkerJobError);
      assert.equal(error.code, "STOPPED");
      return true;
    });
    const secondJob = await secondJobPromise;
    const stopPromise = waitForMessage(socket, "STOP");
    assert.equal(server.stopActiveJob("chat-worker"), true);
    const stop = await stopPromise;
    assert.equal(stop.jobId, secondJob.jobId);
    socket.send(
      JSON.stringify({
        type: "JOB_ERROR",
        jobId: secondJob.jobId,
        error: "Timeline generation stopped",
        code: "STOPPED",
      }),
    );
    await stoppedAssertion;

    const staleJobMessage = waitForMessage(socket, "JOB");
    const staleResult = server.generateTimeline({
      srtText: "1\n00:00:00,000 --> 00:00:02,000\nHello",
      scriptText: "No worker acknowledgement",
      visualBible: {
        style: "",
        palette: "",
        lighting: "",
        continuityNotes: "",
        aspectRatio: "16:9",
      },
      characterRoster: [],
      styleReference: null,
    });
    const staleAssertion = assert.rejects(staleResult, new RegExp(`Reload ${EXTENSION_DISPLAY_NAME}`));
    await staleJobMessage;
    await staleAssertion;
  } finally {
    socket.terminate();
    server.stop();
  }
});

test("normalizes provider worker registration metadata and rejects provider mismatches", async () => {
  const server = new WorkerServer(() => {}, {
    port: 0,
    heartbeatIntervalMs: 30,
    connectionTimeoutMs: 500,
    jobTimeoutMs: 1_000,
    jobAckTimeoutMs: 100,
  });
  await server.start();
  const port = server.getListeningPort();
  assert.ok(port);

  const geminiSocket = new WebSocket(`ws://127.0.0.1:${port}`);
  let invalidSocket: WebSocket | null = null;
  try {
    await waitForOpen(geminiSocket);
    const orphanReset = waitForMessage(geminiSocket, "STOP");
    geminiSocket.send(JSON.stringify({
      type: "REGISTER",
      role: "gemini-worker",
      profileTag: "provider-test-gemini",
      workerVersion: "1.0.0",
      provider: "gemini",
      capabilities: [
        "GENERATE_TIMELINE",
        "REWRITE_POLICY_PROMPT",
        "GENERATE_TIMELINE",
        "GENERATE_VIDEO",
      ],
    }));
    await orphanReset;
    await waitForWorkerStatus(server, "gemini-worker", true);

    const geminiStatus = server.getStatuses()["gemini-worker"];
    assert.ok(geminiStatus);
    assert.equal(geminiStatus.provider, "gemini");
    assert.deepEqual(geminiStatus.capabilities, [
      "GENERATE_TIMELINE",
      "REWRITE_POLICY_PROMPT",
    ]);
    assert.equal(geminiStatus.workerVersion, "1.0.0");

    const mismatchSocket = new WebSocket(`ws://127.0.0.1:${port}`);
    invalidSocket = mismatchSocket;
    await waitForOpen(mismatchSocket);
    const closeResult = new Promise<{ code: number; reason: string }>((resolve) => {
      mismatchSocket.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });
    mismatchSocket.send(JSON.stringify({
      type: "REGISTER",
      role: "grok-worker",
      profileTag: "provider-test-invalid",
      workerVersion: "1.0.0",
      provider: "gemini",
      capabilities: ["REWRITE_SCRIPT"],
    }));
    const closed = await closeResult;
    assert.equal(closed.code, 1008);
    assert.match(closed.reason, /REGISTER/);
    assert.equal(server.getStatuses()["grok-worker"], undefined);
  } finally {
    geminiSocket.terminate();
    invalidSocket?.terminate();
    server.stop();
  }
});

test("routes timeline jobs to the selected Claude, Gemini, and Grok worker", async () => {
  const server = new WorkerServer(() => {}, {
    port: 0,
    heartbeatIntervalMs: 30,
    connectionTimeoutMs: 500,
    jobTimeoutMs: 1_000,
    jobAckTimeoutMs: 100,
  });
  await server.start();
  const port = server.getListeningPort();
  assert.ok(port);

  const providers = [
    { provider: "claude", role: "claude-worker" },
    { provider: "gemini", role: "gemini-worker" },
    { provider: "grok", role: "grok-worker" },
  ] as const;
  const safeRewrite = "STARTING STATE: a worried figure pauses beside a closed doorway in a quiet hallway. PRIMARY MOTION: the figure steps backward while keeping both hands visible and turning toward a distant sound. REACTION: concern changes into alert attention through the eyes, eyebrows, head angle, and guarded posture. ENVIRONMENTAL MOTION: a loose curtain moves gently beside the window while soft dust crosses the light. CAMERA MOTION: a steady medium tracking shot follows the retreat at natural speed without sudden movement. END FRAME: the figure stops safely near the hallway corner and looks toward the unseen source.";
  const sockets: WebSocket[] = [];
  try {
    for (const entry of providers) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      sockets.push(socket);
      await waitForOpen(socket);
      const orphanReset = waitForMessage(socket, "STOP");
      socket.send(JSON.stringify({
        type: "REGISTER",
        role: entry.role,
        profileTag: `provider-route-${entry.provider}`,
        workerVersion: "2.57.0",
        provider: entry.provider,
        capabilities: ["GENERATE_TIMELINE", "REWRITE_POLICY_PROMPT"],
      }));
      await orphanReset;
      await waitForWorkerStatus(server, entry.role, true);

      const jobMessage = waitForMessage(socket, "JOB");
      const resultPromise = server.generateTimeline({
        textProvider: entry.provider,
        srtText: "1\n00:00:00,000 --> 00:00:08,000\nHello",
        scriptText: `${entry.provider} writes this scene`,
        visualBible: {
          style: "flat graphic",
          palette: "black and white",
          lighting: "soft",
          continuityNotes: "stable subject",
          aspectRatio: "16:9",
        },
        characterRoster: [],
        styleReference: null,
      });
      const job = await jobMessage;
      assert.equal(job.action, "GENERATE_TIMELINE");
      assert.equal((job.payload as { textProvider: string }).textProvider, entry.provider);
      socket.send(JSON.stringify({
        type: "JOB_DONE",
        jobId: job.jobId,
        result: {
          visualBible: {
            style: "flat graphic",
            palette: "black and white",
            lighting: "soft",
            continuityNotes: "stable subject",
            aspectRatio: "16:9",
          },
          scenes: [{
            timeStart: "00:00:00,000",
            timeEnd: "00:00:08,000",
            imagePrompt: "A complete opening scene",
            videoPrompt: "STARTING STATE: still. PRIMARY MOTION: moves. REACTION: calm. ENVIRONMENTAL MOTION: light shifts. CAMERA MOTION: slow push. END FRAME: stable.",
          }],
        },
      }));
      const result = await resultPromise;
      assert.equal(result.scenes.length, 1);

      const rewriteJobMessage = waitForMessage(socket, "JOB");
      const rewritePromise = server.rewritePolicyPrompt({
        textProvider: entry.provider,
        sceneId: "scene-001",
        mediaType: "video",
        prompt: "Original rejected prompt",
        policyError: "Flow safety policy",
        timeStart: "00:00:00,000",
        timeEnd: "00:00:08,000",
        pairedPrompt: "Opening image",
        visualBible: {
          style: "flat graphic",
          palette: "black and white",
          lighting: "soft",
          continuityNotes: "stable subject",
          aspectRatio: "16:9",
        },
      });
      const rewriteJob = await rewriteJobMessage;
      assert.equal(rewriteJob.action, "REWRITE_POLICY_PROMPT");
      assert.equal(
        (rewriteJob.payload as { textProvider: string }).textProvider,
        entry.provider,
      );
      socket.send(JSON.stringify({
        type: "JOB_DONE",
        jobId: rewriteJob.jobId,
        result: { prompt: safeRewrite },
      }));
      assert.equal((await rewritePromise).prompt, safeRewrite);
    }
  } finally {
    for (const socket of sockets) socket.terminate();
    server.stop();
  }
});

test("routes ChatGPT image provider jobs to the chat worker", async () => {
  const server = new WorkerServer(() => {}, {
    port: 0,
    heartbeatIntervalMs: 30,
    connectionTimeoutMs: 500,
    jobTimeoutMs: 1_000,
    jobAckTimeoutMs: 100,
  });
  await server.start();
  const port = server.getListeningPort();
  assert.ok(port);

  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    await waitForOpen(socket);
    const pingPromise = waitForMessage(socket, "PING");
    const orphanResetPromise = waitForMessage(socket, "STOP");
    socket.send(JSON.stringify({
      type: "REGISTER",
      role: "chat-worker",
      profileTag: "chat-image-test",
      workerVersion: "2.55.0",
    }));
    await orphanResetPromise;
    const ping = await pingPromise;
    socket.send(JSON.stringify({ type: "PONG", timestamp: ping.timestamp }));
    assert.equal(server.getStatuses()["chat-worker"].connected, true);

    const jobMessage = waitForMessage(socket, "JOB");
    const resultPromise = server.runSceneJob({
      sceneId: "scene-011",
      mediaType: "image",
      prompt: "A production still generated by ChatGPT",
      characterTokens: [],
      visualBible: {
        style: "flat vector",
        palette: "blue, cyan, violet",
        lighting: "soft studio",
        continuityNotes: "Keep shapes stable",
        aspectRatio: "16:9",
      },
      imageSettings: {
        provider: "chatgpt-image",
        model: "chatgpt-web",
        aspectRatio: "16:9",
        outputCount: 1,
        expectedCredits: 0,
      },
      sourceImagePath: "",
      sourceFlowAssetKey: "",
      startFramePath: "",
      videoSettings: {
        provider: "google-flow",
        model: "veo-3.1-lite",
        mode: "ingredients",
        aspectRatio: "16:9",
        durationSeconds: 8,
        outputCount: 1,
        expectedCredits: 0,
      },
      refImages: [],
    }, () => {});
    const job = await jobMessage;
    assert.equal(job.action, "GENERATE_CHATGPT_IMAGE");
    assert.equal((job.payload as Record<string, any>).imageSettings.provider, "chatgpt-image");
    socket.send(JSON.stringify({
      type: "JOB_DONE",
      jobId: job.jobId,
      result: {
        sceneId: "scene-011",
        mediaType: "image",
        resultPath: "C:\\Vyren AI\\scene-011-chatgpt.png",
        flowAssetKey: "",
      },
    }));
    const result = await resultPromise;
    assert.equal(result.resultPath, "C:\\Vyren AI\\scene-011-chatgpt.png");
    assert.equal(result.flowAssetKey, "");
  } finally {
    socket.terminate();
    server.stop();
  }
});

test("routes Gemini image and Grok video jobs to their provider workers", async () => {
  const server = new WorkerServer(() => {}, {
    port: 0,
    heartbeatIntervalMs: 30,
    connectionTimeoutMs: 1_000,
    jobTimeoutMs: 1_000,
    jobAckTimeoutMs: 100,
  });
  await server.start();
  const gemini = new WebSocket(`ws://127.0.0.1:${server.getListeningPort()}`);
  const grok = new WebSocket(`ws://127.0.0.1:${server.getListeningPort()}`);
  try {
    await Promise.all([waitForOpen(gemini), waitForOpen(grok)]);
    gemini.send(JSON.stringify({
      type: "REGISTER",
      role: "gemini-worker",
      profileTag: "gemini-media-test",
      workerVersion: "2.58.0",
      provider: "gemini",
      capabilities: [
        "GENERATE_TIMELINE",
        "REWRITE_POLICY_PROMPT",
        "GENERATE_PROVIDER_IMAGE",
        "GENERATE_PROVIDER_VIDEO",
      ],
    }));
    grok.send(JSON.stringify({
      type: "REGISTER",
      role: "grok-worker",
      profileTag: "grok-media-test",
      workerVersion: "2.58.0",
      provider: "grok",
      capabilities: [
        "GENERATE_TIMELINE",
        "REWRITE_POLICY_PROMPT",
        "GENERATE_PROVIDER_IMAGE",
        "GENERATE_PROVIDER_VIDEO",
      ],
    }));
    const registrationDeadline = Date.now() + 500;
    while (
      (
        !server.getStatuses()["gemini-worker"]?.connected ||
        !server.getStatuses()["grok-worker"]?.connected
      ) &&
      Date.now() < registrationDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const geminiJobMessage = waitForMessage(gemini, "JOB");
    const geminiResultPromise = server.runSceneJob({
      sceneId: "scene-021",
      mediaType: "image",
      prompt: "A Gemini production still",
      characterTokens: [],
      visualBible: {
        style: "flat vector",
        palette: "blue and gold",
        lighting: "soft daylight",
        continuityNotes: "Keep the hero stable",
        aspectRatio: "16:9",
      },
      imageSettings: {
        provider: "gemini-image",
        model: "gemini-web",
        aspectRatio: "16:9",
        outputCount: 1,
        expectedCredits: 0,
      },
      sourceImagePath: "",
      sourceFlowAssetKey: "",
      startFramePath: "",
      videoSettings: {
        provider: "google-flow",
        model: "veo-3.1-lite",
        mode: "first-frame",
        aspectRatio: "16:9",
        durationSeconds: 8,
        outputCount: 1,
        expectedCredits: 0,
      },
      refImages: [],
      sourceImage: null,
    }, () => {});
    const geminiJob = await geminiJobMessage;
    assert.equal(geminiJob.action, "GENERATE_PROVIDER_IMAGE");
    assert.equal((geminiJob.payload as Record<string, any>).imageSettings.provider, "gemini-image");
    gemini.send(JSON.stringify({
      type: "JOB_DONE",
      jobId: geminiJob.jobId,
      result: {
        sceneId: "scene-021",
        mediaType: "image",
        resultPath: "C:\\Vyren AI\\scene-021-gemini.png",
        flowAssetKey: "",
      },
    }));
    assert.equal((await geminiResultPromise).resultPath, "C:\\Vyren AI\\scene-021-gemini.png");

    const sourceImage = {
      token: "@SOURCE_FRAME" as const,
      name: "scene-021.png",
      mimeType: "image/png" as const,
      imageBase64: "iVBORw0KGgo=",
      localPath: "C:\\Vyren AI\\scene-021-gemini.png",
    };
    const grokJobMessage = waitForMessage(grok, "JOB");
    const grokResultPromise = server.runSceneJob({
      sceneId: "scene-021",
      mediaType: "video",
      prompt: "Animate the hero walking forward",
      characterTokens: [],
      visualBible: {
        style: "flat vector",
        palette: "blue and gold",
        lighting: "soft daylight",
        continuityNotes: "Keep the hero stable",
        aspectRatio: "16:9",
      },
      imageSettings: {
        provider: "gemini-image",
        model: "gemini-web",
        aspectRatio: "16:9",
        outputCount: 1,
        expectedCredits: 0,
      },
      sourceImagePath: sourceImage.localPath,
      sourceFlowAssetKey: "",
      startFramePath: "",
      videoSettings: {
        provider: "grok-video",
        model: "grok-imagine-video-web",
        mode: "first-frame",
        aspectRatio: "16:9",
        durationSeconds: 8,
        outputCount: 1,
        expectedCredits: 0,
      },
      refImages: [],
      sourceImage,
    }, () => {});
    const grokJob = await grokJobMessage;
    assert.equal(grokJob.action, "GENERATE_PROVIDER_VIDEO");
    assert.equal((grokJob.payload as Record<string, any>).videoSettings.provider, "grok-video");
    assert.equal((grokJob.payload as Record<string, any>).sourceImage.token, "@SOURCE_FRAME");
    grok.send(JSON.stringify({
      type: "JOB_DONE",
      jobId: grokJob.jobId,
      result: {
        sceneId: "scene-021",
        mediaType: "video",
        resultPath: "C:\\Vyren AI\\scene-021-grok.mp4",
        flowAssetKey: "",
      },
    }));
    assert.equal((await grokResultPromise).resultPath, "C:\\Vyren AI\\scene-021-grok.mp4");
  } finally {
    gemini.terminate();
    grok.terminate();
    server.stop();
  }
});

test("routes CapCut Video Studio jobs to the capcut worker", async () => {
  const server = new WorkerServer(() => {}, {
    port: 0,
    heartbeatIntervalMs: 30,
    connectionTimeoutMs: 1_000,
    jobTimeoutMs: 1_000,
    jobAckTimeoutMs: 100,
  });
  await server.start();
  const port = server.getListeningPort();
  assert.ok(port);

  const capcut = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    await waitForOpen(capcut);
    const orphanReset = waitForMessage(capcut, "STOP");
    capcut.send(JSON.stringify({
      type: "REGISTER",
      role: "capcut-worker",
      profileTag: "capcut-video-test",
      workerVersion: "2.64.0",
      provider: "capcut",
      capabilities: ["GENERATE_PROVIDER_VIDEO"],
    }));
    await orphanReset;
    await waitForWorkerStatus(server, "capcut-worker", true);

    const sourceImage = {
      token: "@SOURCE_FRAME",
      name: "Source frame",
      mimeType: "image/png" as const,
      imageBase64: "iVBORw0KGgo=",
      localPath: "C:\\Vyren AI\\scene-031.png",
    };
    const jobMessage = waitForMessage(capcut, "JOB");
    const resultPromise = server.runSceneJob({
      sceneId: "scene-031",
      mediaType: "video",
      prompt: "Animate a calm camera push toward the product",
      characterTokens: [],
      visualBible: {
        style: "clean studio",
        palette: "white and teal",
        lighting: "softbox",
        continuityNotes: "keep product proportions stable",
        aspectRatio: "16:9",
      },
      imageSettings: {
        provider: "google-flow",
        model: "nano-banana-pro",
        aspectRatio: "16:9",
        outputCount: 1,
        expectedCredits: 0,
      },
      sourceImagePath: sourceImage.localPath,
      sourceFlowAssetKey: "",
      startFramePath: "",
      videoSettings: {
        provider: "capcut-video",
        model: "capcut-video-studio-web",
        mode: "first-frame",
        aspectRatio: "16:9",
        durationSeconds: 6,
        outputCount: 1,
        expectedCredits: 0,
      },
      refImages: [],
      sourceImage,
    }, () => {});
    const job = await jobMessage;
    assert.equal(job.action, "GENERATE_PROVIDER_VIDEO");
    assert.equal((job.payload as Record<string, any>).videoSettings.provider, "capcut-video");
    assert.equal((job.payload as Record<string, any>).sourceImage.token, "@SOURCE_FRAME");
    capcut.send(JSON.stringify({
      type: "JOB_DONE",
      jobId: job.jobId,
      result: {
        sceneId: "scene-031",
        mediaType: "video",
        resultPath: "C:\\Vyren AI\\scene-031-capcut.mp4",
        flowAssetKey: "",
      },
    }));
    assert.equal((await resultPromise).resultPath, "C:\\Vyren AI\\scene-031-capcut.mp4");
  } finally {
    capcut.terminate();
    server.stop();
  }
});

test("dispatches same-role scene jobs across idle worker clients", async () => {
  const server = new WorkerServer(() => {}, {
    port: 0,
    heartbeatIntervalMs: 30,
    connectionTimeoutMs: 1_000,
    jobTimeoutMs: 1_000,
    jobAckTimeoutMs: 100,
  });
  await server.start();
  const sockets = [
    new WebSocket(`ws://127.0.0.1:${server.getListeningPort()}`),
    new WebSocket(`ws://127.0.0.1:${server.getListeningPort()}`),
  ];
  const sceneInput = (sceneId: string) => ({
    sceneId,
    mediaType: "image" as const,
    prompt: `A Flow still for ${sceneId}`,
    characterTokens: [],
    visualBible: {
      style: "clean production frame",
      palette: "cyan, charcoal, warm white",
      lighting: "soft studio",
      continuityNotes: "Keep scene geometry stable",
      aspectRatio: "16:9" as const,
    },
    imageSettings: {
      provider: "google-flow" as const,
      model: "nano-banana-pro" as const,
      aspectRatio: "16:9" as const,
      outputCount: 1 as const,
      expectedCredits: 0 as const,
    },
    sourceImagePath: "",
    sourceFlowAssetKey: "",
    startFramePath: "",
    videoSettings: {
      provider: "google-flow" as const,
      model: "veo-3.1-lite" as const,
      mode: "ingredients" as const,
      aspectRatio: "16:9" as const,
      durationSeconds: 8 as const,
      outputCount: 1 as const,
      expectedCredits: 0 as const,
    },
    refImages: [],
  });
  try {
    await Promise.all(sockets.map(waitForOpen));
    sockets.forEach((socket, index) => {
      socket.send(JSON.stringify({
        type: "REGISTER",
        role: "flow-worker",
        profileTag: `flow-pool-${index + 1}`,
        workerVersion: "2.62.0",
      }));
    });
    await waitForWorkerStatus(server, "flow-worker", true);
    const deadline = Date.now() + 500;
    while ((server.getStatuses()["flow-worker"].connectedCount || 0) < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(server.getStatuses()["flow-worker"].connectedCount, 2);
    assert.equal(server.getStatuses()["flow-worker"].idleCount, 2);

    const jobMessages = sockets.map((socket) => waitForMessage(socket, "JOB"));
    const firstResult = server.runSceneJob(sceneInput("scene-101"), () => {});
    const secondResult = server.runSceneJob(sceneInput("scene-102"), () => {});
    const jobs = await Promise.all(jobMessages);
    assert.notEqual(jobs[0].jobId, jobs[1].jobId);
    assert.equal(server.getStatuses()["flow-worker"].busyCount, 2);
    for (const [index, job] of jobs.entries()) {
      const sceneId = (job.payload as Record<string, unknown>).sceneId;
      sockets[index].send(JSON.stringify({
        type: "JOB_DONE",
        jobId: job.jobId,
        result: {
          sceneId,
          mediaType: "image",
          resultPath: `C:\\Vyren AI\\${sceneId}.png`,
          flowAssetKey: `asset:${sceneId}`,
        },
      }));
    }
    const results = await Promise.all([firstResult, secondResult]);
    assert.deepEqual(results.map((result) => result.sceneId).sort(), ["scene-101", "scene-102"]);
    assert.equal(server.getStatuses()["flow-worker"].busyCount, 0);
    assert.equal(server.getStatuses()["flow-worker"].idleCount, 2);
  } finally {
    for (const socket of sockets) socket.terminate();
    server.stop();
  }
});

test("routes a Phase 5 image job with bound character references", async () => {
  const server = new WorkerServer(() => {}, {
    port: 0,
    heartbeatIntervalMs: 30,
    connectionTimeoutMs: 500,
    jobTimeoutMs: 1_000,
    jobAckTimeoutMs: 100,
  });
  await server.start();
  const socket = new WebSocket(`ws://127.0.0.1:${server.getListeningPort()}`);
  try {
    await waitForOpen(socket);
    socket.send(JSON.stringify({
      type: "REGISTER",
      role: "flow-worker",
      profileTag: "phase5-test-flow",
      workerVersion: "2.47.0",
    }));
    const registrationDeadline = Date.now() + 500;
    while (
      !server.getStatuses()["flow-worker"].connected &&
      Date.now() < registrationDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(server.getStatuses()["flow-worker"].connected, true);

    const jobMessage = waitForMessage(socket, "JOB");
    const progress: string[] = [];
    const resultPromise = server.runSceneJob(
      {
        sceneId: "scene-007",
        mediaType: "image",
        prompt: "A revised image prompt",
        characterTokens: ["@HERO"],
        visualBible: {
          style: "cinematic 3D",
          palette: "teal and warm gold",
          lighting: "soft sunset",
          continuityNotes: "Keep wardrobe unchanged",
          aspectRatio: "16:9",
        },
        imageSettings: {
          provider: "google-flow",
          model: "nano-banana-pro",
          aspectRatio: "16:9",
          outputCount: 1,
          expectedCredits: 0,
        },
        sourceImagePath: "",
        sourceFlowAssetKey: "",
        startFramePath: "",
        videoSettings: {
          provider: "google-flow",
          model: "veo-3.1-lite",
          mode: "ingredients",
          aspectRatio: "16:9",
          durationSeconds: 8,
          outputCount: 1,
          expectedCredits: 0,
        },
        refImages: [{
          token: "@HERO",
          name: "Hero",
          mimeType: "image/png",
          imageBase64: "iVBORw0KGgo=",
          localPath: "C:\\FlowX\\hero.png",
        }],
      },
      (event) => progress.push(`${event.sceneId}:${event.status}`),
    );
    const job = await jobMessage;
    assert.equal(job.action, "GENERATE_IMAGE");
    assert.deepEqual(job.payload, {
      sceneId: "scene-007",
      mediaType: "image",
      prompt: "A revised image prompt",
      characterTokens: ["@HERO"],
      visualBible: {
        style: "cinematic 3D",
        palette: "teal and warm gold",
        lighting: "soft sunset",
        continuityNotes: "Keep wardrobe unchanged",
        aspectRatio: "16:9",
      },
      imageSettings: {
        provider: "google-flow",
        model: "nano-banana-pro",
        aspectRatio: "16:9",
        outputCount: 1,
        expectedCredits: 0,
      },
      sourceImagePath: "",
      sourceFlowAssetKey: "",
      startFramePath: "",
      videoSettings: {
        provider: "google-flow",
        model: "veo-3.1-lite",
        mode: "ingredients",
        aspectRatio: "16:9",
        durationSeconds: 8,
        outputCount: 1,
        expectedCredits: 0,
      },
      refImages: [{
        token: "@HERO",
        name: "Hero",
        mimeType: "image/png",
        imageBase64: "iVBORw0KGgo=",
        localPath: "C:\\FlowX\\hero.png",
      }],
    });
    socket.send(JSON.stringify({
      type: "JOB_PROGRESS",
      jobId: job.jobId,
      status: "generating",
      message: "Generating only scene 7",
    }));
    socket.send(JSON.stringify({
      type: "JOB_DONE",
      jobId: job.jobId,
      result: {
        sceneId: "scene-007",
        mediaType: "image",
        resultPath: "mock://phase4/image/scene-007/test",
        flowAssetKey: "path:https://flow.google/assets/scene-007",
      },
    }));

    const result = await resultPromise;
    assert.equal(result.sceneId, "scene-007");
    assert.equal(result.resultPath, "mock://phase4/image/scene-007/test");
    assert.equal(result.flowAssetKey, "path:https://flow.google/assets/scene-007");
    assert.deepEqual(progress, [
      "scene-007:queued",
      "scene-007:generating",
    ]);

    const videoJobMessage = waitForMessage(socket, "JOB");
    const videoResultPromise = server.runSceneJob({
      sceneId: "scene-007",
      mediaType: "video",
      prompt: "The hero turns toward the window as the camera tracks forward",
      characterTokens: [],
      visualBible: {
        style: "cinematic 3D",
        palette: "teal and warm gold",
        lighting: "soft sunset",
        continuityNotes: "Keep wardrobe unchanged",
        aspectRatio: "16:9",
      },
      imageSettings: {
        provider: "google-flow",
        model: "nano-banana-pro",
        aspectRatio: "16:9",
        outputCount: 1,
        expectedCredits: 0,
      },
      sourceImagePath: "C:\\FlowX\\scene-007.png",
      sourceFlowAssetKey: "path:https://flow.google/assets/scene-007",
      startFramePath: "",
      videoSettings: {
        provider: "google-flow",
        model: "veo-3.1-lite",
        mode: "ingredients",
        aspectRatio: "16:9",
        durationSeconds: 8,
        outputCount: 1,
        expectedCredits: 0,
      },
      refImages: [],
    }, () => {});
    const videoJob = await videoJobMessage;
    assert.equal(videoJob.action, "GENERATE_VIDEO");
    const videoPayload = videoJob.payload as Record<string, any>;
    assert.equal(videoPayload.sourceImagePath, "C:\\FlowX\\scene-007.png");
    assert.equal(videoPayload.sourceFlowAssetKey, "path:https://flow.google/assets/scene-007");
    assert.equal(videoPayload.videoSettings.model, "veo-3.1-lite");
    socket.send(JSON.stringify({
      type: "JOB_DONE",
      jobId: videoJob.jobId,
      result: {
        sceneId: "scene-007",
        mediaType: "video",
        resultPath: "C:\\FlowX\\scene-007.mp4",
        flowAssetKey: "",
      },
    }));
    const videoResult = await videoResultPromise;
    assert.equal(videoResult.resultPath, "C:\\FlowX\\scene-007.mp4");
  } finally {
    socket.terminate();
    server.stop();
  }
});
