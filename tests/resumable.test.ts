import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
const data = mkdtempSync(join(tmpdir(), "ffast-resume-"));
process.env.DATA_DIR = data;
process.env.MAX_UPLOAD_SIZE_BYTES = "20000000";
const { db } = await import("@/lib/db");
const { createUpload, writeChunk, uploadStatus, finishUpload, cancelSession, cleanupUploads, locked, CHUNK_SIZE } = await import("@/lib/resumable");
const { GET, HEAD } = await import("@/app/download/[token]/route");
const { POST } = await import("@/app/api/uploads/route");
const hash = (body: string | Buffer) => createHash("sha256").update(body).digest("hex");
const chunk = (body: string | Buffer) => new Request("http://localhost", { method: "PUT", body: typeof body === "string" ? body : new Uint8Array(body) });
afterAll(() => { db.close(); rmSync(data, { recursive: true, force: true }); });
describe("persistent resumable uploads", () => {
  it("confirms only validated chunks, safely retries and completes once", async () => {
    const task = await createUpload({ name: "测试.txt", size: 5, hashes: [hash("hello")] });
    await expect(writeChunk(task.id, 0, chunk("wrong"))).rejects.toThrow("校验");
    expect((await uploadStatus(task.id)).confirmed).toEqual([]);
    await expect(writeChunk(task.id, 1, chunk("hello"))).rejects.toThrow("编号");
    await expect(writeChunk(task.id, 0, chunk("hello!"))).rejects.toThrow("大小");
    await writeChunk(task.id, 0, chunk("hello"));
    await writeChunk(task.id, 0, chunk("hello"));
    expect((await uploadStatus(task.id)).confirmed).toEqual([0]);
    const first = await finishUpload(task.id);
    expect(await finishUpload(task.id)).toEqual(first);
    expect(db.prepare("SELECT count(*) AS n FROM files WHERE id = ?").get(first.id)).toEqual({ n: 1 });
    expect(await fs.readFile(join(data, "files", first.id), "utf8")).toBe("hello");
  });
  it("preserves checkpoints across reopening SQLite and prevents premature publication", async () => {
    const bytes = Buffer.alloc(CHUNK_SIZE, 7);
    const task = await createUpload({ name: "large", size: CHUNK_SIZE + 1, hashes: [hash(bytes), hash("x")] });
    await writeChunk(task.id, 0, chunk(bytes));
    const Database = (await import("better-sqlite3")).default;
    const reopened = new Database(join(data, "ffast.sqlite"));
    expect(reopened.prepare("SELECT size FROM uploads WHERE id = ?").get(task.id)).toEqual({ size: CHUNK_SIZE + 1 });
    reopened.close();
    expect((await uploadStatus(task.id)).confirmed).toEqual([0]);
    await expect(finishUpload(task.id)).rejects.toThrow("分片");
    expect(db.prepare("SELECT 1 FROM files WHERE id = ?").get(task.id)).toBeUndefined();
    await writeChunk(task.id, 1, chunk("x"));
    expect((await finishUpload(task.id)).size).toBe(CHUNK_SIZE + 1);
  });
  it("cleans cancellation, expiration and orphaned directories", async () => {
    const task = await createUpload({ name: "cancel", size: 1, hashes: [hash("x")] });
    await cancelSession(task.id);
    await expect(uploadStatus(task.id)).rejects.toMatchObject({ status: 410 });
    const expired = await createUpload({ name: "expired", size: 0, hashes: [] });
    db.prepare("UPDATE uploads SET updated = 0 WHERE id = ?").run(expired.id);
    cleanupUploads();
    await expect(uploadStatus(expired.id)).rejects.toMatchObject({ status: 410 });
    await expect(fs.stat(join(data, "tmp", "resumable", expired.id))).rejects.toThrow();
  });
  it("handles empty files, validation, limits and authentication", async () => {
    const empty = await createUpload({ name: "empty", size: 0, hashes: [] });
    expect((await finishUpload(empty.id)).size).toBe(0);
    await expect(createUpload({ name: "big", size: 20000001, hashes: [hash("x"), hash("x"), hash("x")] })).rejects.toMatchObject({ status: 413 });
    await expect(createUpload({ name: "invalid", size: -1, hashes: [] })).rejects.toThrow();
    expect((await POST(new Request("http://localhost/api/uploads", { method: "POST" }))).status).toBe(401);
  });
  it("requires a trusted origin for authenticated mutations and returns invalid JSON as 400", async () => {
    const { createSession } = await import("@/lib/auth");
    const cookie = `ffast_session=${createSession()}`;
    const invalidOrigin = new Request("http://localhost/api/uploads", { method: "POST", headers: { cookie, origin: "https://evil.test" }, body: "{}" });
    expect((await POST(invalidOrigin)).status).toBe(403);
    const malformed = new Request("http://localhost/api/uploads", { method: "POST", headers: { cookie, origin: "http://localhost" }, body: "{" });
    expect((await POST(malformed)).status).toBe(400);
  });
  it("serializes concurrent mutation and recovers after rejected operations", async () => {
    const order: number[] = [];
    await Promise.all([locked("test", async () => { await Promise.resolve(); order.push(1); }), locked("test", async () => { order.push(2); })]);
    expect(order).toEqual([1, 2]);
    await expect(locked("test", async () => { throw new Error("failure"); })).rejects.toThrow();
    expect(await locked("test", async () => 3)).toBe(3);
  });
});
describe("HTTP range downloads", () => {
  it("serves full, partial, suffix, HEAD, conditional and invalid requests", async () => {
    const task = await createUpload({ name: "range", size: 5, hashes: [hash("hello")] });
    await writeChunk(task.id, 0, chunk("hello"));
    const file = await finishUpload(task.id);
    const context = { params: Promise.resolve({ token: file.share_token }) };
    const request = (headers: Record<string, string> = {}, method = "GET") => new Request("http://localhost/download/token", { headers, method });
    const full = await GET(request(), context);
    expect(await full.text()).toBe("hello");
    const etag = full.headers.get("etag")!;
    for (const [range, body] of [["bytes=1-3", "ell"], ["bytes=2-", "llo"], ["bytes=-2", "lo"], ["bytes=0-100", "hello"]]) {
      const result = await GET(request({ range }), context);
      expect(result.status).toBe(206);
      expect(result.headers.get("content-length")).toBe(String(body.length));
      expect(await result.text()).toBe(body);
    }
    for (const range of ["bytes=5-", "bytes=3-1", "bytes=-0"]) {
      const result = await GET(request({ range }), context);
      expect(result.status).toBe(416);
      expect(result.headers.get("content-range")).toBe("bytes */5");
    }
    for (const range of ["bad", "bytes=0-1,3-4"]) expect((await GET(request({ range }), context)).status).toBe(200);
    expect((await GET(request({ range: "bytes=1-", "if-range": etag }), context)).status).toBe(206);
    expect((await GET(request({ range: "bytes=1-", "if-range": '"different"' }), context)).status).toBe(200);
    expect((await GET(request({ range: "bytes=1-", "if-range": full.headers.get("last-modified")! }), context)).status).toBe(206);
    const head = await HEAD(request({}, "HEAD"), context);
    expect(head.headers.get("content-length")).toBe("5");
    expect(await head.text()).toBe("");
    db.prepare("DELETE FROM files WHERE id = ?").run(file.id);
    expect((await GET(request(), context)).status).toBe(404);
  });
  it("serves empty files and rejects ranges for them", async () => {
    const task = await createUpload({ name: "empty", size: 0, hashes: [] });
    const file = await finishUpload(task.id);
    const context = { params: Promise.resolve({ token: file.share_token }) };
    expect(await (await GET(new Request("http://localhost"), context)).text()).toBe("");
    expect((await GET(new Request("http://localhost", { headers: { range: "bytes=0-" } }), context)).status).toBe(416);
  });
});
