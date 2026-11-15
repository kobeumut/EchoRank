import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import { AppHeader, AppHeaderFallback } from "@/components/dashboard/app-header";
import { ToastProvider } from "@/components/dashboard/toast";
import { I18nProvider } from "@/lib/i18n/provider";
import { getLocale, getT } from "@/lib/i18n/server";
import { getMessages } from "@/lib/i18n/messages";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin", "latin-ext"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin", "latin-ext"],
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    title: { default: "AI Visibility — GEO & SEO", template: "%s · AI Visibility" },
    description: t("common.meta.description"),
  };
}

// Applies the stored / system theme before first paint (no flash).
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("theme");var d=t?t==="dark":matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",d)}catch(e){}})()`;

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();
  const t = await getT(locale);
  return (
    <html lang={locale} suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col">
        <I18nProvider locale={locale} messages={getMessages(locale)}>
          <ToastProvider>
            <Suspense fallback={<AppHeaderFallback />}>
              <AppHeader />
            </Suspense>
            <div className="flex-1">{children}</div>
            <footer className="border-t border-zinc-200 px-6 py-4 text-center text-xs text-zinc-500 dark:border-zinc-800">
              {t("common.footer")}
            </footer>
          </ToastProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
