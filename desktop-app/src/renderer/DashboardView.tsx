import { useEffect, useMemo, useState } from "react";
import type { ProductionQueueSnapshot } from "../shared/production-queue";
import type { OutputInspection } from "../shared/system";
import type { TimelineSession } from "../shared/timeline";
import type { WorkerStatuses } from "../shared/worker-status";
import {
  DEFAULT_PROVIDER_SETTINGS,
  type ProviderSettings,
} from "../shared/provider";
import type { AppPage } from "./app-navigation";
import { readHomeWorkflowMode } from "./home-workflow-state";
import type { HomeWorkflowMode } from "./integrated-workflow";
import { deriveHomepageState, type HomeCharacterSummary } from "./home/homepage-model";
import { NewSessionHome } from "./home/NewSessionHome";
import { ProductionHome } from "./home/ProductionHome";
import { SetupHome } from "./home/SetupHome";

const EMPTY_CHARACTERS: HomeCharacterSummary = { total: 0, main: 0, recurring: 0 };

export function DashboardView({
  session,
  queue,
  output,
  workers,
  onStartWorkflow,
  onStartConfiguredWorkflow,
  onRenameSession,
  onDeleteSession,
  onNavigate,
  onOpenScene,
  onStartProduction,
  onPause,
  onResume,
  onStop,
  onRetry,
  onBuildVideo,
  onCheckConnections,
}: {
  session: TimelineSession | null;
  queue: ProductionQueueSnapshot | null;
  output: OutputInspection | null;
  workers: WorkerStatuses;
  onStartWorkflow: (mode: HomeWorkflowMode) => Promise<boolean>;
  onStartConfiguredWorkflow: () => Promise<boolean>;
  onRenameSession: (name: string) => Promise<boolean>;
  onDeleteSession: () => Promise<boolean>;
  onNavigate: (page: AppPage) => void;
  onOpenScene: (sceneId: string) => void;
  onStartProduction: () => Promise<void>;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onStop: () => Promise<void>;
  onRetry: (sceneIds?: string[]) => Promise<void>;
  onBuildVideo: () => void;
  onCheckConnections: () => Promise<void>;
}) {
  const [characters, setCharacters] = useState<HomeCharacterSummary>(EMPTY_CHARACTERS);
  const [providerSettings, setProviderSettings] = useState<ProviderSettings>(
    DEFAULT_PROVIDER_SETTINGS,
  );
  const mode = readHomeWorkflowMode(session);
  const state = deriveHomepageState(session, mode);

  useEffect(() => {
    document.querySelector<HTMLElement>(".kc-main-workspace")?.scrollTo({ top: 0 });
  }, [session?.id, state]);

  useEffect(() => {
    let active = true;
    void window.flowx?.providerSettings.get().then(
      (settings) => {
        if (active) setProviderSettings(settings);
      },
      () => {
        if (active) setProviderSettings(DEFAULT_PROVIDER_SETTINGS);
      },
    );
    return () => {
      active = false;
    };
  }, [state]);

  useEffect(() => {
    let active = true;
    if (state !== "setup-in-progress") return () => { active = false; };
    void window.flowx?.characters.list().then((items) => {
      if (!active) return;
      setCharacters({
        total: items.length,
        main: items.filter((item) => item.isMain).length,
        recurring: items.filter((item) => item.isRecurring !== false).length,
      });
    }, () => { if (active) setCharacters(EMPTY_CHARACTERS); });
    return () => { active = false; };
  }, [session?.id, state]);

  const view = useMemo(() => {
    if (state === "new-session") {
      return <NewSessionHome session={session} onSelectMode={onStartWorkflow} onRename={onRenameSession} onOpenSessions={() => onNavigate("sessions")} onDelete={onDeleteSession} />;
    }
    if (state === "setup-in-progress" && session && mode) {
      return <SetupHome session={session} mode={mode} characters={characters} workers={workers} textProvider={providerSettings.textProvider} imageProvider={providerSettings.imageProvider} videoProvider={providerSettings.videoProvider} onNavigate={onNavigate} onStart={onStartConfiguredWorkflow} />;
    }
    if (session && mode) {
      return <ProductionHome session={session} mode={mode} queue={queue} output={output} workers={workers} textProvider={providerSettings.textProvider} onNavigate={onNavigate} onOpenScene={onOpenScene} onStart={onStartProduction} onPause={onPause} onResume={onResume} onStop={onStop} onRetry={onRetry} onBuildVideo={onBuildVideo} onCheckConnections={onCheckConnections} />;
    }
    return null;
  }, [characters, mode, onBuildVideo, onCheckConnections, onDeleteSession, onNavigate, onOpenScene, onPause, onRenameSession, onResume, onRetry, onStartConfiguredWorkflow, onStartProduction, onStartWorkflow, onStop, output, providerSettings, queue, session, state, workers]);

  return <div className={`kc-dashboard-v2 is-${state}`} data-homepage-state={state}>{view}</div>;
}
