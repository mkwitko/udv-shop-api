import { z } from "zod";

export const IMAGE_CONTENT_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
} as const;

export const PresignUploadBody = z.object({
  storeSlug: z.string().min(1),
  contentType: z.enum(Object.keys(IMAGE_CONTENT_TYPES) as [string, ...string[]]),
});
export type PresignUploadBody = z.infer<typeof PresignUploadBody>;

export const PresignUploadResponse = z.object({
  key: z.string(),
  uploadUrl: z.string(),
  publicUrl: z.string(),
});
