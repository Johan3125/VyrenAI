import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import type {
  GraphicStylePreset,
  GraphicStyleSaveInput,
} from "../shared/visual-style";

interface VisualStyleDatabase {
  presets: GraphicStylePreset[];
}

const BUILT_IN_ID = "builtin-handdrawn-stickman-2d";
const BUILT_IN_STYLE = [
  "Hand-drawn 2D human stick-figure illustration, unmistakably human and never tree-like.",
  "Each person has one clean circular head, one straight-line torso, exactly two arms attached at the shoulders, and exactly two legs attached at the hips; stable human proportions and consistent line thickness.",
  "Simple expressive face with dot eyes, line eyebrows, and a small mouth that clearly shows the scene emotion.",
  "Bold slightly imperfect black ink outlines, flat colors only, simple geometric clothing and props, minimal soft grounding shadows, modern explainer-animation clarity.",
  "White canvas is only the base color: always draw the story-specific setting with readable foreground, middle-ground, and background objects; never isolate the character unless the scene explicitly requires an empty space.",
  "No tree branches, wood texture, plant anatomy, realistic body, realistic hands, detailed skin, 3D, photorealism, gradients, painterly texture, or cinematic depth of field.",
].join(" ");

const BUILT_IN_PRESET: GraphicStylePreset = {
  id: BUILT_IN_ID,
  name: "Người que vẽ tay 2D",
  style: BUILT_IN_STYLE,
  builtIn: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function normalizeName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Tên phong cách không hợp lệ.");
  const name = value.trim();
  if (!name || name.length > 80) {
    throw new Error("Tên phong cách phải có từ 1 đến 80 ký tự.");
  }
  return name;
}

function normalizeStyle(value: unknown): string {
  if (typeof value !== "string") throw new Error("Nội dung phong cách không hợp lệ.");
  const style = value.trim();
  if (!style || style.length > 8_000) {
    throw new Error("Nội dung phong cách phải có từ 1 đến 8.000 ký tự.");
  }
  return style;
}

function normalizedPreset(value: unknown): GraphicStylePreset | null {
  if (!value || typeof value !== "object") return null;
  const preset = value as Partial<GraphicStylePreset>;
  if (
    typeof preset.id !== "string" || !preset.id.trim() ||
    typeof preset.name !== "string" || !preset.name.trim() ||
    typeof preset.style !== "string" || !preset.style.trim()
  ) return null;
  const createdAt = typeof preset.createdAt === "string" ? preset.createdAt : new Date().toISOString();
  const updatedAt = typeof preset.updatedAt === "string" ? preset.updatedAt : createdAt;
  return {
    id: preset.id.trim(),
    name: preset.name.trim().slice(0, 80),
    style: preset.style.trim().slice(0, 8_000),
    builtIn: preset.id === BUILT_IN_ID || preset.builtIn === true,
    createdAt,
    updatedAt,
  };
}

export class VisualStyleStore {
  private readonly database: Low<VisualStyleDatabase>;
  private initializePromise: Promise<void> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dataDirectory: string) {
    this.database = new Low(
      new JSONFile<VisualStyleDatabase>(join(dataDirectory, "visual-styles.json")),
      { presets: [structuredClone(BUILT_IN_PRESET)] },
    );
  }

  initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = (async () => {
        await mkdir(this.dataDirectory, { recursive: true });
        await this.database.read();
        const stored = Array.isArray(this.database.data.presets)
          ? this.database.data.presets.map(normalizedPreset).filter((preset): preset is GraphicStylePreset => Boolean(preset))
          : [];
        const custom = stored.filter((preset) => preset.id !== BUILT_IN_ID && !preset.builtIn);
        this.database.data = { presets: [structuredClone(BUILT_IN_PRESET), ...custom] };
        await this.database.write();
      })();
    }
    return this.initializePromise;
  }

  list(): Promise<GraphicStylePreset[]> {
    return this.enqueue(() => this.database.data.presets.map((preset) => ({ ...preset })));
  }

  save(input: GraphicStyleSaveInput): Promise<GraphicStylePreset[]> {
    return this.enqueue(async () => {
      if (!input || typeof input !== "object") throw new Error("Dữ liệu phong cách không hợp lệ.");
      const name = normalizeName(input.name);
      const style = normalizeStyle(input.style);
      const duplicate = this.database.data.presets.find(
        (preset) => preset.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0,
      );
      if (duplicate?.builtIn) {
        throw new Error("Tên này thuộc preset mặc định. Hãy chọn tên khác.");
      }
      const now = new Date().toISOString();
      if (duplicate) {
        duplicate.style = style;
        duplicate.updatedAt = now;
      } else {
        this.database.data.presets.push({
          id: randomUUID(),
          name,
          style,
          builtIn: false,
          createdAt: now,
          updatedAt: now,
        });
      }
      await this.database.write();
      return this.database.data.presets.map((preset) => ({ ...preset }));
    });
  }

  remove(idValue: string): Promise<GraphicStylePreset[]> {
    return this.enqueue(async () => {
      const id = typeof idValue === "string" ? idValue.trim() : "";
      if (!id) throw new Error("Phong cách không hợp lệ.");
      const index = this.database.data.presets.findIndex((preset) => preset.id === id);
      if (index === -1) throw new Error("Không tìm thấy phong cách.");
      if (this.database.data.presets[index].builtIn) {
        throw new Error("Không thể xóa preset mặc định.");
      }
      this.database.data.presets.splice(index, 1);
      await this.database.write();
      return this.database.data.presets.map((preset) => ({ ...preset }));
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

