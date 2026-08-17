import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export type R2Gateway = {
  presignPut(input: { key: string; contentType: string }): Promise<string>;
  publicUrl(key: string): string;
};

export function createR2Gateway(cfg: {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBaseUrl: string;
}): R2Gateway {
  let client: S3Client | undefined;
  const getClient = () => {
    client ??= new S3Client({
      region: "auto",
      endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
    return client;
  };
  return {
    presignPut: (input) =>
      getSignedUrl(
        getClient(),
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: input.key,
          ContentType: input.contentType,
        }),
        { expiresIn: 300 },
      ),
    publicUrl: (key) => `${cfg.publicBaseUrl.replace(/\/$/, "")}/${key}`,
  };
}
