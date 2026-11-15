import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "@/components/dashboard/login-form";
import { getT } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("auth.login.title") };
}

export default function LoginPage() {
  return (
    <main className="flex min-h-[80vh] items-center justify-center p-6">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
