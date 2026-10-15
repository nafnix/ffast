import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { db } from "@/lib/db";

export const SESSION_COOKIE = "ffast_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

export function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createSession() {
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions(token_hash, expires_at) VALUES (?, ?)").run(
    hashSessionToken(token),
    Date.now() + SESSION_TTL_MS,
  );
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
  return token;
}

function isValidSessionToken(token: string | undefined) {
  if (!token) return false;
  const session = db.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").get(hashSessionToken(token)) as
    | { expires_at: number }
    | undefined;
  if (!session) return false;
  if (session.expires_at <= Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashSessionToken(token));
    return false;
  }
  return true;
}

function readCookie(cookieHeader: string | null, name: string) {
  if (!cookieHeader) return undefined;
  const prefix = `${name}=`;
  const value = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return value ? value.slice(prefix.length) : undefined;
}

export function isAuthenticatedRequest(request: Request) {
  return isValidSessionToken(readCookie(request.headers.get("cookie"), SESSION_COOKIE));
}

export async function isAuthenticatedPage() {
  const cookieStore = await cookies();
  return isValidSessionToken(cookieStore.get(SESSION_COOKIE)?.value);
}

export function setSessionCookie(response: Response, token: string) {
  const secureSetting = process.env.COOKIE_SECURE;
  const secure = secureSetting === undefined ? process.env.NODE_ENV === "production" : secureSetting === "true";
  const cookie = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
  response.headers.append("Set-Cookie", cookie);
}

export function clearSession(request: Request, response: Response) {
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashSessionToken(token));
  response.headers.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function isLoopbackHost(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isWildcardBindHost(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "0.0.0.0" || normalized === "::";
}

function areEquivalentLoopbackOrigins(first: string, second: string) {
  try {
    const firstUrl = new URL(first);
    const secondUrl = new URL(second);
    return firstUrl.protocol === secondUrl.protocol
      && firstUrl.port === secondUrl.port
      && isLoopbackHost(firstUrl.hostname)
      && (isLoopbackHost(secondUrl.hostname) || isWildcardBindHost(secondUrl.hostname));
  } catch {
    return false;
  }
}

export function hasTrustedOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  const configuredBase = process.env.PUBLIC_BASE_URL;
  const expectedOrigin = configuredBase ? new URL(configuredBase).origin : new URL(request.url).origin;
  return origin === expectedOrigin || areEquivalentLoopbackOrigins(origin, expectedOrigin);
}

function getRateLimitKey(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || request.headers.get("x-real-ip") || "local";
  return createHash("sha256").update(address).digest("hex");
}

export function loginBlocked(request: Request) {
  const key = getRateLimitKey(request);
  const limit = db.prepare("SELECT blocked_until FROM login_limits WHERE key = ?").get(key) as
    | { blocked_until: number }
    | undefined;
  return Boolean(limit && limit.blocked_until > Date.now());
}

export function recordFailedLogin(request: Request) {
  const key = getRateLimitKey(request);
  const now = Date.now();
  const existing = db.prepare("SELECT failures, window_started_at FROM login_limits WHERE key = ?").get(key) as
    | { failures: number; window_started_at: number }
    | undefined;

  const stillInWindow = existing && existing.window_started_at + LOGIN_WINDOW_MS > now;
  const failures = stillInWindow ? existing.failures + 1 : 1;
  const windowStartedAt = stillInWindow ? existing.window_started_at : now;
  const blockedUntil = failures >= LOGIN_MAX_FAILURES ? now + LOGIN_WINDOW_MS : 0;

  db.prepare(`
    INSERT INTO login_limits(key, failures, window_started_at, blocked_until)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      failures = excluded.failures,
      window_started_at = excluded.window_started_at,
      blocked_until = excluded.blocked_until
  `).run(key, failures, windowStartedAt, blockedUntil);
}

export function clearLoginFailures(request: Request) {
  db.prepare("DELETE FROM login_limits WHERE key = ?").run(getRateLimitKey(request));
}
