export const MEDIA_READ_IMAGE_CHANNEL = "media:read-image";
export const MEDIA_GET_STREAM_URL_CHANNEL = "media:get-stream-url";

export interface MediaBridge {
  readImageDataUrl: (path: string) => Promise<string>;
  getStreamUrl: (path: string) => Promise<string>;
}
