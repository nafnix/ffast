import { hasTrustedOrigin, isAuthenticatedRequest } from "@/lib/auth";
import { cleanupUploads, TransferError } from "@/lib/resumable";
import { publicDownloadUrl, type FileRecord } from "@/lib/files";
export function shareFile(request: Request, file: FileRecord) {
  return { id: file.id, name: file.file_name, size: file.size, createdAt: file.created_at, downloadUrl: publicDownloadUrl(request, file.share_token) };
}
export async function uploadApi(request: Request, action: () => Promise<unknown>, status = 200) {
  if (!isAuthenticatedRequest(request)) return Response.json({ error: "需要登录。" }, { status: 401 });
  if (request.method !== "GET" && !hasTrustedOrigin(request)) return Response.json({ error: "请求来源无效。" }, { status: 403 });
  try { cleanupUploads(); return Response.json(await action(), { status, headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return Response.json({ error: error instanceof SyntaxError ? "上传信息格式无效。" : error instanceof TransferError ? error.message : "上传失败，请检查磁盘空间后重试。" }, { status: error instanceof SyntaxError ? 400 : error instanceof TransferError ? error.status : 500 }); }
}
