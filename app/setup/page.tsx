import { redirect } from "next/navigation";
import { AuthForm } from "@/app/auth-form";
import { isAuthenticatedPage } from "@/lib/auth";
import { isInitialized } from "@/lib/db";
import { isSetupErrorCode, setupErrorMessages } from "@/lib/setup-errors";

export const dynamic = "force-dynamic";

type SetupPageProps = {
  searchParams: Promise<{ error?: string | string[] }>;
};

export default async function SetupPage({ searchParams }: SetupPageProps) {
  const { error } = await searchParams;
  const errorCode = typeof error === "string" && isSetupErrorCode(error) ? error : undefined;
  if (isInitialized()) redirect((await isAuthenticatedPage()) ? "/files" : "/login");
  return <AuthForm mode="setup" initialMessage={errorCode ? setupErrorMessages[errorCode] : undefined} />;
}
