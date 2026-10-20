import { cancelSession, locked, uploadStatus } from "@/lib/resumable";
import { shareFile, uploadApi } from "@/lib/upload-api";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return uploadApi(request, () => locked(id, async () => { const result = await uploadStatus(id); return { ...result, file: result.file ? shareFile(request, result.file) : undefined }; }));
}
export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params;
  return uploadApi(request, () => locked(id, async () => { await cancelSession(id); return { ok: true }; }));
}
