import { NextResponse } from "next/server";
import { hasTrustedOrigin, isAuthenticatedRequest } from "@/lib/auth";
import { getMaxUploadBytes } from "@/lib/db";
import { listFiles, publicDownloadUrl, sanitizeFileName, saveUploadedFile, UploadTooLargeError } from "@/lib/files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  if (!isAuthenticatedRequest(request)) return NextResponse.json({ error: "需要登录。" }, { status: 401 });
  const files = listFiles().map((file) => ({
    id: file.id,
    name: file.file_name,
    size: file.size,
    createdAt: file.created_at,
    downloadUrl: publicDownloadUrl(request, file.share_token),
  }));
  return NextResponse.json({ files });
}

export async function POST(request: Request) {
  if (!isAuthenticatedRequest(request)) return NextResponse.json({ error: "需要登录。" }, { status: 401 });
  if (!hasTrustedOrigin(request)) return NextResponse.json({ error: "请求来源无效。" }, { status: 403 });

  try {
    const fileName = sanitizeFileName(request.headers.get("x-file-name"));
    const file = await saveUploadedFile(request, fileName);
    return NextResponse.json(
      {
        id: file.id,
        name: file.file_name,
        size: file.size,
        createdAt: file.created_at,
        downloadUrl: publicDownloadUrl(request, file.share_token),
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof UploadTooLargeError) {
      const limitBytes = getMaxUploadBytes();
      const limitLabel = limitBytes % 1024 ** 3 === 0
        ? `${limitBytes / 1024 ** 3} GiB`
        : limitBytes >= 1024 ** 2
          ? `${(limitBytes / 1024 ** 2).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} MiB`
          : `${limitBytes.toLocaleString("zh-CN")} B`;
      return NextResponse.json(
        { error: `文件超过大小上限（${limitLabel}）。` },
        { status: 413 },
      );
    }
    if (error instanceof Error && error.message === "文件名格式无效。") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof Error && error.message === "上传内容不完整。") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "上传失败，请检查磁盘空间后重试。" }, { status: 500 });
  }
}
