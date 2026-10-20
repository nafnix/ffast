import { chunkHash } from "@/lib/chunk-hash";
import type { ShareFile } from "@/app/files/file-manager";
export const CHUNK_SIZE = 8 * 1024 ** 2;
export function uploadTaskId() {
  return globalThis.crypto?.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
}
const KEY = "ffast.uploads.v1";
export type SavedUpload = { id: string; name: string; size: number; lastModified: number; sessionId?: string; loadedBytes: number; updated: number };
export function savedUploads(): SavedUpload[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is SavedUpload => v && typeof v.id === "string" && typeof v.name === "string" && Number.isSafeInteger(v.size) && v.size >= 0 && typeof v.lastModified === "number" && typeof v.loadedBytes === "number" && v.updated > Date.now() - 7 * 86400_000 && (v.sessionId === undefined || typeof v.sessionId === "string")) : [];
  } catch { return []; }
}
export function saveUpload(value: SavedUpload) {
  try { localStorage.setItem(KEY, JSON.stringify([...savedUploads().filter(v => v.id !== value.id), { ...value, updated: Date.now() }])); } catch { /* Server checkpoints remain usable in this page. */ }
}
export function forgetUpload(id: string) {
  try { localStorage.setItem(KEY, JSON.stringify(savedUploads().filter(v => v.id !== id))); } catch { /* Storage may be disabled. */ }
}
export async function transferFile(file: File, signal: AbortSignal, sessionId: string | undefined, callbacks: {
  onSession: (id: string) => void; onProgress: (bytes: number) => void; onCheckpoint: (bytes: number) => void; onProcessing: () => void;
}) {
  async function json(path: string, init?: RequestInit) {
    const response = await fetch(path, { ...init, signal, cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.error || "上传失败，请重试。"), { status: response.status });
    return body;
  }
  signal.throwIfAborted();
  const hashes: string[] = [];
  for (let start = 0; start < file.size; start += CHUNK_SIZE) {
    signal.throwIfAborted();
    hashes.push(await chunkHash(await file.slice(start, start + CHUNK_SIZE).arrayBuffer(), signal));
  }
  signal.throwIfAborted();
  const state = sessionId ? await json(`/api/uploads/${sessionId}`) : await json("/api/uploads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: file.name, size: file.size, hashes }) });
  if (state.size !== file.size || JSON.stringify(state.hashes) !== JSON.stringify(hashes)) throw Object.assign(new Error("所选文件与原文件不一致，请选择原文件继续。"), { status: 422 });
  sessionId = state.id;
  callbacks.onSession(state.id);
  if (state.file) return state.file as ShareFile;
  const confirmed = new Set<number>(state.confirmed);
  let loaded = [...confirmed].reduce((sum, i) => sum + Math.min(CHUNK_SIZE, file.size - i * CHUNK_SIZE), 0);
  callbacks.onCheckpoint(loaded);
  callbacks.onProgress(loaded);
  for (let i = 0; i < hashes.length; i++) {
    if (confirmed.has(i)) continue;
    signal.throwIfAborted();
    const chunk = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abort = () => { xhr.abort(); finish(new DOMException("Paused", "AbortError")); };
      const finish = (error?: Error) => { signal.removeEventListener("abort", abort); xhr.upload.onprogress = null; xhr.onload = xhr.onerror = xhr.onabort = null; if (error) reject(error); else resolve(); };
      xhr.open("PUT", `/api/uploads/${sessionId}/chunks/${i}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = e => callbacks.onProgress(loaded + Math.min(chunk.size, e.loaded));
      xhr.onload = () => {
        if (xhr.status === 200) finish();
        else { let message = "分片上传失败，请重试。"; try { message = JSON.parse(xhr.responseText).error || message; } catch {} finish(Object.assign(new Error(message), { status: xhr.status })); }
      };
      xhr.onerror = () => finish(new Error("网络中断，点击重试从断点继续。"));
      xhr.onabort = () => finish(new DOMException("Paused", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort(); else xhr.send(chunk);
    });
    loaded += chunk.size;
    callbacks.onCheckpoint(loaded);
  }
  callbacks.onProcessing();
  return await json(`/api/uploads/${sessionId}/complete`, { method: "POST" }) as ShareFile;
}
