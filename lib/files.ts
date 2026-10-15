import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { db, filesDirectory, getMaxUploadBytes, tempDirectory } from "@/lib/db";

export type FileRecord = {
  id: string;
  file_name: string;
  size: number;
  share_token: string;
  created_at: number;
};

export class UploadTooLargeError extends Error {
  constructor() {
    super("文件超过当前服务的上传大小上限。");
  }
}

export function sanitizeFileName(encodedName: string | null) {
  if (!encodedName) return "未命名文件";
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedName);
  } catch {
    throw new Error("文件名格式无效。");
  }

  const normalized = basename(decoded.replaceAll("\\", "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 240);
  return normalized || "未命名文件";
}

export function publicDownloadUrl(request: Request, token: string) {
  const baseUrl = process.env.PUBLIC_BASE_URL || new URL(request.url).origin;
  return new URL(`/download/${token}`, baseUrl).toString();
}

export function listFiles() {
  return db.prepare("SELECT id, file_name, size, share_token, created_at FROM files ORDER BY created_at DESC").all() as FileRecord[];
}

export function getFileById(id: string) {
  return db.prepare("SELECT id, file_name, size, share_token, created_at FROM files WHERE id = ?").get(id) as
    | FileRecord
    | undefined;
}

export function getFileByToken(token: string) {
  return db.prepare("SELECT id, file_name, size, share_token, created_at FROM files WHERE share_token = ?").get(token) as
    | FileRecord
    | undefined;
}

export async function saveUploadedFile(request: Request, fileName: string) {
  const maxBytes = getMaxUploadBytes();
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > maxBytes) throw new UploadTooLargeError();
  if (!request.body && contentLength > 0) throw new Error("上传内容不完整。");

  const id = randomUUID();
  const tempPath = join(tempDirectory, `${id}.part`);
  const finalPath = join(filesDirectory, id);
  let size = 0;

  const counter = new Transform({
    transform(chunk: Buffer | Uint8Array, _encoding, callback) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        callback(new UploadTooLargeError());
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    if (request.body) {
      const source = Readable.fromWeb(request.body as import("node:stream/web").ReadableStream<Uint8Array>);
      await pipeline(source, counter, createWriteStream(tempPath, { flags: "wx", mode: 0o600 }));
    } else {
      // A zero-byte file may arrive without a request body stream at all.
      await fs.writeFile(tempPath, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
    }
    await fs.rename(tempPath, finalPath);

    const shareToken = randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO files(id, file_name, size, share_token, created_at) VALUES (?, ?, ?, ?, ?)").run(
      id,
      fileName,
      size,
      shareToken,
      Date.now(),
    );

    return getFileById(id)!;
  } catch (error) {
    try {
      db.prepare("DELETE FROM files WHERE id = ?").run(id);
    } catch {
      // Keep the original upload error if cleanup encounters a database failure.
    }
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    await fs.rm(finalPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function deleteStoredFile(file: FileRecord) {
  await fs.rm(join(filesDirectory, file.id), { force: true });
  db.prepare("DELETE FROM files WHERE id = ?").run(file.id);
}

export function encodeDownloadFileName(fileName: string) {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\;]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
