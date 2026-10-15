import { NextResponse } from "next/server";
import {
  clearLoginFailures,
  clearSession,
  createSession,
  hasTrustedOrigin,
  isAuthenticatedRequest,
  loginBlocked,
  recordFailedLogin,
  setSessionCookie,
} from "@/lib/auth";
import { db, isInitialized } from "@/lib/db";
import { verifyPassword } from "@/lib/password";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!hasTrustedOrigin(request)) return NextResponse.json({ error: "请求来源无效。" }, { status: 403 });
  if (!isInitialized()) return NextResponse.json({ error: "请先初始化服务。" }, { status: 409 });
  if (loginBlocked(request)) return NextResponse.json({ error: "尝试次数过多，请 15 分钟后重试。" }, { status: 429 });

  let body: { password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求内容无效。" }, { status: 400 });
  }

  const password = typeof body.password === "string" ? body.password : "";
  const stored = db.prepare("SELECT value FROM settings WHERE key = ?").get("admin_password_hash") as
    | { value: string }
    | undefined;
  const valid = stored ? await verifyPassword(password, stored.value) : false;

  if (!valid) {
    recordFailedLogin(request);
    return NextResponse.json({ error: "密码不正确。" }, { status: 401 });
  }

  clearLoginFailures(request);
  const response = NextResponse.json({ ok: true });
  setSessionCookie(response, createSession());
  return response;
}

export function DELETE(request: Request) {
  if (!hasTrustedOrigin(request)) return NextResponse.json({ error: "请求来源无效。" }, { status: 403 });
  const response = NextResponse.json({ ok: true });
  clearSession(request, response);
  return response;
}

export function GET(request: Request) {
  return NextResponse.json({ authenticated: isAuthenticatedRequest(request) });
}
