import type { Metadata } from "next";
import { SettingsHeader, SettingsView } from "@/components/dashboard/settings-view";
import { getT } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("settings.title") };
}

export default function SettingsPage() {
  return (
    <main className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6">
      <SettingsHeader />
      <SettingsView />
    </main>
  );
}
