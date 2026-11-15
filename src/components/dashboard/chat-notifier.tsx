"use client";

import { useEffect } from "react";
import { useT } from "@/lib/i18n/provider";
import { isViewingChat, onChatCompleted } from "./chat-store";
import { useToast } from "./toast";

/** Announces site-assistant answers that arrive while the user is on another page (top-right, with a link back). */
export function ChatNotifier() {
  const toast = useToast();
  const t = useT();
  useEffect(
    () =>
      onChatCompleted(({ siteId, siteTitle, ok }) => {
        if (isViewingChat(siteId)) return;
        toast.push(ok ? "success" : "error", t(ok ? "chat.notify.done" : "chat.notify.failed", { site: siteTitle }), {
          placement: "top",
          action: { href: `/sites/${siteId}/chat`, label: t(ok ? "chat.notify.view" : "chat.notify.open") },
        });
      }),
    [toast, t],
  );
  return null;
}
