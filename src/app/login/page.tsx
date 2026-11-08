import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "@/components/dashboard/login-form";

export const metadata: Metadata = { title: "Giriş" };

export default function LoginPage() {
  return (
    <main className="flex min-h-[80vh] items-center justify-center p-6">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
