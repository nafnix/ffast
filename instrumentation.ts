export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { cleanupUploads } = await import("@/lib/resumable");
    cleanupUploads();
  }
}
