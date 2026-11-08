import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import { AppHeader, AppHeaderFallback } from "@/components/dashboard/app-header";
import { ToastProvider } from "@/components/dashboard/toast";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin", "latin-ext"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin", "latin-ext"],
});

export const metadata: Metadata = {
  title: { default: "AI Visibility — GEO & SEO", template: "%s · AI Visibility" },
  description: "Yapay zeka arama motorlarında görünürlük, GEO & SEO ve Bilgi Güvenilirliği paneli",
};

// Applies the stored / system theme before first paint (no flash).
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("theme");var d=t?t==="dark":matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",d)}catch(e){}})()`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="tr" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col">
        <ToastProvider>
          <Suspense fallback={<AppHeaderFallback />}>
            <AppHeader />
          </Suspense>
          <div className="flex-1">{children}</div>
          <footer className="border-t border-zinc-200 px-6 py-4 text-center text-xs text-zinc-500 dark:border-zinc-800">
            AI Visibility · GEO &amp; SEO Platformu · © Umut ADALI — CC BY-NC-SA 4.0
          </footer>
        </ToastProvider>
      </body>
    </html>
  );
}
