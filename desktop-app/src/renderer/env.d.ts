import type { KCAutoToolBridge } from "../shared/worker-status";

declare global {
  interface Window {
    flowx?: KCAutoToolBridge;
  }
}

export {};
