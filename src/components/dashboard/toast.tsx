"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useT } from "@/lib/i18n/provider";
import { setApiTranslator } from "./api";

type ToastOptions = {
  /** "top": a notification in the top-right corner (e.g. a background job finished); default bottom-right. */
  placement?: "top" | "bottom";
  action?: { href: string; label: string };
};
type Toast = { id: number; kind: "success" | "error" | "info"; message: string } & ToastOptions;
type ToastApi = { push: (kind: Toast["kind"], message: string, options?: ToastOptions) => void };

const ToastContext = createContext<ToastApi>({ push: () => {} });
export const useToast = () => useContext(ToastContext);

const STYLES: Record<Toast["kind"], string> = {
  success: "border-emerald-500/40 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100",
  error: "border-red-500/40 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100",
  info: "border-zinc-300 bg-white text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100",
};
const ICONS: Record<Toast["kind"], string> = { success: "✓", error: "!", info: "i" };
const PLACEMENT = {
  top: "top-16 right-4",
  bottom: "bottom-4 right-4",
};

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Lets the non-hook helpers in ./api (apiFetch / errorMessage) produce messages in the active locale.
  useEffect(() => {
    setApiTranslator(t);
  }, [t]);
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((x) => x.id !== id)), []);
  const push = useCallback((kind: Toast["kind"], message: string, options: ToastOptions = {}) => {
    const id = nextId++;
    setToasts((list) => [...list.slice(-3), { id, kind, message, ...options }]);
    // Notifications with a link stay longer: the user is busy elsewhere.
    setTimeout(() => dismiss(id), options.action ? 12_000 : kind === "error" ? 7000 : 4000);
  }, [dismiss]);
  const api = useMemo(() => ({ push }), [push]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      {(["top", "bottom"] as const).map((placement) => (
        <div key={placement} aria-live="polite" className={`pointer-events-none fixed z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 ${PLACEMENT[placement]}`}>
          {toasts.filter((toast) => (toast.placement ?? "bottom") === placement).map((toast) => (
            <div
              key={toast.id}
              role={toast.kind === "error" ? "alert" : "status"}
              className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg ${STYLES[toast.kind]}`}
            >
              <span aria-hidden className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-current text-[10px] font-bold">
                {ICONS[toast.kind]}
              </span>
              <span className="min-w-0 break-words">
                {toast.message}
                {toast.action && (
                  <Link href={toast.action.href} onClick={() => dismiss(toast.id)} className="mt-1 block font-medium underline underline-offset-2">
                    {toast.action.label}
                  </Link>
                )}
              </span>
              <button type="button" aria-label={t("shared.close")} className="ml-auto opacity-60 hover:opacity-100" onClick={() => dismiss(toast.id)}>
                ×
              </button>
            </div>
          ))}
        </div>
      ))}
    </ToastContext.Provider>
  );
}
