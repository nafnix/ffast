"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { redirectOnUnauthorized } from "@/lib/client-auth";
import { fileUploadPercent, formatUploadDuration, isActiveUpload, nextUploadBatch, summarizeUploads, UPLOAD_REFRESH_MS, uploadPageTitle, UploadSpeedMeter, type UploadItem } from "@/lib/upload-progress";
import { uploadTaskId, transferFile, savedUploads, saveUpload, forgetUpload } from "@/lib/resumable-client";

export type ShareFile = {
  id: string;
  name: string;
  size: number;
  createdAt: number;
  downloadUrl: string;
  sha256: string | null;
};

type FileManagerProps = { initialFiles: ShareFile[]; maxUploadBytes: number };

export function FileManager({ initialFiles, maxUploadBytes }: FileManagerProps) {
  const [files, setFiles] = useState(initialFiles);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"all" | "recent">("all");
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState("");
  const [loading, setLoading] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [hashStatus, setHashStatus] = useState<{ fileId: string; status: "loading" | "error" } | null>(null);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(initialFiles[0]?.id ?? null);
  const queueRef = useRef<UploadItem[]>([]);
  const controllersRef = useRef<Map<string, AbortController>>(new Map());
  const workerRef = useRef(false);
  const mountedRef = useRef(true);
  const batchRef = useRef(0);
  const uploadTickerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const originalTitleRef = useRef<string | null>(null);
  const dragDepth = useRef(0);
  const pickerRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updateQueue = useCallback((update: (items: UploadItem[]) => UploadItem[]) => {
    queueRef.current = update(queueRef.current);
    setUploads(queueRef.current);
  }, []);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3600);
  }, []);

  useEffect(() => {
    const restored: UploadItem[] = savedUploads().map(record => ({
      id: record.id, sessionId: record.sessionId, batchId: 0,
      file: { name: record.name, size: record.size, lastModified: record.lastModified } as File,
      loadedBytes: record.loadedBytes, confirmedBytes: record.loadedBytes, lastModified: record.lastModified, speedBps: null,
      status: "paused", needsFile: true,
    }));
    updateQueue(items => items.length ? items : restored);
  }, [updateQueue]);

  const refreshFiles = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/files", { cache: "no-store" });
      if (redirectOnUnauthorized(response.status, (path) => window.location.assign(path))) return;
      if (!response.ok) throw new Error("文件列表暂时无法加载。");
      const result = (await response.json()) as { files: ShareFile[] };
      setFiles(result.files);
      setSelectedFileId((current) => result.files.some((file) => file.id === current) ? current : result.files[0]?.id ?? null);
    } catch (error) {
      notify(error instanceof Error ? error.message : "文件列表暂时无法加载。");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  const runQueue = useCallback(async () => {
    if (workerRef.current) return;
    workerRef.current = true;
    try {
      while (mountedRef.current) {
        const next = queueRef.current.find((item) => item.status === "queued");
        if (!next) break;
        updateQueue((items) => items.map((item) => item.id === next.id ? { ...item, status: "uploading", loadedBytes: item.confirmedBytes ?? 0, speedBps: null } : item));
        let meter = new UploadSpeedMeter(performance.now(), next.confirmedBytes ?? 0);
        const xhr = new AbortController();
        controllersRef.current.set(next.id, xhr);
        // Progress events update the meter; only the ticker publishes React state.
        uploadTickerRef.current = setInterval(() => {
          const speedBps = meter.speed(performance.now());
          updateQueue((items) => items.map((item) => item.id === next.id && item.status === "uploading" ? { ...item, loadedBytes: meter.loadedBytes, speedBps } : item));
        }, UPLOAD_REFRESH_MS);
        let baseline = next.confirmedBytes ?? 0;
        let firstCheckpoint = true;
        const result = await transferFile(next.file, xhr.signal, next.sessionId, {
          onSession: (sessionId) => {
            next.sessionId = sessionId;
            updateQueue(items => items.map(item => item.id === next.id ? { ...item, sessionId } : item));
            saveUpload({ id: next.id, name: next.file.name, size: next.file.size, lastModified: next.file.lastModified, sessionId, loadedBytes: baseline, updated: Date.now() });
          },
          onCheckpoint: (bytes) => {
            baseline = bytes;
            if (firstCheckpoint) {
              meter = new UploadSpeedMeter(performance.now(), bytes);
              firstCheckpoint = false;
            } else meter.record(bytes, performance.now());
            updateQueue(items => items.map(item => item.id === next.id ? { ...item, confirmedBytes: bytes, loadedBytes: bytes } : item));
            saveUpload({ id: next.id, name: next.file.name, size: next.file.size, lastModified: next.file.lastModified, sessionId: next.sessionId, loadedBytes: bytes, updated: Date.now() });
          },
          onProgress: (loadedBytes) => {
            meter.record(loadedBytes, performance.now());
          },
          onProcessing: () => {
            if (uploadTickerRef.current) clearInterval(uploadTickerRef.current);
            uploadTickerRef.current = null;
            updateQueue(items => items.map(item => item.id === next.id ? { ...item, status: "processing", loadedBytes: next.file.size, speedBps: null } : item));
          },
        }).then(file => ({ kind: "done" as const, file })).catch((error) => {
          if (xhr.signal.aborted) return { kind: "canceled" as const };
          if (error.status === 401) return { kind: "unauthorized" as const };
          if (error.status === 422) updateQueue(items => items.map(item => item.id === next.id ? { ...item, needsFile: true } : item));
          if (error.status === 410) {
            next.sessionId = undefined;
            saveUpload({ id: next.id, name: next.file.name, size: next.file.size, lastModified: next.file.lastModified, loadedBytes: 0, updated: Date.now() });
            updateQueue(items => items.map(item => item.id === next.id ? { ...item, sessionId: undefined } : item));
          }
          return { kind: "error" as const, message: error instanceof Error ? error.message : "上传失败，请重试。" };
        });

        if (uploadTickerRef.current) clearInterval(uploadTickerRef.current);
        uploadTickerRef.current = null;
        controllersRef.current.delete(next.id);
        if (!mountedRef.current) break;
        if (result.kind === "unauthorized") {
          updateQueue((items) => items.map((item) => isActiveUpload(item) ? { ...item, status: "error", speedBps: null, error: "登录已过期，请重新登录。" } : item));
          redirectOnUnauthorized(401, (path) => window.location.assign(path));
          break;
        }
        if (result.kind === "done") {
          forgetUpload(next.id);
          updateQueue((items) => items.map((item) => item.id === next.id ? { ...item, status: "done", loadedBytes: next.file.size, speedBps: null } : item));
          setFiles((current) => [result.file, ...current.filter((file) => file.id !== result.file.id)]);
          setSelectedFileId(result.file.id);
          notify(`“${result.file.name}”已上传完成，可以复制分享链接。`);
        } else if (result.kind === "canceled") {
          updateQueue((items) => items.map((item) => item.id === next.id && item.status !== "canceled" && item.status !== "queued" ? { ...item, status: "paused", speedBps: null } : item));
        } else {
          updateQueue((items) => items.map((item) => item.id === next.id ? { ...item, status: "error", loadedBytes: baseline, speedBps: null, error: result.message } : item));
          notify(`${next.file.name}：${result.message}`);
        }
      }
    } finally {
      workerRef.current = false;
    }
  }, [notify, updateQueue]);

  const enqueueFiles = useCallback((fileList: FileList | File[]) => {
    const selectedFiles = Array.from(fileList);
    if (!selectedFiles.length) return;
    batchRef.current = nextUploadBatch(queueRef.current, batchRef.current);
    const matched = new Set<string>();
    const newItems: UploadItem[] = selectedFiles.map((file) => {
      const restored = queueRef.current.find(item => item.needsFile && !matched.has(item.id) && item.file.name === file.name && item.file.size === file.size);
      if (restored) matched.add(restored.id);
      return {
        id: restored?.id ?? uploadTaskId(),
        sessionId: restored?.sessionId,
        batchId: batchRef.current,
        file,
        loadedBytes: 0,
        speedBps: null,
        status: file.size > maxUploadBytes ? "error" : "queued",
        error: file.size > maxUploadBytes ? `超过单文件上限 ${formatSize(maxUploadBytes)}，未开始上传。` : undefined,
        retryable: file.size <= maxUploadBytes,
      };
    });
    for (const item of newItems) if (item.retryable) saveUpload({ id: item.id, sessionId: item.sessionId, name: item.file.name, size: item.file.size, lastModified: item.file.lastModified, loadedBytes: 0, updated: Date.now() });
    updateQueue((items) => [...items.filter((item) => !newItems.some(next => next.id === item.id) && (!item.hidden || item.batchId === batchRef.current)), ...newItems]);
    const readyCount = newItems.filter((item) => item.status === "queued").length;
    const rejectedCount = newItems.length - readyCount;
    if (readyCount && rejectedCount) notify(`${readyCount} 个文件已加入队列，${rejectedCount} 个文件超过大小上限。`);
    else if (rejectedCount) notify(`${rejectedCount} 个文件超过大小上限，未开始上传。`);
    else notify(newItems.length === 1 ? `已开始上传“${newItems[0].file.name}”。` : `已加入 ${newItems.length} 个文件，正在依次上传。`);
    setView("all");
    void runQueue();
  }, [maxUploadBytes, notify, runQueue, updateQueue]);

  useEffect(() => {
    function hasFiles(event: DragEvent) {
      return Array.from(event.dataTransfer?.types ?? []).includes("Files");
    }
    function onDragEnter(event: DragEvent) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    }
    function onDragOver(event: DragEvent) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }
    function onDragLeave(event: DragEvent) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0 || event.relatedTarget === null) {
        dragDepth.current = 0;
        setDragging(false);
      }
    }
    function onDrop(event: DragEvent) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (event.dataTransfer?.files.length) enqueueFiles(event.dataTransfer.files);
    }
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [enqueueFiles]);

  useEffect(() => {
    mountedRef.current = true;
    originalTitleRef.current = document.title;
    return () => {
      mountedRef.current = false;
      controllersRef.current.forEach((xhr) => xhr.abort());
      if (uploadTickerRef.current) clearInterval(uploadTickerRef.current);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      document.title = originalTitleRef.current ?? document.title;
    };
  }, []);

  useEffect(() => {
    function onShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);

  const filteredFiles = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return files.filter((file) => {
      const matchesSearch = !normalizedQuery || file.name.toLocaleLowerCase().includes(normalizedQuery);
      const matchesView = view === "all" || file.createdAt >= Date.now() - 7 * 24 * 60 * 60 * 1000;
      return matchesSearch && matchesView;
    });
  }, [files, query, view]);
  const recentCount = useMemo(() => files.filter((file) => file.createdAt >= Date.now() - 7 * 24 * 60 * 60 * 1000).length, [files]);

  const copyLink = useCallback(async (file: ShareFile) => {
    try {
      await navigator.clipboard.writeText(file.downloadUrl);
      notify("分享链接已复制到剪贴板。");
    } catch {
      notify("复制失败，请检查浏览器剪贴板权限。");
    }
  }, [notify]);

  const copyDownloadCommand = useCallback(async (file: ShareFile, client: "wget" | "curl") => {
    const url = shellQuote(file.downloadUrl);
    const filename = shellQuote(file.name);
    const command = client === "wget"
      ? `wget --quiet --output-document=- ${url} > ${filename}`
      : `curl --fail --location ${url} > ${filename}`;
    try {
      await navigator.clipboard.writeText(command);
      notify(`${client} 命令已复制到剪贴板。`);
    } catch {
      notify("复制失败，请检查浏览器剪贴板权限。");
    }
  }, [notify]);

  async function deleteFile(file: ShareFile) {
    if (!window.confirm(`确定删除“${file.name}”吗？删除后，此分享链接将立即失效。`)) return;
    try {
      const response = await fetch(`/api/files/${encodeURIComponent(file.id)}`, { method: "DELETE" });
      if (redirectOnUnauthorized(response.status, (path) => window.location.assign(path))) return;
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error || "删除失败，请稍后重试。");
      setFiles((current) => current.filter((item) => item.id !== file.id));
      setSelectedFileId((current) => current === file.id ? files.find((item) => item.id !== file.id)?.id ?? null : current);
      notify(`“${file.name}”已删除，分享链接已失效。`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "删除失败，请稍后重试。");
    }
  }

  async function logout() {
    setLoggingOut(true);
    try {
      await fetch("/api/session", { method: "DELETE" });
    } finally {
      window.location.assign("/login");
    }
  }

  function pauseUpload(upload: UploadItem) {
    updateQueue(items => items.map(item => item.id === upload.id ? { ...item, status: "paused", loadedBytes: item.confirmedBytes ?? 0, speedBps: null } : item));
    controllersRef.current.get(upload.id)?.abort();
  }

  function cancelUpload(upload: UploadItem) {
    updateQueue(items => items.map(item => item.id === upload.id ? { ...item, status: "canceled", hidden: true } : item));
    controllersRef.current.get(upload.id)?.abort();
    forgetUpload(upload.id);
    if (upload.sessionId && upload.status !== "done") {
      void fetch(`/api/uploads/${upload.sessionId}`, { method: "DELETE" }).then(response => {
        if (!response.ok && response.status !== 410) notify("取消任务未成功，请重新选择文件后重试。");
      }).catch(() => notify("网络中断，服务器上的未完成分片将在到期后清理。"));
    }
  }

  function retryUpload(upload: UploadItem) {
    if (upload.needsFile) { pickerRef.current?.click(); return; }
    batchRef.current = nextUploadBatch(queueRef.current, batchRef.current);
    updateQueue((items) => items.filter((item) => !item.hidden || item.batchId === batchRef.current).map((item) => item.id === upload.id ? { ...item, batchId: batchRef.current, status: "queued", loadedBytes: item.confirmedBytes ?? 0, speedBps: null, error: undefined } : item));
    void runQueue();
  }

  const visibleUploads = uploads.filter((upload) => !upload.hidden);
  const summary = summarizeUploads(uploads, batchRef.current);
  const activeUploads = summary.activeCount;
  const progressTitle = activeUploads ? uploadPageTitle(summary, "") : null;
  useEffect(() => {
    document.title = progressTitle ?? originalTitleRef.current ?? document.title;
  }, [progressTitle]);
  const filteredSelectedFile = filteredFiles.find((file) => file.id === selectedFileId) ?? filteredFiles[0] ?? null;
  const selectedFileIdForHash = filteredSelectedFile?.id ?? null;
  const selectedFileHash = filteredSelectedFile?.sha256 ?? null;
  useEffect(() => {
    if (!selectedFileIdForHash) {
      setHashStatus(null);
      return;
    }
    if (selectedFileHash) {
      setHashStatus(null);
      return;
    }

    let active = true;
    setHashStatus({ fileId: selectedFileIdForHash, status: "loading" });
    void (async () => {
      try {
        const response = await fetch(`/api/files/${encodeURIComponent(selectedFileIdForHash)}`, { cache: "no-store" });
        if (redirectOnUnauthorized(response.status, (path) => window.location.assign(path))) return;
        const body = (await response.json()) as { sha256?: string; error?: string };
        if (!response.ok || !body.sha256) throw new Error(body.error || "无法读取文件哈希。");
        if (!active) return;
        setFiles((current) => current.map((item) => item.id === selectedFileIdForHash ? { ...item, sha256: body.sha256! } : item));
        setHashStatus((current) => current?.fileId === selectedFileIdForHash ? null : current);
      } catch {
        if (active) setHashStatus({ fileId: selectedFileIdForHash, status: "error" });
      }
    })();

    return () => { active = false; };
  }, [selectedFileIdForHash, selectedFileHash]);
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  const filteredBytes = filteredFiles.reduce((total, file) => total + file.size, 0);

  return (
    <main className="file-manager-shell">
      <div className="fm-workspace">
        <header className="fm-topbar">
          <div className="fm-workspace-name"><LockIcon /><span>私有工作空间</span><ChevronIcon /><strong>文件库</strong></div>
          <div className="fm-topbar-actions">
            <span className="fm-private-status"><span />私密空间</span>
            <button className="fm-logout" onClick={logout} disabled={loggingOut} type="button"><LogoutIcon /><span>{loggingOut ? "正在退出…" : "退出登录"}</span></button>
          </div>
        </header>

        <div className="fm-page">
          <section className="fm-page-heading">
            <div>
              <div className="fm-title-line"><h1 id="page-title">{view === "all" ? "全部文件" : "最近上传"}</h1><span className="fm-count">{view === "all" ? files.length : recentCount}</span></div>
              <p className="fm-page-description"><span>{files.length} 个文件</span><span className="fm-meta-separator" />{formatSize(totalBytes)}<span className="fm-meta-separator" /><span>上传、管理与分享</span></p>
            </div>
            <button className="fm-button fm-primary-button" onClick={() => pickerRef.current?.click()} type="button"><UploadIcon /><span>上传文件</span></button>
          </section>

          <section className="fm-drop-strip" aria-label="拖放上传">
            <span className="fm-drop-icon"><UploadIcon /></span>
            <div className="fm-drop-copy"><strong>将文件拖到页面任意位置</strong><span>释放后立即上传，完成后可复制链接分享。</span></div>
            <div className="fm-drop-actions"><span>单个文件最大 {formatSize(maxUploadBytes)}</span><button onClick={() => pickerRef.current?.click()} type="button">选择文件 <ChevronIcon /></button></div>
            <input ref={pickerRef} aria-label="选择要上传的文件" className="fm-visually-hidden" multiple onChange={(event) => { if (event.currentTarget.files) enqueueFiles(event.currentTarget.files); event.currentTarget.value = ""; }} tabIndex={-1} type="file" />
          </section>

          <div className="fm-workbench-grid">
            <section className="fm-file-panel" aria-labelledby="file-list-title">
              <div className="fm-table-toolbar">
                <div className="fm-tabs" role="group" aria-label="文件筛选">
                  <button className={view === "all" ? "active" : ""} onClick={() => setView("all")} type="button">全部文件 <span>{files.length}</span></button>
                  <button className={view === "recent" ? "active" : ""} onClick={() => setView("recent")} type="button">最近上传</button>
                </div>
                <div className="fm-toolbar-actions">
                  <label className="fm-search"> <SearchIcon /><input ref={searchRef} aria-label="搜索文件（⌘/Ctrl + K）" onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件名" value={query} />{!query && <kbd>⌘ K</kbd>}</label>
                  {query && <button className="fm-icon-button" aria-label="清除搜索" onClick={() => setQuery("")} type="button"><CloseIcon /></button>}
                  <button className="fm-icon-button" onClick={() => void refreshFiles()} type="button" aria-label="刷新文件列表" title="刷新文件列表"><RefreshIcon className={loading ? "spinning" : ""} /></button>
                </div>
              </div>
              <div className="fm-table-scroll">
                <table className="fm-file-table">
                  <thead><tr><th className="fm-name-column" id="file-list-title" scope="col">文件名称</th><th className="fm-size-column" scope="col">大小</th><th className="fm-date-column" scope="col">上传时间</th><th className="fm-action-column" scope="col"><span className="fm-visually-hidden">操作</span></th></tr></thead>
                  <tbody>
                    {filteredFiles.map((file) => <FileRow key={file.id} file={file} selected={filteredSelectedFile?.id === file.id} onSelect={setSelectedFileId} onCopy={copyLink} />)}
                    {filteredFiles.length === 0 && <tr><td className="fm-empty-cell" colSpan={4}><EmptyState hasQuery={Boolean(query)} hasFiles={files.length > 0} onChoose={() => pickerRef.current?.click()} /></td></tr>}
                  </tbody>
                </table>
              </div>
              <footer className="fm-table-footer"><span>共 {filteredFiles.length} 个文件 <i />{formatSize(filteredBytes)}</span><span className="fm-sync-label"><CheckIcon />{loading ? "正在同步" : "已同步"}</span></footer>
            </section>

            <aside className="fm-side-panels" aria-label="上传与文件详情">
              <section className="fm-card fm-queue-panel" id="upload-queue" tabIndex={-1} aria-labelledby="upload-queue-title">
                <header className="fm-panel-header"><div className="fm-panel-title"><h2 id="upload-queue-title">上传队列</h2><span className="fm-count">{activeUploads}</span></div><button className="fm-text-button" disabled={!visibleUploads.some((item) => item.status === "done")} onClick={() => updateQueue((items) => items.map((item) => item.status === "done" ? { ...item, hidden: true } : item))} type="button">清除已完成</button></header>
                {summary.totalCount > 0 && <UploadSummary summary={summary} />}
                <div className="fm-queue-list">
                  {visibleUploads.map((upload) => <UploadRow key={upload.id} item={upload} onCancel={cancelUpload} onPause={pauseUpload} onRetry={retryUpload} />)}
                  {visibleUploads.length === 0 && <div className="fm-queue-empty"><span className="fm-queue-empty-icon"><UploadIcon /></span><strong>当前没有上传任务</strong><span>选择文件或拖放到页面即可开始上传。</span><button className="fm-text-button" onClick={() => pickerRef.current?.click()} type="button">选择文件</button></div>}
                </div>
                <footer className="fm-panel-foot"><LockIcon />上传时可继续浏览和分享文件</footer>
              </section>

              <section className="fm-card fm-detail-panel" aria-labelledby="file-detail-title">
                <header className="fm-panel-header"><h2 id="file-detail-title">文件详情</h2>{filteredSelectedFile && <span className="fm-detail-status"><span />链接有效</span>}</header>
                {filteredSelectedFile ? <div className="fm-detail-content">
                  <div className="fm-detail-file"><span className="fm-detail-glyph" data-type={filteredSelectedFile.name.split(".").pop()?.slice(0, 4).toUpperCase()}><FileGlyph name={filteredSelectedFile.name} /></span><div><strong title={filteredSelectedFile.name}>{filteredSelectedFile.name}</strong><span>分享链接已启用</span></div></div>
                  <dl className="fm-detail-fields"><div><dt>文件大小</dt><dd>{formatSize(filteredSelectedFile.size)}</dd></div><div><dt>上传时间</dt><dd>{formatDate(filteredSelectedFile.createdAt)}</dd></div><div><dt>分享方式</dt><dd>链接直接下载</dd></div><div><dt>SHA-256</dt><dd className="fm-hash-value" title={filteredSelectedFile.sha256 ?? undefined}>{filteredSelectedFile.sha256 ?? (hashStatus?.fileId === filteredSelectedFile.id ? hashStatus.status === "loading" ? "计算中…" : "无法读取" : "计算中…")}</dd></div></dl>
                  <div className="fm-detail-url" title={filteredSelectedFile.downloadUrl}><LinkIcon /><span>{filteredSelectedFile.downloadUrl}</span></div>
                  <a className="fm-button fm-download-detail" href={filteredSelectedFile.downloadUrl}><DownloadIcon />下载文件</a>
                  <div className="fm-command-buttons">
                    <button className="fm-command-detail" onClick={() => void copyDownloadCommand(filteredSelectedFile, "wget")} type="button" title="复制 wget 下载命令"><TerminalIcon />复制 wget</button>
                    <button className="fm-command-detail" onClick={() => void copyDownloadCommand(filteredSelectedFile, "curl")} type="button" title="复制 curl 下载命令"><TerminalIcon />复制 curl</button>
                  </div>
                  <button className="fm-button fm-copy-detail" onClick={() => void copyLink(filteredSelectedFile)} type="button"><LinkIcon />复制分享链接</button>
                  <button className="fm-delete-detail" onClick={() => void deleteFile(filteredSelectedFile)} type="button"><TrashIcon />删除文件</button>
                </div> : <div className="fm-detail-empty"><span className="fm-detail-empty-icon"><FolderIcon /></span><strong>{files.length === 0 ? "文件库还是空的" : "没有匹配的文件"}</strong><span>{query ? "清除搜索条件，继续查看文件详情。" : "上传的文件会显示在这里。"}</span></div>}
              </section>
            </aside>
          </div>

          <footer className="fm-page-foot"><span><LockIcon />文件保存在此服务器中，分享链接无需登录即可下载。</span><span>FFast Share · 自托管文件空间</span></footer>
        </div>
      </div>

      {dragging && <div className="fm-drop-overlay" aria-live="polite"><div className="fm-drop-overlay-card"><span><UploadIcon /></span><strong>释放文件即可上传</strong><p>松开鼠标后会立即开始上传</p></div></div>}
      {toast && <div className="fm-toast" role="status"><span><CheckIcon /></span>{toast}</div>}
    </main>
  );
}

function UploadProgressBar({ value, label }: { value: number; label: string }) {
  return <div className="fm-progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}><span style={{ transform: `scaleX(${value / 100})` }} /></div>;
}

function formatTransferSpeed(speedBps: number | null) {
  return speedBps === null ? "—" : `${formatSize(Math.round(speedBps))}/s`;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function UploadSummary({ summary }: { summary: ReturnType<typeof summarizeUploads> }) {
  return <div className={`fm-upload-summary${summary.completedCount === summary.totalCount ? " is-complete" : ""}`} aria-label="本轮上传进度">
    <div className="fm-upload-summary-heading"><span>总体进度</span><strong>{summary.progress}%</strong></div>
    <UploadProgressBar value={summary.progress} label="总体上传进度" />
    <p className="fm-upload-summary-bytes">{formatSize(summary.loadedBytes)} <span>/ {formatSize(summary.totalBytes)}</span></p>
    <dl className="fm-upload-summary-metrics"><div><dt>当前速度</dt><dd>{formatTransferSpeed(summary.speedBps)}</dd></div><div><dt>预计剩余</dt><dd>{formatUploadDuration(summary.remainingSeconds)}</dd></div></dl>
    <p className="fm-upload-summary-counts"><span>本轮已完成 {summary.completedCount}/{summary.totalCount}</span><span>{summary.waitingCount} 个等待</span>{summary.failedCount > 0 && <span className="fm-upload-failed-count">{summary.failedCount} 个失败</span>}</p>
  </div>;
}

function UploadRow({ item, onCancel, onPause, onRetry }: { onPause: (item: UploadItem) => void; item: UploadItem; onCancel: (item: UploadItem) => void; onRetry: (item: UploadItem) => void }) {
  const progress = fileUploadPercent(item);
  const transferring = item.status === "uploading" || item.status === "processing";
  const statusLabel = item.status === "paused" ? "已暂停" : item.status === "queued" ? "等待中" : item.status === "uploading" ? `${progress}%` : item.status === "processing" ? "处理中" : item.status === "done" ? "已完成" : item.status === "canceled" ? "已取消" : "上传失败";
  const remainingSeconds = item.speedBps !== null && item.speedBps > 0 && item.loadedBytes < item.file.size ? (item.file.size - item.loadedBytes) / item.speedBps : null;
  return (
    <div className={`fm-upload-row status-${item.status}`}>
      <span className="fm-upload-file-icon" data-type={item.file.name.split(".").pop()?.slice(0, 4).toUpperCase()}><FileGlyph name={item.file.name} /></span>
      <div className="fm-upload-row-main">
        <div className="fm-upload-file-info"><strong title={item.file.name}>{item.file.name}</strong><span className={`fm-upload-status status-${item.status}`}>{item.status === "done" && <CheckIcon />}{statusLabel}</span></div>
        <div className="fm-upload-progress-row">
          <div className="fm-upload-progress-main">
            <UploadProgressBar value={progress} label={`${item.file.name} 上传进度`} />
            <div className="fm-upload-transfer-stats">
              <span>{transferring || item.status === "error" || item.status === "paused" ? `${formatSize(item.loadedBytes)} / ${formatSize(item.file.size)}` : formatSize(item.file.size)}</span>
              {transferring && <span className="fm-upload-transfer-speed">{item.status === "processing" ? <span role="status">服务器处理中</span> : formatTransferSpeed(item.speedBps)}</span>}
            </div>
            {item.status === "uploading" && <div className="fm-upload-transfer-meta"><span>预计剩余 {formatUploadDuration(remainingSeconds)}</span></div>}
          </div>
          <div className="fm-upload-actions">
            {(item.status === "uploading" || item.status === "queued") && <button className="fm-icon-button fm-queue-action" aria-label={`暂停上传 ${item.file.name}`} title="暂停上传" onClick={() => onPause(item)} type="button"><PauseIcon /></button>}
            {item.status === "paused" && <><button className="fm-icon-button fm-queue-action" aria-label={`继续上传 ${item.file.name}`} title="继续上传" onClick={() => onRetry(item)} type="button"><PlayIcon /></button><button className="fm-icon-button fm-queue-action" title="取消上传" aria-label={`取消上传 ${item.file.name}`} onClick={() => onCancel(item)} type="button"><CloseIcon /></button></>}
            {item.status === "error" && item.retryable !== false && <button className="fm-button fm-retry-button" onClick={() => onRetry(item)} type="button">重试</button>}
            {isActiveUpload(item) && <button className="fm-icon-button fm-queue-action" title={transferring ? "取消上传" : "移除"} aria-label={transferring ? `取消上传 ${item.file.name}` : `移除 ${item.file.name}`} onClick={() => onCancel(item)} type="button"><CloseIcon /></button>}
            {(item.status === "done" || item.status === "error" || item.status === "canceled") && <button className="fm-icon-button fm-queue-action" title="从队列移除" aria-label={`从队列移除 ${item.file.name}`} onClick={() => onCancel(item)} type="button"><CloseIcon /></button>}
          </div>
        </div>
        {item.needsFile && <p className="fm-upload-error">请选择原文件继续</p>}
        {item.status === "error" && <p className="fm-upload-error">{item.error}</p>}
      </div>
    </div>
  );
}

const FileRow = memo(function FileRow({ file, selected, onSelect, onCopy }: { file: ShareFile; selected: boolean; onSelect: (id: string) => void; onCopy: (file: ShareFile) => void }) {
  return (
    <tr className={selected ? "fm-file-row selected" : "fm-file-row"}>
      <td><button className="fm-file-select" onClick={() => onSelect(file.id)} type="button" aria-pressed={selected}><span className="fm-file-name"><span className="fm-file-glyph" data-type={file.name.split(".").pop()?.slice(0, 4).toUpperCase()}><FileGlyph name={file.name} /></span><span className="fm-file-copy"><strong title={file.name}>{file.name}</strong><span>分享链接已启用</span><span className="fm-mobile-meta">{formatSize(file.size)} · {formatDate(file.createdAt)}</span></span></span></button></td>
      <td className="fm-size-cell">{formatSize(file.size)}</td>
      <td className="fm-date-cell">{formatDate(file.createdAt)}</td>
      <td><button className="fm-icon-button fm-copy-row" onClick={() => onCopy(file)} type="button" aria-label={`复制 ${file.name} 分享链接`} title="复制分享链接"><LinkIcon /></button></td>
    </tr>
  );
});

function EmptyState({ hasQuery, hasFiles, onChoose }: { hasQuery: boolean; hasFiles: boolean; onChoose: () => void }) {
  return (
    <div className="fm-empty-state">
      <span className="fm-empty-icon"><FolderIcon /></span>
      <h3>{hasQuery ? "没有找到匹配文件" : hasFiles ? "这里暂时没有文件" : "你的文件库还是空的"}</h3>
      <p>{hasQuery ? "试试其他关键词，或清空搜索条件。" : "把文件拖到页面任意位置，释放后就会开始上传。"}</p>
      {!hasQuery && <button className="fm-text-button" onClick={onChoose} type="button">选择文件</button>}
    </div>
  );
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: value >= 100 ? 0 : 1 })} ${units[unit]}`;
}

function formatDate(timestamp: number) {
  const date = new Date(timestamp);
  const now = new Date();
  const dateParts = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(date);
  const todayParts = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(now);
  const dateKey = dateParts.filter((part) => part.type !== "literal").map((part) => part.value).join("-");
  const todayKey = todayParts.filter((part) => part.type !== "literal").map((part) => part.value).join("-");
  if (dateKey === todayKey) return `今天 ${date.toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" })}`;
  return date.toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "short", day: "numeric" });
}

function FileGlyph({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() || "file";
  const category = ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext) ? "image" : ["zip", "7z", "rar", "tar", "gz"].includes(ext) ? "archive" : ["pdf"].includes(ext) ? "pdf" : ["mp4", "mov", "mkv", "mp3", "wav"].includes(ext) ? "media" : "file";
  return <span className="file-icon" aria-hidden="true" data-type={ext.slice(0, 4).toUpperCase()}><svg className={`glyph-${category}`} viewBox="0 0 24 24" fill="none"><path d="M6.5 3.8h7l4.1 4.1v11.6c0 .4-.3.7-.7.7H7.2a.7.7 0 0 1-.7-.7V4.5c0-.4.3-.7.7-.7Z" stroke="currentColor" strokeWidth="1.5"/><path d="M13.2 4v4.4h4.4M9 12h6m-6 3h6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4"/></svg></span>;
}

function CloudIcon() { return <svg aria-hidden="true" viewBox="0 0 32 32" fill="none"><path d="M9.2 23.8h14.1a5.6 5.6 0 0 0 .6-11.2 8.3 8.3 0 0 0-15.8 2.1 4.6 4.6 0 0 0 1.1 9.1Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.1"/><path d="M16 21v-7m0 0-2.7 2.7M16 14l2.7 2.7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8"/></svg>; }
function SearchIcon() { return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none"><circle cx="8.8" cy="8.8" r="5.6" stroke="currentColor" strokeWidth="1.5"/><path d="m13 13 3.5 3.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5"/></svg>; }
function RefreshIcon({ className = "" }: { className?: string }) { return <svg aria-hidden="true" className={className} viewBox="0 0 20 20" fill="none"><path d="M16.3 8a6.5 6.5 0 0 0-11.8-2L3 8m0 0V4.7M3 8h3.3m-2.6 4a6.5 6.5 0 0 0 11.8 2l1.5-2m0 0v3.3m0-3.3h-3.3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4"/></svg>; }
function UploadIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M12 15.5V4.7m0 0L8.3 8.4M12 4.7l3.7 3.7M5.2 14.6v3.2c0 .8.6 1.4 1.4 1.4h10.8c.8 0 1.4-.6 1.4-1.4v-3.2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7"/></svg>; }
function SparkleIcon() { return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none"><path d="m10 2 1.4 5.6L17 9l-5.6 1.4L10 16l-1.4-5.6L3 9l5.6-1.4L10 2Zm5.3 11 .6 2.1 2.1.6-2.1.6-.6 2.1-.6-2.1-2.1-.6 2.1-.6.6-2.1Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.2"/></svg>; }
function ChevronIcon() { return <svg aria-hidden="true" viewBox="0 0 16 16" fill="none"><path d="m6 3.5 4.5 4.5L6 12.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4"/></svg>; }
function LinkIcon() { return <svg aria-hidden="true" viewBox="0 0 18 18" fill="none"><path d="M7.2 10.8 10.8 7.2m-5 5.8-1.3 1.3a3 3 0 0 1-4.2-4.2l3-3A3 3 0 0 1 7.5 7m3 4a3 3 0 0 0 4.2-.1l3-3a3 3 0 0 0-4.2-4.2l-1.3 1.3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4"/></svg>; }
function TrashIcon() { return <svg aria-hidden="true" viewBox="0 0 18 18" fill="none"><path d="M3.8 5.1h10.4m-9.2 0 .6 9.5c0 .5.5.9 1 .9h4.8c.5 0 1-.4 1-.9l.6-9.5M7 5.1V3.7c0-.5.4-.9.9-.9h2.2c.5 0 .9.4.9.9v1.4m-3.6 3v4.3m3.2-4.3v4.3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.35"/></svg>; }
function PauseIcon() { return <svg aria-hidden="true" viewBox="0 0 18 18" fill="none"><path d="M6 4v10m6-10v10" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5"/></svg>; }
function PlayIcon() { return <svg aria-hidden="true" viewBox="0 0 18 18" fill="none"><path d="m6 3.5 8 5.5-8 5.5V3.5Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5"/></svg>; }
function CloseIcon() { return <svg aria-hidden="true" viewBox="0 0 18 18" fill="none"><path d="m5 5 8 8m0-8-8 8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5"/></svg>; }
function CheckIcon() { return <svg aria-hidden="true" viewBox="0 0 18 18" fill="none"><path d="m3.7 9.3 3.4 3.4 7.2-7.4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8"/></svg>; }
function LockIcon() { return <svg aria-hidden="true" viewBox="0 0 18 18" fill="none"><rect x="3.7" y="7.4" width="10.6" height="8" rx="2" stroke="currentColor" strokeWidth="1.4"/><path d="M6.2 7.3V5.6a2.8 2.8 0 0 1 5.6 0v1.7" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4"/></svg>; }
function LogoutIcon() { return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none"><path d="M8 4H5.2a1.2 1.2 0 0 0-1.2 1.2v9.6A1.2 1.2 0 0 0 5.2 16H8m3.2-9.2L15 10l-3.8 3.2M7.3 10H15" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"/></svg>; }
function TerminalIcon() { return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none"><path d="m3.5 5 4.2 4.2-4.2 4.2m6.7.1h6.3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"/></svg>; }
function DownloadIcon() { return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none"><path d="M10 3.5v8m0 0 3-3m-3 3-3-3M4 13.5v2.2c0 .4.3.8.8.8h10.4c.4 0 .8-.4.8-.8v-2.2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"/></svg>; }
function FolderIcon() { return <svg aria-hidden="true" viewBox="0 0 28 28" fill="none"><path d="M3.8 7.7c0-1 .8-1.7 1.7-1.7h6.2l2.1 2.2h8.7c1 0 1.7.8 1.7 1.7v10.4c0 1-.8 1.7-1.7 1.7H5.5c-1 0-1.7-.8-1.7-1.7V7.7Z" stroke="currentColor" strokeWidth="1.5"/><path d="M4.3 11.4h19.4" stroke="currentColor" strokeWidth="1.5"/></svg>; }
