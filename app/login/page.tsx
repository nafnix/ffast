import { redirect } from "next/navigation";
import { AuthForm } from "@/app/auth-form";
import { isAuthenticatedPage } from "@/lib/auth";
import { isInitialized } from "@/lib/db";
import { setupErrorMessages } from "@/lib/setup-errors";

export const dynamic = "force-dynamic";

type LoginPageProps = {
  searchParams: Promise<{ notice?: string | string[] }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { notice } = await searchParams;
  if (!isInitialized()) redirect("/setup");
  if (await isAuthenticatedPage()) redirect("/files");
  const initialMessage = notice === "setup-initialized" ? setupErrorMessages.initialized : undefined;
  return <AuthForm mode="login" initialMessage={initialMessage} />;
}
