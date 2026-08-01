import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import {
  DEFAULT_VISUAL_BIBLE,
  DEFAULT_TIMELINE_WORKFLOW_SOURCE,
  isDirectVideoWorkflowSource,
  normalizeStoredScenes,
  normalizeStyleReference,
  normalizeTimelineWorkflowSource,
  normalizeVideoWorkflowMode,
  normalizeVisualBible,
  type TimelineSession,
  type TimelineSessionDeleteResult,
  type TimelineSessionInput,
  type TimelineSessionSummary,
} from "../shared/timeline";
import { DEFAULT_PROJECT_ID } from "../shared/production-queue";

interface TimelineSessionDatabase {
  version: number;
  activeSessionId: string | null;
  sessions: TimelineSession[];
  session?: TimelineSession | null;
}

const DEFAULT_DATA: TimelineSessionDatabase = {
  version: 4,
  activeSessionId: null,
  sessions: [],
};

function normalizedName(value: unknown, fallback = "Phiên làm việc"): string {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return (name || fallback).slice(0, 100);
}

function normalizedId(value: unknown, fallback: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id) ? id : fallback;
}

function normalizeSession(value: unknown, fallbackId: string, fallbackName: string): TimelineSession | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<TimelineSession>;
  try {
    const savedAt = typeof input.savedAt === "string" ? input.savedAt : new Date().toISOString();
    const workflowSource = normalizeTimelineWorkflowSource(input.workflowSource);
    return {
      id: normalizedId(input.id, fallbackId),
      name: normalizedName(input.name, fallbackName),
      createdAt: typeof input.createdAt === "string" ? input.createdAt : savedAt,
      scenes: normalizeStoredScenes(input.scenes, {
        allowEmptyImagePrompts: isDirectVideoWorkflowSource(workflowSource),
      }),
      visualBible: normalizeVisualBible(input.visualBible),
      styleReference: normalizeStyleReference(input.styleReference),
      workflowMode: normalizeVideoWorkflowMode(input.workflowMode),
      workflowSource,
      savedAt,
    };
  } catch {
    return null;
  }
}

export class TimelineSessionStore {
  private readonly database: Low<TimelineSessionDatabase>;
  private initializePromise: Promise<void> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dataDirectory: string) {
    this.database = new Low(
      new JSONFile<TimelineSessionDatabase>(join(dataDirectory, "session.json")),
      structuredClone(DEFAULT_DATA),
    );
  }

  initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = (async () => {
        await mkdir(this.dataDirectory, { recursive: true });
        await this.database.read();
        const raw = this.database.data as TimelineSessionDatabase;
        const sessions = Array.isArray(raw.sessions)
          ? raw.sessions.flatMap((session, index) => {
            const normalized = normalizeSession(
              session,
              `session-${index + 1}`,
              `Phiên ${index + 1}`,
            );
            return normalized ? [normalized] : [];
          })
          : [];

        // Version 2 stored only one `session`. Preserve it as the legacy
        // project so its existing SQLite scenes and generated results remain linked.
        if (sessions.length === 0 && raw.session) {
          const migrated = normalizeSession(
            raw.session,
            DEFAULT_PROJECT_ID,
            "Phiên làm việc trước đây",
          );
          if (migrated) sessions.push(migrated);
        }

        const unique = new Map<string, TimelineSession>();
        for (const session of sessions) unique.set(session.id, session);
        const normalizedSessions = [...unique.values()];
        if (normalizedSessions.length === 0) {
          const now = new Date().toISOString();
          normalizedSessions.push({
            id: DEFAULT_PROJECT_ID,
            name: "Phiên 1",
            createdAt: now,
            scenes: [],
            visualBible: structuredClone(DEFAULT_VISUAL_BIBLE),
            styleReference: null,
            workflowMode: "two_step",
            workflowSource: structuredClone(DEFAULT_TIMELINE_WORKFLOW_SOURCE),
            savedAt: now,
          });
        }
        const requestedActive = typeof raw.activeSessionId === "string"
          ? raw.activeSessionId
          : null;
        this.database.data = {
          version: 4,
          activeSessionId: requestedActive && unique.has(requestedActive)
            ? requestedActive
            : normalizedSessions[0]?.id || null,
          sessions: normalizedSessions,
        };
        await this.database.write();
      })();
    }
    return this.initializePromise;
  }

  load(sessionId?: string): Promise<TimelineSession | null> {
    return this.enqueue(() => {
      const id = sessionId || this.database.data.activeSessionId;
      const session = this.database.data.sessions.find((entry) => entry.id === id);
      return session ? structuredClone(session) : null;
    });
  }

  list(): Promise<TimelineSessionSummary[]> {
    return this.enqueue(() => this.summaries());
  }

  create(name?: string): Promise<TimelineSession> {
    return this.enqueue(async () => {
      const now = new Date().toISOString();
      const session: TimelineSession = {
        id: `session-${randomUUID()}`,
        name: normalizedName(name, `Phiên ${this.database.data.sessions.length + 1}`),
        createdAt: now,
        scenes: [],
        visualBible: structuredClone(DEFAULT_VISUAL_BIBLE),
        styleReference: null,
        workflowMode: "two_step",
        workflowSource: structuredClone(DEFAULT_TIMELINE_WORKFLOW_SOURCE),
        savedAt: now,
      };
      this.database.data.sessions.push(session);
      this.database.data.activeSessionId = session.id;
      await this.database.write();
      return structuredClone(session);
    });
  }

  select(idValue: string): Promise<TimelineSession> {
    return this.enqueue(async () => {
      const id = normalizedId(idValue, "");
      const session = this.database.data.sessions.find((entry) => entry.id === id);
      if (!session) throw new Error("Không tìm thấy phiên làm việc.");
      this.database.data.activeSessionId = session.id;
      await this.database.write();
      return structuredClone(session);
    });
  }

  rename(idValue: string, nameValue: string): Promise<TimelineSessionSummary[]> {
    return this.enqueue(async () => {
      const id = normalizedId(idValue, "");
      const session = this.database.data.sessions.find((entry) => entry.id === id);
      if (!session) throw new Error("Không tìm thấy phiên làm việc.");
      session.name = normalizedName(nameValue);
      session.savedAt = new Date().toISOString();
      await this.database.write();
      return this.summaries();
    });
  }

  save(value: unknown, sessionId?: string): Promise<TimelineSession> {
    return this.enqueue(async () => {
      const input = value && typeof value === "object" && !Array.isArray(value)
        ? value as Partial<TimelineSessionInput>
        : null;
      const workflowSource = input && "workflowSource" in input
        ? normalizeTimelineWorkflowSource(input.workflowSource)
        : this.database.data.sessions.find((entry) =>
          entry.id === (sessionId || this.database.data.activeSessionId)
        )?.workflowSource || structuredClone(DEFAULT_TIMELINE_WORKFLOW_SOURCE);
      const scenes = normalizeStoredScenes(input?.scenes ?? value, {
        allowEmptyImagePrompts: isDirectVideoWorkflowSource(workflowSource),
      });
      let session = this.database.data.sessions.find((entry) =>
        entry.id === (sessionId || this.database.data.activeSessionId)
      );
      if (!session) {
        const now = new Date().toISOString();
        session = {
          id: sessionId || DEFAULT_PROJECT_ID,
          name: "Phiên làm việc",
          createdAt: now,
          scenes: [],
          visualBible: structuredClone(DEFAULT_VISUAL_BIBLE),
          styleReference: null,
          workflowMode: "two_step",
          workflowSource: structuredClone(DEFAULT_TIMELINE_WORKFLOW_SOURCE),
          savedAt: now,
        };
        this.database.data.sessions.push(session);
        this.database.data.activeSessionId = session.id;
      }
      // Empty scene arrays from a stale renderer must never erase a completed
      // Phase 3 timeline. Explicit deletion uses clear(), not save().
      if (scenes.length > 0 || session.scenes.length === 0) {
        session.scenes = scenes;
      }
      session.visualBible = input
        ? normalizeVisualBible(input.visualBible)
        : session.visualBible;
      session.styleReference = input && "styleReference" in input
        ? normalizeStyleReference(input.styleReference)
        : session.styleReference;
      session.workflowMode = input && "workflowMode" in input
        ? normalizeVideoWorkflowMode(input.workflowMode)
        : session.workflowMode;
      session.workflowSource = input && "workflowSource" in input
        ? workflowSource
        : session.workflowSource;
      session.savedAt = new Date().toISOString();
      this.database.data.version = 4;
      await this.database.write();
      return structuredClone(session);
    });
  }

  clear(): Promise<void> {
    return this.enqueue(async () => {
      const session = this.database.data.sessions.find((entry) =>
        entry.id === this.database.data.activeSessionId
      );
      if (!session) return;
      session.scenes = [];
      session.visualBible = structuredClone(DEFAULT_VISUAL_BIBLE);
      session.styleReference = null;
      session.workflowSource = structuredClone(DEFAULT_TIMELINE_WORKFLOW_SOURCE);
      session.savedAt = new Date().toISOString();
      await this.database.write();
    });
  }

  delete(idValue: string): Promise<TimelineSessionDeleteResult> {
    return this.enqueue(async () => {
      const id = normalizedId(idValue, "");
      const index = this.database.data.sessions.findIndex((entry) => entry.id === id);
      if (index < 0) throw new Error("Không tìm thấy phiên làm việc.");
      this.database.data.sessions.splice(index, 1);
      if (this.database.data.activeSessionId === id) {
        this.database.data.activeSessionId =
          this.database.data.sessions[Math.min(index, this.database.data.sessions.length - 1)]?.id || null;
      }
      await this.database.write();
      const activeSession = this.database.data.sessions.find((entry) =>
        entry.id === this.database.data.activeSessionId
      ) || null;
      return {
        sessions: this.summaries(),
        activeSession: activeSession ? structuredClone(activeSession) : null,
      };
    });
  }

  private summaries(): TimelineSessionSummary[] {
    return this.database.data.sessions
      .map((session) => ({
        id: session.id,
        name: session.name,
        sceneCount: session.scenes.length,
        createdAt: session.createdAt,
        savedAt: session.savedAt,
        active: session.id === this.database.data.activeSessionId,
        workflowMode: session.workflowMode,
      }))
      .sort((left, right) => right.savedAt.localeCompare(left.savedAt));
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.operationQueue.then(async () => {
      await this.initialize();
      return operation();
    });
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
