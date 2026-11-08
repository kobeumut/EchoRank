import { BotDiagnosticsView } from "@/components/dashboard/bot-diagnostics-view";

// SiteShell renders pages only after its client-side site fetch, so there is no static shell to validate.
export const instant = false;

export default function BotDiagnosticsPage() {
  return <BotDiagnosticsView />;
}
