import { locked, writeChunk } from "@/lib/resumable";
import { uploadApi } from "@/lib/upload-api";
export const runtime = "nodejs";
export async function PUT(request: Request, context: { params: Promise<{ id: string; index: string }> }) {
  const { id, index } = await context.params;
  return uploadApi(request, () => locked(id, () => writeChunk(id, /^\d+$/.test(index) ? Number(index) : NaN, request)));
}
