import { NextResponse } from "next/server";
import { createSession, hasTrustedOrigin, setSessionCookie } from "@/lib/auth";
import { db, isInitialized } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { setupErrorMessages, type SetupErrorCode } from "@/lib/setup-errors";

export const runtime = "nodejs";

function isFormSubmission(request: Request) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim();
  return contentType === "application/x-www-form-urlencoded" || contentType === "multipart/form-data";
}

function redirectToPath(request: Request, path: string) {
  const origin = request.headers.get("origin");
  const baseUrl = origin && hasTrustedOrigin(request) ? origin : request.url;
  return NextResponse.redirect(new URL(path, baseUrl), 303);
}

function errorResponse(request: Request, formSubmission: boolean, code: SetupErrorCode, status: number) {
  if (formSubmission) {
    const destination = code === "initialized"
      ? "/login?notice=setup-initialized"
      : `/setup?error=${code}`;
    return redirectToPath(request, destination);
  }

  return NextResponse.json({ error: setupErrorMessages[code] }, { status });
}

export async function POST(request: Request) {
  const formSubmission = isFormSubmission(request);
  if (!hasTrustedOrigin(request)) return errorResponse(request, formSubmission, "origin", 403);
  if (isInitialized()) return errorResponse(request, formSubmission, "initialized", 409);

  let password: unknown;
  let confirmation: unknown;
  try {
    if (formSubmission) {
      const body = await request.formData();
      password = body.get("password");
      confirmation = body.get("confirmation");
    } else {
      const body: unknown = await request.json();
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const fields = body as Record<string, unknown>;
        password = fields.password;
        confirmation = fields.confirmation;
      }
    }
  } catch {
    return errorResponse(request, formSubmission, "request", 400);
  }

  if (typeof password !== "string" || typeof confirmation !== "string") {
    return errorResponse(request, formSubmission, "request", 400);
  }
  if (password !== confirmation) return errorResponse(request, formSubmission, "mismatch", 400);
  if (password.length < 4 || password.length > 1024) return errorResponse(request, formSubmission, "password", 400);

  const passwordHash = await hashPassword(password);
  const didInitialize = db.transaction(() => {
    if (isInitialized()) return false;
    db.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run("admin_password_hash", passwordHash);
    return true;
  })();

  if (!didInitialize) return errorResponse(request, formSubmission, "initialized", 409);

  const response = formSubmission ? redirectToPath(request, "/files") : NextResponse.json({ ok: true });
  setSessionCookie(response, createSession());
  return response;
}
