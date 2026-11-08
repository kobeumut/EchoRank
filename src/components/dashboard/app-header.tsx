"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch } from "./api";
import { Button } from "./ui";

function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);
  useEffect(() => {
    // Read the class applied by the inline theme script (external DOM state).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDark(document.documentElement.classList.contains("dark"));
  }, []);
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={dark ? "Açık temaya geç" : "Koyu temaya geç"}
      onClick={() => {
        const next = !document.documentElement.classList.contains("dark");
        document.documentElement.classList.toggle("dark", next);
        localStorage.setItem("theme", next ? "dark" : "light");
        setDark(next);
      }}
    >
      <span aria-hidden>{dark ? "☀" : "☾"}</span>
    </Button>
  );
}

/** Static header shown while the route's URL data streams in. */
export function AppHeaderFallback() {
  return (
    <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white/85 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/85">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6">
        <span className="flex items-center gap-2 font-semibold text-zinc-900 dark:text-zinc-100">
          <span aria-hidden className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-xs font-bold text-white">
            AI
          </span>
          <span className="hidden sm:inline">AI Visibility</span>
        </span>
      </div>
    </header>
  );
}

export function AppHeader() {
  const pathname = usePathname();
  const [auth, setAuth] = useState<{ required: boolean; authenticated: boolean } | null>(null);
  useEffect(() => {
    apiFetch<{ required: boolean; authenticated: boolean }>("/api/auth").then(setAuth, () => setAuth(null));
  }, [pathname]);

  if (pathname === "/login") return null;
  return (
    <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white/85 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/85">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold text-zinc-900 dark:text-zinc-100">
          <span aria-hidden className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-xs font-bold text-white">
            AI
          </span>
          <span className="hidden sm:inline">AI Visibility</span>
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          <Link
            href="/"
            className={`rounded-md px-2.5 py-1.5 ${pathname === "/" ? "bg-zinc-100 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"}`}
          >
            Siteler
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
          {auth?.required && auth.authenticated && (
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await apiFetch("/api/auth", { method: "DELETE" }).catch(() => undefined);
                window.location.assign("/login");
              }}
            >
              Çıkış
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
