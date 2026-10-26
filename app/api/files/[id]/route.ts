import { NextResponse } from "next/server";
import { hasTrustedOrigin, isAuthenticatedRequest } from "@/lib/auth";
import { deleteStoredFile, getFileById, getFileSha256 } from "@/lib/files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isAuthenticatedRequest(request)) return NextResponse.json({ error: "需要登录。" }, { status: 401 });

  const { id } = await context.params;
  const file = getFileById(id);
  if (!file) return NextResponse.json({ error: "文件不存在。" }, { status: 404 });

  try {
    const sha256 = await getFileSha256(file);
    return NextResponse.json({ sha256 }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "无法读取文件哈希。" }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isAuthenticatedRequest(request)) return NextResponse.json({ error: "需要登录。" }, { status: 401 });
  if (!hasTrustedOrigin(request)) return NextResponse.json({ error: "请求来源无效。" }, { status: 403 });

  const { id } = await context.params;
  const file = getFileById(id);
  if (!file) return NextResponse.json({ error: "文件不存在。" }, { status: 404 });

  try {
    await deleteStoredFile(file);
  } catch {
    return NextResponse.json({ error: "删除失败，请稍后重试。" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
