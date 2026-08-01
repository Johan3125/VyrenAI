import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import {
  normalizeCharacterToken,
  parseCharacterTokens,
  type Character,
  type CharacterCreateInput,
  type CharacterImageInput,
  type CharacterUpdateInput,
  type CharacterView,
} from "../shared/character";
import type { SceneReferenceImage } from "../shared/scene-job";

interface CharacterDatabase {
  characters: Character[];
}

interface ValidatedImage {
  bytes: Buffer;
  extension: ".jpg" | ".png" | ".webp";
  mimeType: "image/jpeg" | "image/png" | "image/webp";
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_DATA: CharacterDatabase = { characters: [] };

function normalizeName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Tên nhân vật không hợp lệ.");
  const name = value.trim();
  if (!name || name.length > 80) {
    throw new Error("Tên nhân vật phải có từ 1 đến 80 ký tự.");
  }
  return name;
}

function optionalMetadata(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function characterMetadata(input: CharacterCreateInput | CharacterUpdateInput) {
  return {
    role: optionalMetadata(input.role, 100),
    palette: optionalMetadata(input.palette, 200),
    appearance: optionalMetadata(input.appearance, 1_000),
    clothing: optionalMetadata(input.clothing, 1_000),
    isMain: Boolean(input.isMain),
    isRecurring: Boolean(input.isRecurring),
    detailsLocked: Boolean(input.detailsLocked),
  };
}

function requireToken(value: unknown): string {
  if (typeof value !== "string") throw new Error("Token không hợp lệ.");
  const token = normalizeCharacterToken(value);
  if (!token) {
    throw new Error("Token chỉ được chứa chữ cái, chữ số hoặc dấu gạch dưới.");
  }
  return token;
}

function toBuffer(value: unknown): Buffer {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error("Dữ liệu ảnh không hợp lệ.");
}

function hasBytes(bytes: Buffer, expected: number[], offset = 0): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function validateImage(input: CharacterImageInput): ValidatedImage {
  if (!input || typeof input !== "object") {
    throw new Error("Vui lòng chọn ảnh tham chiếu.");
  }

  const bytes = toBuffer(input.bytes);
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error("Ảnh tham chiếu phải nhỏ hơn 10 MB.");
  }

  if (
    hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return { bytes, extension: ".png", mimeType: "image/png" };
  }

  if (
    hasBytes(bytes, [0xff, 0xd8, 0xff])
  ) {
    return { bytes, extension: ".jpg", mimeType: "image/jpeg" };
  }

  if (
    hasBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    hasBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return { bytes, extension: ".webp", mimeType: "image/webp" };
  }

  throw new Error("Chỉ chấp nhận ảnh PNG, JPEG hoặc WebP hợp lệ.");
}

function mimeTypeForPath(path: string): string | null {
  return {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  }[extname(path).toLowerCase()] ?? null;
}

export class CharacterStore {
  private readonly imagesDirectory: string;
  private readonly database: Low<CharacterDatabase>;
  private initializePromise: Promise<void> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dataDirectory: string) {
    this.imagesDirectory = join(dataDirectory, "images");
    this.database = new Low(
      new JSONFile<CharacterDatabase>(join(dataDirectory, "characters.json")),
      structuredClone(DEFAULT_DATA),
    );
  }

  initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = (async () => {
        await mkdir(this.imagesDirectory, { recursive: true });
        await this.database.read();
        if (!Array.isArray(this.database.data.characters)) {
          this.database.data = structuredClone(DEFAULT_DATA);
          await this.database.write();
        }
      })();
    }
    return this.initializePromise;
  }

  list(): Promise<Character[]> {
    return this.enqueue(() =>
      this.database.data.characters.map((character) => ({ ...character })),
    );
  }

  listViews(): Promise<CharacterView[]> {
    return this.enqueue(() =>
      Promise.all(
        this.database.data.characters.map(async (character) => ({
          ...character,
          refImageDataUrl: await this.readImageDataUrl(character.refImagePath),
        })),
      ),
    );
  }

  resolvePromptReferences(prompt: string): Promise<SceneReferenceImage[]> {
    return this.resolveReferences(parseCharacterTokens(prompt));
  }

  resolveReferences(tokenValues: unknown): Promise<SceneReferenceImage[]> {
    return this.enqueue(async () => {
      const tokens = Array.isArray(tokenValues)
        ? [...new Set(tokenValues.map((value) =>
          typeof value === "string" ? normalizeCharacterToken(value) : null,
        ).filter((value): value is string => Boolean(value)))]
        : [];
      if (tokens.length > 4) {
        throw new Error("Mỗi scene chỉ hỗ trợ tối đa 4 nhân vật tham chiếu.");
      }
      const references: SceneReferenceImage[] = [];

      for (const token of tokens) {
        const character = this.database.data.characters.find(
          (entry) => entry.token === token,
        );
        if (!character) {
          throw new Error(
            `Prompt có ${token} nhưng chưa có nhân vật tương ứng trong thư viện.`,
          );
        }
        if (!this.isManagedImage(character.refImagePath)) {
          throw new Error(`Ảnh tham chiếu của ${token} không hợp lệ.`);
        }
        const mimeType = mimeTypeForPath(character.refImagePath);
        if (!mimeType) {
          throw new Error(`Ảnh tham chiếu của ${token} không được hỗ trợ.`);
        }
        const bytes = await readFile(character.refImagePath);
        references.push({
          token,
          name: character.name,
          mimeType: mimeType as SceneReferenceImage["mimeType"],
          imageBase64: bytes.toString("base64"),
          localPath: character.refImagePath,
        });
      }

      return references;
    });
  }

  create(input: CharacterCreateInput): Promise<Character> {
    return this.enqueue(async () => {
      if (!input || typeof input !== "object") {
        throw new Error("Dữ liệu nhân vật không hợp lệ.");
      }
      const token = requireToken(input?.token);
      const name = normalizeName(input?.name);
      if (this.findIndex(token) !== -1) {
        throw new Error(`Token ${token} đã tồn tại.`);
      }

      const imagePath = await this.saveImage(validateImage(input?.image));
      const character = { token, name, refImagePath: imagePath, ...characterMetadata(input) };
      this.database.data.characters.push(character);

      try {
        await this.database.write();
      } catch (error) {
        this.database.data.characters.pop();
        await this.removeImage(imagePath);
        throw error;
      }

      return { ...character };
    });
  }

  update(input: CharacterUpdateInput): Promise<Character> {
    return this.enqueue(async () => {
      if (!input || typeof input !== "object") {
        throw new Error("Dữ liệu nhân vật không hợp lệ.");
      }
      const originalToken = requireToken(input?.originalToken);
      const token = requireToken(input?.token);
      const name = normalizeName(input?.name);
      const index = this.findIndex(originalToken);
      if (index === -1) throw new Error(`Không tìm thấy ${originalToken}.`);

      const duplicateIndex = this.findIndex(token);
      if (duplicateIndex !== -1 && duplicateIndex !== index) {
        throw new Error(`Token ${token} đã tồn tại.`);
      }

      const previous = this.database.data.characters[index];
      const nextImagePath = input.image
        ? await this.saveImage(validateImage(input.image))
        : previous.refImagePath;
      const next = { token, name, refImagePath: nextImagePath, ...characterMetadata(input) };
      this.database.data.characters[index] = next;

      try {
        await this.database.write();
      } catch (error) {
        this.database.data.characters[index] = previous;
        if (nextImagePath !== previous.refImagePath) {
          await this.removeImage(nextImagePath);
        }
        throw error;
      }

      if (nextImagePath !== previous.refImagePath) {
        await this.removeImage(previous.refImagePath);
      }
      return { ...next };
    });
  }

  remove(tokenValue: string): Promise<void> {
    return this.enqueue(async () => {
      const token = requireToken(tokenValue);
      const index = this.findIndex(token);
      if (index === -1) throw new Error(`Không tìm thấy ${token}.`);

      const [removed] = this.database.data.characters.splice(index, 1);
      try {
        await this.database.write();
      } catch (error) {
        this.database.data.characters.splice(index, 0, removed);
        throw error;
      }
      await this.removeImage(removed.refImagePath);
    });
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.operationQueue.then(async () => {
      await this.initialize();
      return operation();
    });
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private findIndex(token: string): number {
    return this.database.data.characters.findIndex(
      (character) => character.token === token,
    );
  }

  private async saveImage(image: ValidatedImage): Promise<string> {
    const path = join(this.imagesDirectory, `${randomUUID()}${image.extension}`);
    await writeFile(path, image.bytes, { flag: "wx" });
    return path;
  }

  private async readImageDataUrl(path: string): Promise<string | null> {
    if (!this.isManagedImage(path)) return null;
    const mimeType = mimeTypeForPath(path);
    if (!mimeType) return null;

    try {
      const bytes = await readFile(path);
      return `data:${mimeType};base64,${bytes.toString("base64")}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async removeImage(path: string): Promise<void> {
    if (!this.isManagedImage(path)) return;
    await rm(path, { force: true });
  }

  private isManagedImage(path: string): boolean {
    if (typeof path !== "string" || !isAbsolute(path)) return false;
    const fromImagesDirectory = relative(
      resolve(this.imagesDirectory),
      resolve(path),
    );
    return (
      fromImagesDirectory !== "" &&
      fromImagesDirectory !== ".." &&
      !fromImagesDirectory.startsWith(`..\\`) &&
      !fromImagesDirectory.startsWith("../") &&
      !isAbsolute(fromImagesDirectory)
    );
  }
}
