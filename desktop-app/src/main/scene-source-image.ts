import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { SceneReferenceImage } from "../shared/scene-job";

const MAX_SOURCE_IMAGE_BYTES = 30 * 1024 * 1024;

function sourceImageMimeType(path: string): SceneReferenceImage["mimeType"] {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "image/jpeg";
}

export async function resolveSceneSourceImage(
  path: string,
): Promise<SceneReferenceImage | null> {
  if (!path) return null;
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error("Ảnh nguồn video không hợp lệ hoặc vượt quá 30 MB");
  }
  return {
    token: "@SOURCE_FRAME",
    name: basename(path),
    mimeType: sourceImageMimeType(path),
    imageBase64: (await readFile(path)).toString("base64"),
    localPath: path,
  };
}
