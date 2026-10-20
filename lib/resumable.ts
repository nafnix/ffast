import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { db, filesDirectory, getMaxUploadBytes, tempDirectory } from "@/lib/db";
import { getFileById, sanitizeFileName } from "@/lib/files";

export const CHUNK_SIZE = 8 * 1024 ** 2;
const TTL = 7 * 86400_000;
const directory = join(tempDirectory, "resumable");
mkdirSync(directory, { recursive: true, mode: 0o700 });
db.exec(`CREATE TABLE IF NOT EXISTS uploads (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL, hashes TEXT NOT NULL,
 updated INTEGER NOT NULL, file_id TEXT
)`);
type Session = { id: string; name: string; size: number; hashes: string; updated: number; file_id: string | null };
export class TransferError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const runtimeState = globalThis as typeof globalThis & { __ffastUploadLocks?: Map<string, Promise<unknown>> };
const locks = runtimeState.__ffastUploadLocks ??= new Map<string, Promise<unknown>>();
export async function locked<T>(id: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(action);
  locks.set(id, pending);
  try { return await pending; } finally { if (locks.get(id) === pending) locks.delete(id); }
}
export function cleanupUploads() {
  const expired = db.prepare("SELECT id FROM uploads WHERE updated < ?").all(Date.now() - TTL) as { id: string }[];
  for (const { id } of expired) {
    if (locks.has(id)) continue;
    rmSync(join(directory, id), { recursive: true, force: true });
    db.prepare("DELETE FROM uploads WHERE id = ?").run(id);
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !db.prepare("SELECT 1 FROM uploads WHERE id = ?").get(entry.name)) rmSync(join(directory, entry.name), { recursive: true, force: true });
  }
}
cleanupUploads();
function session(id: string) {
  const row = db.prepare("SELECT * FROM uploads WHERE id = ?").get(id) as Session | undefined;
  if (!row || row.updated < Date.now() - TTL) throw new TransferError("上传任务已过期，请重新上传。", 410);
  return row;
}
export async function uploadStatus(id: string) {
  const row = session(id);
  if (row.file_id && !getFileById(row.file_id)) throw new TransferError("文件已删除。", 410);
  const hashes = JSON.parse(row.hashes) as string[];
  const entries = await fs.readdir(join(directory, id)).catch(() => [] as string[]);
  return { id, name: row.name, size: row.size, chunkSize: CHUNK_SIZE, hashes,
    confirmed: hashes.map((_, i) => i).filter((i) => entries.includes(String(i))),
    file: row.file_id ? getFileById(row.file_id) : undefined };
}
export async function createUpload(input: { name?: unknown; size?: unknown; hashes?: unknown }) {
  const { name, size, hashes } = input;
  if (typeof name !== "string" || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || !Array.isArray(hashes) || hashes.length !== Math.ceil(size / CHUNK_SIZE) || hashes.some(h => typeof h !== "string" || !/^[a-f0-9]{64}$/.test(h))) throw new TransferError("上传信息无效。");
  if (size > getMaxUploadBytes()) throw new TransferError("文件超过服务器的大小上限。", 413);
  const id = randomUUID();
  mkdirSync(join(directory, id), { mode: 0o700 });
  db.prepare("INSERT INTO uploads(id,name,size,hashes,updated) VALUES(?,?,?,?,?)").run(id, sanitizeFileName(encodeURIComponent(name)), size, JSON.stringify(hashes), Date.now());
  return uploadStatus(id);
}
export async function writeChunk(id: string, index: number, request: Request) {
  const row = session(id);
  const hashes = JSON.parse(row.hashes) as string[];
  if (row.file_id) return uploadStatus(id);
  if (!Number.isSafeInteger(index) || index < 0 || index >= hashes.length) throw new TransferError("分片编号无效。");
  const expected = Math.min(CHUNK_SIZE, row.size - index * CHUNK_SIZE);
  const path = join(directory, id, `${index}.tmp`);
  const handle = await fs.open(path, "w", 0o600);
  let size = 0;
  const hash = createHash("sha256");
  try {
    if (!request.body) throw new TransferError("分片内容不完整。");
    const reader = request.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > expected) { await reader.cancel(); throw new TransferError("分片大小无效。"); }
        hash.update(value);
        await handle.writeFile(value);
      }
    } finally { reader.releaseLock(); }
    if (size !== expected || hash.digest("hex") !== hashes[index]) throw new TransferError("分片校验失败，请重试。");
    await handle.sync();
    await handle.close();
    await fs.rename(path, join(directory, id, String(index)));
    db.prepare("UPDATE uploads SET updated = ? WHERE id = ?").run(Date.now(), id);
    return uploadStatus(id);
  } finally { await handle.close().catch(() => {}); await fs.rm(path, { force: true }); }
}
export async function finishUpload(id: string) {
  const row = session(id);
  if (row.file_id) {
    const existing = getFileById(row.file_id);
    if (!existing) throw new TransferError("文件已删除。", 410);
    return existing;
  }
  const hashes = JSON.parse(row.hashes) as string[];
  // A deterministic final path allows safe recovery after a crash before the DB commit.
  const finalPath = join(filesDirectory, id);
  const assembled = join(directory, id, "assembled.tmp");
  const output = await fs.open(assembled, "w", 0o600);
  let size = 0;
  try {
    for (let i = 0; i < hashes.length; i++) {
      const bytes = await fs.readFile(join(directory, id, String(i))).catch(() => { throw new TransferError("尚有分片未上传。", 409); });
      if (createHash("sha256").update(bytes).digest("hex") !== hashes[i]) throw new TransferError("分片校验失败。", 409);
      size += bytes.length;
      await output.writeFile(bytes);
    }
    if (size !== row.size) throw new TransferError("文件大小校验失败。", 409);
    await output.sync();
  } finally { await output.close(); }
  await fs.rename(assembled, finalPath);
  db.transaction(() => {
    db.prepare("INSERT INTO files(id,file_name,size,share_token,created_at) VALUES(?,?,?,?,?)").run(id, row.name, size, randomBytes(32).toString("base64url"), Date.now());
    db.prepare("UPDATE uploads SET file_id = ?, updated = ? WHERE id = ?").run(id, Date.now(), id);
  })();
  await fs.rm(join(directory, id), { recursive: true, force: true });
  return getFileById(id)!;
}
export async function cancelSession(id: string) {
  const row = session(id);
  if (row.file_id) throw new TransferError("文件已完成上传。", 409);
  await fs.rm(join(directory, id), { recursive: true, force: true });
  db.prepare("DELETE FROM uploads WHERE id = ?").run(id);
}
