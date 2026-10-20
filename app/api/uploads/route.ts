import { createUpload } from "@/lib/resumable";
import { uploadApi } from "@/lib/upload-api";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return uploadApi(request, async () => createUpload(await request.json()), 201);
}
