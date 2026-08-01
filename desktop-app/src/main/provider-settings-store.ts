import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import {
  DEFAULT_PROVIDER_SETTINGS,
  normalizeProviderSettings,
  type ProviderSettings,
  type ProviderSettingsInput,
} from "../shared/provider";

interface ProviderSettingsDatabase {
  settings: ProviderSettings;
}

export class ProviderSettingsStore {
  private readonly database: Low<ProviderSettingsDatabase>;
  private initializePromise: Promise<void> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dataDirectory: string) {
    this.database = new Low(
      new JSONFile<ProviderSettingsDatabase>(join(dataDirectory, "provider-settings.json")),
      { settings: { ...DEFAULT_PROVIDER_SETTINGS } },
    );
  }

  initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = (async () => {
        await mkdir(this.dataDirectory, { recursive: true });
        await this.database.read();
        this.database.data = {
          settings: normalizeProviderSettings(this.database.data.settings),
        };
        await this.database.write();
      })();
    }
    return this.initializePromise;
  }

  get(): Promise<ProviderSettings> {
    return this.enqueue(() => ({ ...this.database.data.settings }));
  }

  save(input: ProviderSettingsInput): Promise<ProviderSettings> {
    return this.enqueue(async () => {
      this.database.data.settings = normalizeProviderSettings({
        ...this.database.data.settings,
        ...input,
        updatedAt: new Date().toISOString(),
      });
      await this.database.write();
      return { ...this.database.data.settings };
    });
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
