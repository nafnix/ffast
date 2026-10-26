import type { ShareFile } from "@/app/files/file-manager";

type UploadResult = { kind: "done"; file: ShareFile } | { kind: "error"; message: string } | { kind: "canceled" } | { kind: "unauthorized" };

export function sendUpload(file: File, xhr: XMLHttpRequest, callbacks: { onProgress: (loadedBytes: number) => void; onProcessing: () => void }) {
  return new Promise<UploadResult>((resolve) => {
    function finish(result: UploadResult) {
      xhr.upload.onprogress = null;
      xhr.upload.onload = null;
      xhr.onload = null;
      xhr.onerror = null;
      xhr.onabort = null;
      resolve(result);
    }

    try {
      xhr.open("POST", "/api/files");
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
      // The raw request body is the File, so its size is known even if lengthComputable is false.
      xhr.upload.onprogress = (event) => callbacks.onProgress(Math.min(file.size, Math.max(0, event.loaded)));
      xhr.upload.onload = callbacks.onProcessing;
      xhr.onload = () => {
        let body: Partial<ShareFile> & { error?: string } = {};
        try {
          const parsed: unknown = JSON.parse(xhr.responseText);
          if (parsed && typeof parsed === "object") body = parsed as typeof body;
        } catch { /* use status fallback */ }
        if (xhr.status === 401) finish({ kind: "unauthorized" });
        else if (xhr.status === 201 && body.id && body.name && body.downloadUrl) {
          finish({ kind: "done", file: { id: body.id, name: body.name, size: body.size ?? file.size, createdAt: body.createdAt ?? Date.now(), downloadUrl: body.downloadUrl, sha256: body.sha256 ?? null } });
        } else {
          finish({ kind: "error", message: body.error || (xhr.status === 413 ? "文件超过服务器的大小上限。" : `上传失败（${xhr.status || "网络错误"}），请重试。`) });
        }
      };
      xhr.onerror = () => finish({ kind: "error", message: "网络中断，文件没有上传完成。" });
      xhr.onabort = () => finish({ kind: "canceled" });
      xhr.send(file);
    } catch {
      finish({ kind: "error", message: "浏览器无法开始上传这个文件。" });
    }
  });
}
