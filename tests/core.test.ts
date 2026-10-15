import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDataDirectory = mkdtempSync(join(tmpdir(), "ffast-vitest-"));
process.env.DATA_DIR = testDataDirectory;
process.env.MAX_UPLOAD_SIZE_BYTES = "5";
process.env.PUBLIC_BASE_URL = "http://ffast.test";
process.env.COOKIE_SECURE = "false";

const { db, filesDirectory, tempDirectory } = await import("@/lib/db");
const { hashPassword, verifyPassword } = await import("@/lib/password");
const { encodeDownloadFileName, sanitizeFileName, saveUploadedFile } = await import("@/lib/files");
const setupRoute = await import("@/app/api/setup/route");
const sessionRoute = await import("@/app/api/session/route");
const filesRoute = await import("@/app/api/files/route");
const fileItemRoute = await import("@/app/api/files/[id]/route");
const downloadRoute = await import("@/app/download/[token]/route");

const origin = "http://ffast.test";
const adminPassword = "1234";

function makeRequest(
  path: string,
  options: { method?: string; cookie?: string; body?: BodyInit | null; headers?: Record<string, string> } = {},
) {
  const headers = new Headers({ origin, ...options.headers });
  if (options.cookie) headers.set("cookie", options.cookie);
  return new Request(new URL(path, origin), {
    method: options.method ?? "GET",
    headers,
    body: options.body,
  });
}

function responseCookie(response: Response) {
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toBeTruthy();
  return cookie!.split(";", 1)[0];
}

function makeSetupFormRequest(fields: Record<string, string>, requestOrigin = origin) {
  return makeRequest("/api/setup", {
    method: "POST",
    headers: {
      origin: requestOrigin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields),
  });
}

async function initializeAdmin() {
  const response = await setupRoute.POST(makeRequest("/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: adminPassword, confirmation: adminPassword }),
  }));
  expect(response.status).toBe(200);
  return responseCookie(response);
}

function clearDirectory(directory: string) {
  for (const entry of readdirSync(directory)) {
    rmSync(join(directory, entry), { recursive: true, force: true });
  }
}

beforeEach(() => {
  db.prepare("DELETE FROM files").run();
  db.prepare("DELETE FROM sessions").run();
  db.prepare("DELETE FROM login_limits").run();
  db.prepare("DELETE FROM settings").run();
  clearDirectory(filesDirectory);
  clearDirectory(tempDirectory);
});

afterAll(() => {
  db.close();
  rmSync(testDataDirectory, { recursive: true, force: true });
});

describe("password and file helpers", () => {
  it("hashes passwords and rejects wrong or malformed hashes", async () => {
    const encoded = await hashPassword(adminPassword);

    expect(encoded).toMatch(/^scrypt\$/);
    await expect(verifyPassword(adminPassword, encoded)).resolves.toBe(true);
    await expect(verifyPassword("another-password", encoded)).resolves.toBe(false);
    await expect(verifyPassword("anything", "not-a-password-hash")).resolves.toBe(false);
  });

  it("decodes and strips path components from uploaded names", () => {
    expect(sanitizeFileName(encodeURIComponent("../../private/报告 final.pdf"))).toBe("报告 final.pdf");
    expect(sanitizeFileName(encodeURIComponent("..\\..\\secret.txt"))).toBe("secret.txt");
    expect(sanitizeFileName(null)).toBe("未命名文件");
    expect(() => sanitizeFileName("bad%ZZname")).toThrow("文件名格式无效。");
  });

  it("creates a curl/wget-compatible UTF-8 attachment filename", () => {
    expect(encodeDownloadFileName("résumé.pdf")).toBe(
      "attachment; filename=\"r_sum_.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
    );
  });
});

describe("authentication and file API", () => {
  it("initializes once, validates the password, and issues a protected session cookie", async () => {
    const tooShortPassword = await setupRoute.POST(makeRequest("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "123", confirmation: "123" }),
    }));
    expect(tooShortPassword.status).toBe(400);

    const tooLongPassword = await setupRoute.POST(makeRequest("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "1".repeat(1025), confirmation: "1".repeat(1025) }),
    }));
    expect(tooLongPassword.status).toBe(400);

    const mismatchedPasswords = await setupRoute.POST(makeRequest("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "1234", confirmation: "4321" }),
    }));
    expect(mismatchedPasswords.status).toBe(400);
    await expect(mismatchedPasswords.json()).resolves.toEqual({ error: "两次输入的密码不一致。" });

    const successfulSetup = await setupRoute.POST(makeRequest("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: adminPassword, confirmation: adminPassword }),
    }));
    const cookie = responseCookie(successfulSetup);
    expect(successfulSetup.status).toBe(200);

    const loginResponse = await sessionRoute.POST(makeRequest("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "1234" }),
    }));
    expect(loginResponse.status).toBe(200);
    responseCookie(loginResponse);

    const setCookie = successfulSetup.headers.get("set-cookie")!;
    const setupResponse = await setupRoute.POST(makeRequest("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: adminPassword, confirmation: adminPassword }),
    }));

    expect(cookie).toContain("ffast_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setupResponse.status).toBe(409);
    expect(setupResponse.headers.get("set-cookie")).toBeNull();
  });

  it("supports native setup form submissions with redirects and safe feedback", async () => {
    const tooShort = await setupRoute.POST(makeSetupFormRequest({ password: "123", confirmation: "123" }));
    expect(tooShort.status).toBe(303);
    const shortPasswordLocation = new URL(tooShort.headers.get("location")!);
    expect(shortPasswordLocation.pathname).toBe("/setup");
    expect(shortPasswordLocation.searchParams.get("error")).toBe("password");

    const mismatch = await setupRoute.POST(makeSetupFormRequest({ password: "1234", confirmation: "4321" }));
    expect(mismatch.status).toBe(303);
    expect(new URL(mismatch.headers.get("location")!).searchParams.get("error")).toBe("mismatch");

    const invalidOrigin = await setupRoute.POST(
      makeSetupFormRequest({ password: adminPassword, confirmation: adminPassword }, "http://untrusted.test"),
    );
    expect(invalidOrigin.status).toBe(303);
    expect(new URL(invalidOrigin.headers.get("location")!).searchParams.get("error")).toBe("origin");

    const successfulSetup = await setupRoute.POST(
      makeSetupFormRequest({ password: adminPassword, confirmation: adminPassword }),
    );
    expect(successfulSetup.status).toBe(303);
    expect(new URL(successfulSetup.headers.get("location")!).pathname).toBe("/files");
    expect(responseCookie(successfulSetup)).toContain("ffast_session=");

    const repeatedSetup = await setupRoute.POST(
      makeSetupFormRequest({ password: adminPassword, confirmation: adminPassword }),
    );
    expect(repeatedSetup.status).toBe(303);
    expect(new URL(repeatedSetup.headers.get("location")!).searchParams.get("notice")).toBe("setup-initialized");
  });

  it("keeps setup redirects on the browser loopback address when the server URL is 0.0.0.0", async () => {
    const previousBaseUrl = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = "http://localhost:3000";

    try {
      const response = await setupRoute.POST(new Request("http://0.0.0.0:3000/api/setup", {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:3000",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ password: adminPassword, confirmation: adminPassword }),
      }));

      expect(response.status).toBe(303);
      const destination = new URL(response.headers.get("location")!);
      expect(destination.origin).toBe("http://127.0.0.1:3000");
      expect(destination.pathname).toBe("/files");
      expect(responseCookie(response)).toContain("ffast_session=");
    } finally {
      if (previousBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = previousBaseUrl;
    }
  });

  it("accepts loopback browser origins when PUBLIC_BASE_URL is unset and the server URL is a wildcard address", async () => {
    const previousBaseUrl = process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;

    try {
      const response = await setupRoute.POST(new Request("http://0.0.0.0:3000/api/setup", {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:3000",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ password: adminPassword, confirmation: adminPassword }),
      }));

      expect(response.status).toBe(303);
      const destination = new URL(response.headers.get("location")!);
      expect(destination.origin).toBe("http://127.0.0.1:3000");
      expect(destination.pathname).toBe("/files");
      expect(responseCookie(response)).toContain("ffast_session=");
    } finally {
      if (previousBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = previousBaseUrl;
    }
  });

  it("blocks unauthenticated management requests and supports successful login/logout", async () => {
    const unauthorizedList = filesRoute.GET(makeRequest("/api/files"));
    expect(unauthorizedList.status).toBe(401);
    const unauthorizedUpload = await filesRoute.POST(makeRequest("/api/files", {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-file-name": "blocked.txt" },
      body: new Blob(["no session"]),
    }));
    expect(unauthorizedUpload.status).toBe(401);
    expect(readdirSync(filesDirectory)).toEqual([]);

    await initializeAdmin();
    const loginResponse = await sessionRoute.POST(makeRequest("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: adminPassword }),
    }));
    expect(loginResponse.status).toBe(200);
    const cookie = responseCookie(loginResponse);

    const authorizedList = filesRoute.GET(makeRequest("/api/files", { cookie }));
    expect(authorizedList.status).toBe(200);
    await expect(authorizedList.json()).resolves.toEqual({ files: [] });

    const logoutResponse = sessionRoute.DELETE(makeRequest("/api/session", { method: "DELETE", cookie }));
    expect(logoutResponse.status).toBe(200);
    expect(sessionRoute.GET(makeRequest("/api/session", { cookie })).status).toBe(200);
    await expect(sessionRoute.GET(makeRequest("/api/session", { cookie })).json()).resolves.toEqual({ authenticated: false });
  });

  it("rate-limits repeated invalid login attempts", async () => {
    await initializeAdmin();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await sessionRoute.POST(makeRequest("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "198.51.100.25" },
        body: JSON.stringify({ password: "incorrect-password" }),
      }));
      expect(response.status).toBe(401);
    }

    const blocked = await sessionRoute.POST(makeRequest("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "198.51.100.25" },
      body: JSON.stringify({ password: adminPassword }),
    }));
    expect(blocked.status).toBe(429);
  });

  it("uploads a file, serves it publicly, then revokes the link when deleted", async () => {
    const cookie = await initializeAdmin();
    const uploadResponse = await filesRoute.POST(makeRequest("/api/files", {
      method: "POST",
      cookie,
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent("共享文件.txt"),
      },
      body: new Blob(["hello"]),
    }));

    expect(uploadResponse.status).toBe(201);
    const uploaded = await uploadResponse.json() as { id: string; name: string; size: number; downloadUrl: string };
    expect(uploaded.name).toBe("共享文件.txt");
    expect(uploaded.size).toBe(5);

    const listed = await filesRoute.GET(makeRequest("/api/files", { cookie }));
    await expect(listed.json()).resolves.toMatchObject({ files: [expect.objectContaining({ id: uploaded.id })] });

    const token = new URL(uploaded.downloadUrl).pathname.split("/").at(-1)!;
    const downloadResponse = await downloadRoute.GET(makeRequest(`/download/${token}`), {
      params: Promise.resolve({ token }),
    });
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    await expect(downloadResponse.text()).resolves.toBe("hello");

    const deleteResponse = await fileItemRoute.DELETE(makeRequest(`/api/files/${uploaded.id}`, {
      method: "DELETE",
      cookie,
    }), { params: Promise.resolve({ id: uploaded.id }) });
    expect(deleteResponse.status).toBe(200);

    const revokedDownload = await downloadRoute.GET(makeRequest(`/download/${token}`), {
      params: Promise.resolve({ token }),
    });
    expect(revokedDownload.status).toBe(404);
    expect(readdirSync(filesDirectory)).toEqual([]);
  });

  it("rejects oversized uploads and removes the partial file", async () => {
    const cookie = await initializeAdmin();
    const response = await filesRoute.POST(makeRequest("/api/files", {
      method: "POST",
      cookie,
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": "too-large.bin",
      },
      body: new Blob(["123456"]),
    }));

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("5 B") });
    expect(readdirSync(filesDirectory)).toEqual([]);
    expect(readdirSync(tempDirectory)).toEqual([]);
  });

  it("removes temporary data when an upload stream is interrupted", async () => {
    const interruptedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("connection interrupted"));
      },
    });
    const interruptedRequest = new Request(new URL("/api/files", origin), {
      method: "POST",
      body: interruptedStream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(saveUploadedFile(interruptedRequest, "interrupted.bin")).rejects.toThrow();
    expect(readdirSync(filesDirectory)).toEqual([]);
    expect(readdirSync(tempDirectory)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM files").get()).toMatchObject({ count: 0 });
  });
});
