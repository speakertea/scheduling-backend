import { Elysia, t } from "elysia";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { query } from "../db";
import { authGuard } from "./guard";

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB

function getS3Client(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

export const avatarRoutes = new Elysia({ prefix: "/profile" })
  .use(authGuard)

  .post("/avatar", async ({ userId, body, set }) => {
    // Strip data-URL prefix if the client sends one (e.g. "data:image/jpeg;base64,...")
    const raw = body.image.replace(/^data:image\/\w+;base64,/, "");

    // Decode and size-check before touching R2
    const buffer = Buffer.from(raw, "base64");
    if (buffer.byteLength > MAX_BYTES) {
      set.status = 400;
      return { error: "Image must be under 2 MB." };
    }

    // Detect MIME type from the first bytes (magic numbers)
    const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
    if (!isPng && !isJpeg) {
      set.status = 400;
      return { error: "Only JPEG and PNG images are supported." };
    }
    const contentType = isPng ? "image/png" : "image/jpeg";

    const bucket = process.env.R2_BUCKET_NAME!;
    const key = `avatars/${userId}.jpg`;

    try {
      await getS3Client().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: buffer,
          ContentType: contentType,
        })
      );
    } catch (err: any) {
      console.error("[avatar] R2 upload failed:", err.name, err.message, err.$metadata ?? "");
      set.status = 500;
      return { error: "Failed to upload image. Please try again." };
    }

    // Cache-bust with a timestamp so clients don't show a stale photo
    const url = `${process.env.R2_PUBLIC_URL}/${key}?v=${Date.now()}`;

    await query("UPDATE users SET profile_picture = $1 WHERE id = $2", [url, userId]);

    return { url };
  }, {
    body: t.Object({
      image: t.String(),
    }),
  });
