"use client";

import { useEffect, useState } from "react";
import { auditProgressView } from "@/lib/dashboard/audit-progress";
import { formatDuration } from "@/lib/dashboard/format";
import type { AuditRow } from "./types";
import { Button, cx, RichText, Spinner } from "./ui";
import { useFormat } from "./use-format";

/** Current time, refreshed every `intervalMs` (null = not at all) so elapsed times tick while a job is active. */
export function useNow(intervalMs: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!intervalMs) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * Header panel for an active audit: estimated percentage, stage, elapsed time and a cancel button.
 * Says plainly when nothing is executing the audit (queued on a server without a runner).
 */
export function AuditProgressPanel({ audit, runner, canceling, onCancel }: { audit: AuditRow; runner: boolean | undefined; canceling: boolean; onCancel: () => void }) {
  const { t } = useFormat();
  const now = useNow(1000);
  const view = auditProgressView(audit, runner, now);
  const cancel = (
    <Button variant="danger" size="sm" onClick={onCancel} loading={canceling}>
      {t("sites.audit.cancel")}
    </Button>
  );

  if (view.kind === "no-runner")
    return (
      <div role="status" className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
        <p className="min-w-0 flex-1">
          <b>{t("sites.audit.noRunner.title")}</b>{" "}
          <RichText
            message={t("sites.audit.noRunner.body", { waited: formatDuration(view.waitingMs, t) })}
            slots={{ bin: <code>GEO_AUDIT_BIN</code>, path: <code>/api/sites/:id/audit/:auditId/result</code> }}
          />
        </p>
        {cancel}
      </div>
    );

  if (view.kind === "starting")
    return (
      <div role="status" className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-200">
        <p className="flex min-w-0 flex-1 items-center gap-2">
          <Spinner className="h-3 w-3" />
          <span>
            {t("sites.audit.starting", { waited: formatDuration(view.waitingMs, t) })}
            {view.stuck && ` ${t("sites.audit.stuck")}`}
          </span>
        </p>
        {cancel}
      </div>
    );

  return (
    <div className="mt-3 rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-200">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-1 font-medium">
          {t(view.labelKey)}
          {view.pages && <span className="font-normal"> · {t("sites.audit.pages", view.pages)}</span>}
        </p>
        <span className="tabular-nums">
          {view.percent != null && <b title={t("sites.audit.estimateTitle")}>~{t("shared.percent", { value: view.percent })}</b>}
          {view.percent != null && " · "}
          {formatDuration(view.elapsedMs, t)}
        </span>
        {cancel}
      </div>
      <div
        role="progressbar"
        aria-label={t("sites.audit.progressLabel")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={view.percent ?? undefined}
        aria-valuetext={view.percent != null ? t("sites.audit.progressText", { percent: view.percent }) : t("sites.audit.progressUnknown")}
        className="mt-2 h-2 overflow-hidden rounded-full bg-indigo-100 dark:bg-indigo-900/50"
      >
        <div
          className={cx("h-full rounded-full bg-indigo-600 dark:bg-indigo-400", view.percent != null ? "transition-[width] duration-500" : "w-1/3 animate-pulse")}
          style={view.percent != null ? { width: `${view.percent}%` } : undefined}
        />
      </div>
    </div>
  );
}
