import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { join } from "node:path";
import { filesDirectory } from "@/lib/db";
import { encodeDownloadFileName, getFileByToken } from "@/lib/files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function download(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const file = getFileByToken(token);
  if (!file) return new Response("文件不存在或分享链接已失效。", { status: 404 });

  const filePath = join(filesDirectory, file.id);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return new Response("文件不存在或分享链接已失效。", { status: 404 });
  }

  const etag = `"${file.id}"`;
  const modified = new Date(file.created_at).toUTCString();
  const headers = new Headers({
      "Content-Type": "application/octet-stream",
      "Content-Length": String(stat.size),
      "Content-Disposition": encodeDownloadFileName(file.file_name),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Accept-Ranges": "bytes",
      "ETag": etag,
      "Last-Modified": modified,
  });
  let start = 0, end = stat.size - 1, status = 200;
  const range = request.headers.get("range");
  const ifRange = request.headers.get("if-range");
  const matches = !ifRange || ifRange === etag || (!ifRange.startsWith('"') && !ifRange.startsWith("W/") && Number.isFinite(Date.parse(ifRange)) && Date.parse(ifRange) >= Date.parse(modified));
  const match = request.method !== "HEAD" && matches && range?.match(/^bytes=(\d*)-(\d*)$/);
  if (match && (match[1] || match[2])) {
    if (!match[1]) start = Math.max(0, stat.size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (stat.size === 0 || start >= stat.size || end < start || (!match[1] && Number(match[2]) === 0)) {
      headers.set("Content-Range", `bytes */${stat.size}`);
      headers.set("Content-Length", "0");
      return new Response(null, { status: 416, headers });
    }
    status = 206;
    headers.set("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    headers.set("Content-Length", String(end - start + 1));
  }
  const stream = request.method === "HEAD" || stat.size === 0 ? null : Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(stream, { status, headers });
}

export const GET = download;
export const HEAD = download;
