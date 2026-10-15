import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { join } from "node:path";
import { filesDirectory } from "@/lib/db";
import { encodeDownloadFileName, getFileByToken } from "@/lib/files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
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

  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
  return new Response(stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(stat.size),
      "Content-Disposition": encodeDownloadFileName(file.file_name),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
