export const UPLOAD_REFRESH_MS = 250;
const SPEED_WINDOW_MS = 3000;

export type UploadStatus = "queued" | "uploading" | "processing" | "done" | "error" | "canceled";
export type UploadItem = {
  id: string;
  batchId: number;
  file: File;
  loadedBytes: number;
  speedBps: number | null;
  status: UploadStatus;
  error?: string;
  retryable?: boolean;
  hidden?: boolean;
};

export function isActiveUpload(item: Pick<UploadItem, "status">) {
  return item.status === "queued" || item.status === "uploading" || item.status === "processing";
}

export function nextUploadBatch(items: UploadItem[], currentBatch: number) {
  return items.some(isActiveUpload) ? currentBatch : currentBatch + 1;
}

export function fileUploadPercent(item: UploadItem) {
  if (item.status === "done") return 100;
  if (item.file.size === 0) return item.status === "processing" ? 99 : 0;
  return Math.min(99, Math.round(Math.max(0, item.loadedBytes) / item.file.size * 100));
}

export function summarizeUploads(items: UploadItem[], batchId: number) {
  // Hidden rows still belong to this batch; clearing the list must not reset progress.
  const batch = items.filter((item) => item.batchId === batchId && item.status !== "canceled" && item.retryable !== false);
  const totalBytes = batch.reduce((total, item) => total + item.file.size, 0);
  const loadedBytes = batch.reduce((total, item) => total + (item.status === "done" ? item.file.size : Math.min(item.file.size, Math.max(0, item.loadedBytes))), 0);
  const completedCount = batch.filter((item) => item.status === "done").length;
  const waitingCount = batch.filter((item) => item.status === "queued").length;
  const failedCount = batch.filter((item) => item.status === "error").length;
  const activeCount = batch.filter(isActiveUpload).length;
  const uploading = batch.find((item) => item.status === "uploading");
  const processing = batch.some((item) => item.status === "processing");
  const allDone = batch.length > 0 && completedCount === batch.length;
  const zeroByteProgress = processing && waitingCount === 0 && failedCount === 0 ? 99 : batch.length > 0 ? Math.round(completedCount / batch.length * 100) : 0;
  const progress = allDone ? 100 : Math.min(99, totalBytes > 0 ? Math.round(loadedBytes / totalBytes * 100) : zeroByteProgress);
  const speedBps = uploading?.speedBps ?? null;
  const remainingSeconds = speedBps !== null && speedBps > 0 && totalBytes > loadedBytes && failedCount === 0
    ? (totalBytes - loadedBytes) / speedBps
    : null;
  return { totalCount: batch.length, totalBytes, loadedBytes, completedCount, waitingCount, failedCount, activeCount, progress, speedBps, remainingSeconds, processing: processing && !uploading };
}

export function uploadPageTitle(summary: ReturnType<typeof summarizeUploads>, originalTitle: string) {
  if (!summary.activeCount) return originalTitle;
  return `↑ ${summary.progress}% · ${summary.processing ? "处理中" : "上传中"} | FFast Share`;
}

export function formatUploadDuration(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return "—";
  const rounded = Math.ceil(seconds);
  if (rounded < 60) return `${rounded} 秒`;
  if (rounded < 3600) return `${Math.floor(rounded / 60)} 分 ${rounded % 60} 秒`;
  return `${Math.floor(rounded / 3600)} 小时 ${Math.floor(rounded % 3600 / 60)} 分`;
}

export class UploadSpeedMeter {
  loadedBytes = 0;
  private samples: { at: number; bytes: number }[];

  constructor(startedAt: number) {
    this.samples = [{ at: startedAt, bytes: 0 }];
  }

  record(loadedBytes: number, now: number) {
    this.loadedBytes = Math.max(this.loadedBytes, loadedBytes);
    const last = this.samples[this.samples.length - 1];
    if (last.at === now) last.bytes = this.loadedBytes;
    else this.samples.push({ at: now, bytes: this.loadedBytes });
    const cutoff = now - SPEED_WINDOW_MS;
    while (this.samples.length > 2 && this.samples[1].at <= cutoff) this.samples.shift();
  }

  speed(now: number) {
    this.record(this.loadedBytes, now);
    const first = this.samples[0];
    const start = Math.max(first.at, now - SPEED_WINDOW_MS);
    if (now <= start) return null;
    const next = this.samples[1];
    const startBytes = next && first.at < start
      ? first.bytes + (next.bytes - first.bytes) * (start - first.at) / (next.at - first.at)
      : first.bytes;
    return Math.max(0, (this.loadedBytes - startBytes) * 1000 / (now - start));
  }
}
