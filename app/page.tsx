import { redirect } from "next/navigation";
import { isAuthenticatedPage } from "@/lib/auth";
import { isInitialized } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  if (!isInitialized()) redirect("/setup");
  redirect((await isAuthenticatedPage()) ? "/files" : "/login");
}
