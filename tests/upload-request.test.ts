import { describe, expect, it, vi } from "vitest";
import { sendUpload } from "@/lib/upload-request";

function setup(size = 100) {
  const xhr = {
    upload: { onprogress: null, onload: null },
    open: vi.fn(), setRequestHeader: vi.fn(), send: vi.fn(),
    status: 0, responseText: "", onload: null, onerror: null, onabort: null,
  } as unknown as XMLHttpRequest;
  const callbacks = { onProgress: vi.fn(), onProcessing: vi.fn() };
  const file = new File([new Uint8Array(size)], "测试文件.zip");
  const result = sendUpload(file, xhr, callbacks);
  return { xhr, callbacks, file, result };
}

function uploadEvent(xhr: XMLHttpRequest, name: "onprogress" | "onload", event: Partial<ProgressEvent> = {}) {
  const listener = xhr.upload[name] as ((event: ProgressEvent) => void) | null;
  listener?.(event as ProgressEvent);
}

describe("upload request lifecycle", () => {
  it("measures raw bytes even when the event has no computable total", () => {
    const { xhr, callbacks, file } = setup();
    uploadEvent(xhr, "onprogress", { lengthComputable: false, loaded: 45, total: 0 });
    expect(callbacks.onProgress).toHaveBeenCalledWith(45);
    uploadEvent(xhr, "onprogress", { loaded: 150 });
    expect(callbacks.onProgress).toHaveBeenLastCalledWith(100);
    expect(xhr.setRequestHeader).toHaveBeenCalledWith("X-File-Name", encodeURIComponent(file.name));
    expect(xhr.send).toHaveBeenCalledWith(file);
  });

  it("enters processing after sending, and resolves only after a successful response", async () => {
    const { xhr, callbacks, result } = setup();
    const settled = vi.fn();
    void result.then(settled);
    uploadEvent(xhr, "onload");
    await Promise.resolve();
    expect(callbacks.onProcessing).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    Object.assign(xhr, { status: 201, responseText: JSON.stringify({ id: "new-file", name: "测试文件.zip", downloadUrl: "https://example.test/download/token" }) });
    xhr.onload?.call(xhr, {} as ProgressEvent);
    await expect(result).resolves.toMatchObject({ kind: "done", file: { id: "new-file", size: 100 } });
    expect(xhr.upload.onprogress).toBeNull();
    expect(xhr.upload.onload).toBeNull();
  });

  it("permits canceling while waiting for server confirmation", async () => {
    const { xhr, result } = setup();
    uploadEvent(xhr, "onload");
    xhr.onabort?.call(xhr, {} as ProgressEvent);
    await expect(result).resolves.toEqual({ kind: "canceled" });
  });

  it("reports network errors and preserves server failure messages", async () => {
    const network = setup();
    network.xhr.onerror?.call(network.xhr, {} as ProgressEvent);
    await expect(network.result).resolves.toMatchObject({ kind: "error", message: expect.stringContaining("网络中断") });
    const server = setup();
    Object.assign(server.xhr, { status: 500, responseText: '{"error":"磁盘空间不足"}' });
    server.xhr.onload?.call(server.xhr, {} as ProgressEvent);
    await expect(server.result).resolves.toEqual({ kind: "error", message: "磁盘空间不足" });
  });

  it("handles invalid responses, expired sessions, and empty files", async () => {
    const invalid = setup();
    Object.assign(invalid.xhr, { status: 201, responseText: "invalid json" });
    invalid.xhr.onload?.call(invalid.xhr, {} as ProgressEvent);
    await expect(invalid.result).resolves.toMatchObject({ kind: "error" });
    const expired = setup();
    Object.assign(expired.xhr, { status: 401 });
    expired.xhr.onload?.call(expired.xhr, {} as ProgressEvent);
    await expect(expired.result).resolves.toEqual({ kind: "unauthorized" });
    const empty = setup(0);
    Object.assign(empty.xhr, { status: 201, responseText: '{"id":"empty","name":"空文件","downloadUrl":"/download/empty"}' });
    empty.xhr.onload?.call(empty.xhr, {} as ProgressEvent);
    await expect(empty.result).resolves.toMatchObject({ kind: "done", file: { size: 0 } });
  });
});
