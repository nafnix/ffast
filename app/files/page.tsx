import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { FileManager, type ShareFile } from "@/app/files/file-manager";
import { isAuthenticatedPage } from "@/lib/auth";
import { getMaxUploadBytes, isInitialized } from "@/lib/db";
import { listFiles } from "@/lib/files";

export const dynamic = "force-dynamic";

export default async function FilesPage() {
  if (!isInitialized()) redirect("/setup");
  if (!(await isAuthenticatedPage())) redirect("/login");

  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = process.env.PUBLIC_BASE_URL
    ? new URL(process.env.PUBLIC_BASE_URL).protocol.replace(":", "")
    : requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  const baseUrl = process.env.PUBLIC_BASE_URL || `${protocol}://${host}`;
  const files: ShareFile[] = listFiles().map((file) => ({
    id: file.id,
    name: file.file_name,
    size: file.size,
    createdAt: file.created_at,
    downloadUrl: new URL(`/download/${file.share_token}`, baseUrl).toString(),
    sha256: file.sha256,
  }));

  return <FileManager initialFiles={files} maxUploadBytes={getMaxUploadBytes()} />;
}
