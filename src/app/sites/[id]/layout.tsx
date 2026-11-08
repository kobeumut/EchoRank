import { Suspense } from "react";
import { SiteShell, SiteShellSkeleton } from "@/components/dashboard/site-shell";

export default function SiteLayout({ children }: LayoutProps<"/sites/[id]">) {
  return (
    <Suspense fallback={<SiteShellSkeleton />}>
      <SiteShell>{children}</SiteShell>
    </Suspense>
  );
}
