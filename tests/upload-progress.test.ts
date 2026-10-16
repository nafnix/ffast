import { describe, expect, it } from "vitest";
import { fileUploadPercent, formatUploadDuration, nextUploadBatch, summarizeUploads, uploadPageTitle, UploadSpeedMeter, type UploadItem } from "@/lib/upload-progress";

function task(size: number, overrides: Partial<UploadItem> = {}): UploadItem {
  return { id: crypto.randomUUID(), batchId: 1, file: new File([new Uint8Array(size)], "测试.zip"), loadedBytes: 0, speedBps: null, status: "queued", ...overrides };
}

describe("upload batch progress", () => {
  it("weights progress by bytes and estimates the whole queue from the current speed", () => {
    const summary = summarizeUploads([task(160, { status: "done" }), task(1200, { status: "uploading", loadedBytes: 804, speedBps: 14.8 }), task(80), task(160)], 1);
    expect(summary).toMatchObject({ loadedBytes: 964, totalBytes: 1600, progress: 60, completedCount: 1, waitingCount: 2, activeCount: 3 });
    expect(summary.remainingSeconds).toBeCloseTo(43, 0);
    expect(uploadPageTitle(summary, "原始标题")).toBe("↑ 60% · 上传中 | FFast Share");
  });

  it("includes additions during a batch but excludes canceled and rejected files", () => {
    const tasks = [task(100, { status: "uploading", loadedBytes: 50, speedBps: 10 })];
    expect(nextUploadBatch(tasks, 1)).toBe(1);
    expect(summarizeUploads([...tasks, task(100)], 1).progress).toBe(25);
    expect(summarizeUploads([...tasks, task(900, { status: "canceled", loadedBytes: 800 }), task(900, { status: "error", retryable: false })], 1)).toMatchObject({ totalBytes: 100, loadedBytes: 50, progress: 50, totalCount: 1 });
  });

  it("does not lose completed statistics when rows are cleared or removed", () => {
    const tasks = [task(100, { status: "done" }), task(300, { status: "uploading", loadedBytes: 100 })];
    expect(summarizeUploads(tasks.map((item) => item.status === "done" ? { ...item, hidden: true } : item), 1)).toEqual(summarizeUploads(tasks, 1));
  });

  it("keeps failures in the batch and never presents them as successful completion", () => {
    const tasks = [task(100, { status: "error", loadedBytes: 100, hidden: true }), task(100, { status: "done" })];
    const summary = summarizeUploads(tasks, 1);
    expect(summary).toMatchObject({ progress: 99, failedCount: 1, completedCount: 1, totalCount: 2, remainingSeconds: null });
    expect(uploadPageTitle(summary, "原始标题")).toBe("原始标题");
  });

  it("waits for server confirmation before reaching 100 percent", () => {
    const item = task(100, { status: "processing", loadedBytes: 100 });
    const summary = summarizeUploads([item], 1);
    expect(summary).toMatchObject({ progress: 99, activeCount: 1, processing: true, remainingSeconds: null, speedBps: null });
    expect(fileUploadPercent(item)).toBe(99);
    expect(uploadPageTitle(summary, "原始标题")).toBe("↑ 99% · 处理中 | FFast Share");
    const complete = summarizeUploads([{ ...item, status: "done" }], 1);
    expect(complete.progress).toBe(100);
    expect(uploadPageTitle(complete, "原始标题")).toBe("原始标题");
  });

  it("starts a fresh batch after completion or failure, including retries", () => {
    const old = task(100, { status: "done", hidden: true });
    const failed = task(100, { status: "error", loadedBytes: 70 });
    expect(nextUploadBatch([old, failed], 1)).toBe(2);
    const retry = { ...failed, batchId: 2, status: "queued" as const, loadedBytes: 0, speedBps: null };
    expect(summarizeUploads([old, retry], 2)).toMatchObject({ totalCount: 1, loadedBytes: 0, progress: 0 });
    expect(nextUploadBatch([task(100, { status: "processing" })], 1)).toBe(1);
  });

  it("handles zero-byte files, unknown speed, and an entirely canceled batch", () => {
    const zero = task(0);
    expect(summarizeUploads([zero], 1)).toMatchObject({ progress: 0, remainingSeconds: null });
    expect(summarizeUploads([{ ...zero, status: "processing" }], 1).progress).toBe(99);
    expect(summarizeUploads([{ ...zero, status: "done" }], 1).progress).toBe(100);
    expect(fileUploadPercent({ ...zero, status: "processing" })).toBe(99);
    const canceled = summarizeUploads([task(100, { status: "canceled" })], 1);
    expect(canceled).toMatchObject({ totalCount: 0, progress: 0 });
    expect(uploadPageTitle(canceled, "原始标题")).toBe("原始标题");
    expect(summarizeUploads([task(100, { status: "uploading", speedBps: 0 })], 1).remainingSeconds).toBeNull();
  });
});

describe("upload speed sampling", () => {
  it("uses a sliding three-second window rather than a lifetime average", () => {
    const meter = new UploadSpeedMeter(0);
    expect(meter.speed(0)).toBeNull();
    meter.record(400, 1000);
    expect(meter.speed(1000)).toBe(400);
    meter.record(1000, 2000);
    expect(meter.speed(2000)).toBe(500);
    meter.record(1600, 4000);
    expect(meter.speed(4000)).toBe(400);
  });

  it("decays to zero without progress events when the connection stalls", () => {
    const meter = new UploadSpeedMeter(0);
    meter.record(1000, 1000);
    expect(meter.speed(2000)).toBe(500);
    expect(meter.speed(4000)).toBe(0);
    expect(meter.speed(8000)).toBe(0);
  });

  it("ignores regressing samples and handles samples at the same timestamp", () => {
    const meter = new UploadSpeedMeter(0);
    meter.record(1000, 1000);
    meter.record(1500, 1000);
    meter.record(100, 2000);
    expect(meter.loadedBytes).toBe(1500);
    expect(meter.speed(2000)).toBe(750);
  });

  it("formats estimates without infinity, zero seconds, or negative values", () => {
    expect(formatUploadDuration(null)).toBe("—");
    expect(formatUploadDuration(Infinity)).toBe("—");
    expect(formatUploadDuration(0)).toBe("—");
    expect(formatUploadDuration(0.2)).toBe("1 秒");
    expect(formatUploadDuration(60.1)).toBe("1 分 1 秒");
    expect(formatUploadDuration(3661)).toBe("1 小时 1 分");
  });
});
