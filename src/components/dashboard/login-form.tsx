"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { apiFetch, errorMessage } from "./api";
import { Button, Field, inputClass } from "./ui";

/** Only same-site relative paths are allowed as the post-login target. */
function safeNext(value: string | null) {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export function LoginForm() {
  const params = useSearchParams();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await apiFetch("/api/auth", { method: "POST", json: { token } });
          window.location.assign(safeNext(params.get("next")));
        } catch (err) {
          setError(errorMessage(err) === "Invalid token" ? "Geçersiz erişim anahtarı." : errorMessage(err));
          setBusy(false);
        }
      }}
    >
      <div className="mb-5 flex items-center gap-2">
        <span aria-hidden className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-xs font-bold text-white">
          AI
        </span>
        <h1 className="text-lg font-semibold">AI Visibility</h1>
      </div>
      <p className="mb-4 text-sm text-zinc-500">Bu panel korumalı. Devam etmek için sunucudaki <code>API_TOKEN</code> değerini girin.</p>
      <Field label="Erişim anahtarı">
        <input type="password" autoComplete="current-password" required value={token} onChange={(e) => setToken(e.target.value)} className={inputClass} autoFocus />
      </Field>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" loading={busy} className="mt-5 w-full">
        Giriş yap
      </Button>
    </form>
  );
}
