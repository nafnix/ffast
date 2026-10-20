import { finishUpload, locked } from "@/lib/resumable";
import { shareFile, uploadApi } from "@/lib/upload-api";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return uploadApi(request, () => locked(id, async () => shareFile(request, await finishUpload(id))), 201);
}
