import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import { chunkHash } from "@/lib/chunk-hash";
import { transferFile, savedUploads, saveUpload, forgetUpload } from "@/lib/resumable-client";
afterEach(() => vi.unstubAllGlobals());
const file = new File(["hello"], "file.txt", { lastModified: 123 });
const digest = createHash("sha256").update("hello").digest("hex");
const done = { id: "file", name: file.name, size: 5, createdAt: 1, downloadUrl: "/download/token" };
function callbacks() { return { onSession: vi.fn(), onProgress: vi.fn(), onCheckpoint: vi.fn(), onProcessing: vi.fn() }; }
function state(extra = {}) { return { id: "session", name: file.name, size: 5, hashes: [digest], confirmed: [0], ...extra }; }
function mockFetch(responses: unknown[]) {
  const fetcher = vi.fn().mockImplementation(async () => Response.json(responses.shift()));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
describe("browser resume", () => {
  it("reselects and verifies the file, skipping confirmed chunks", async () => {
    const fetcher = mockFetch([state(), done]);
    const cb = callbacks();
    expect(await transferFile(file, new AbortController().signal, "session", cb)).toEqual(done);
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(["/api/uploads/session", "/api/uploads/session/complete"]);
    expect(cb.onCheckpoint).toHaveBeenCalledWith(5);
    expect(cb.onProcessing).toHaveBeenCalledOnce();
  });
  it("creates a session, sends an unconfirmed chunk and publishes after acknowledgement", async () => {
    mockFetch([state({ confirmed: [] }), done]);
    const sent: Blob[] = [];
    class MockXHR {
      status = 200; upload = { onprogress: null }; onload: (() => void) | null = null; onerror = null; onabort = null;
      open() {} setRequestHeader() {} abort() {}
      send(body: Blob) { sent.push(body); queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal("XMLHttpRequest", MockXHR);
    const cb = callbacks();
    expect(await transferFile(file, new AbortController().signal, undefined, cb)).toEqual(done);
    expect(await sent[0].text()).toBe("hello");
    expect(cb.onCheckpoint.mock.calls.map(call => call[0])).toEqual([0, 5]);
  });
  it("rejects changed content before sending chunks", async () => {
    mockFetch([state({ hashes: ["0".repeat(64)] })]);
    await expect(transferFile(file, new AbortController().signal, "session", callbacks())).rejects.toThrow("不一致");
  });
  it("recovers a lost completion response without uploading again", async () => {
    const fetcher = mockFetch([state({ file: done })]);
    expect(await transferFile(file, new AbortController().signal, "session", callbacks())).toEqual(done);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("supports pause during hashing and propagates auth/expiry failures", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(transferFile(file, controller.signal, undefined, callbacks())).rejects.toMatchObject({ name: "AbortError" });
    for (const status of [401, 410]) {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "expired" }, { status })));
      await expect(transferFile(file, new AbortController().signal, "session", callbacks())).rejects.toMatchObject({ status });
    }
  });
  it("persists only descriptors and restores after reload", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) });
    const record = { id: "task", sessionId: "session", name: file.name, size: 5, lastModified: 123, loadedBytes: 5, updated: Date.now() };
    saveUpload(record);
    expect(savedUploads()).toEqual([expect.objectContaining({ ...record, updated: expect.any(Number) })]);
    expect(savedUploads()[0].updated).toBeGreaterThanOrEqual(record.updated);
    expect([...values.values()][0]).not.toContain("hello");
    forgetUpload("task"); expect(savedUploads()).toEqual([]);
  });
  it("aborts an in-flight chunk and resumes after a network failure", async () => {
    let current: { onerror: (() => void) | null; onabort: (() => void) | null; upload: { onprogress: unknown }; send: () => void; abort: () => void };
    class MockXHR {
      upload = { onprogress: null }; onload = null; onerror = null; onabort: (() => void) | null = null;
      constructor() { current = this; }
      open() {} setRequestHeader() {} send() {} abort() { this.onabort?.(); }
    }
    vi.stubGlobal("XMLHttpRequest", MockXHR);
    mockFetch([state({ confirmed: [] })]);
    const controller = new AbortController();
    const promise = transferFile(file, controller.signal, "session", callbacks());
    await vi.waitFor(() => expect(current).toBeDefined());
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    current = undefined as never;
    mockFetch([state({ confirmed: [] })]);
    const failed = transferFile(file, new AbortController().signal, "session", callbacks());
    await vi.waitFor(() => expect(current).toBeDefined());
    current!.onerror?.();
    await expect(failed).rejects.toThrow("网络中断");
    mockFetch([state(), done]);
    expect(await transferFile(file, new AbortController().signal, "session", callbacks())).toEqual(done);
  });
});
describe("bounded SHA-256", () => {
  it("matches standard digests with and without Web Crypto", async () => {
    for (const crypto of [undefined, webcrypto]) {
      vi.stubGlobal("crypto", crypto);
      for (const size of [0, 3, 55, 56, 64, 1000, 300000]) {
        const bytes = new Uint8Array(size).fill(97);
        expect(await chunkHash(bytes.buffer)).toBe(createHash("sha256").update(bytes).digest("hex"));
      }
    }
  });
});
