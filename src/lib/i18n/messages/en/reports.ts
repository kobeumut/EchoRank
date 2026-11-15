// Namespace "reports" — English (source of truth; every key must also exist in ../tr/reports.ts).
// Text of the scheduled visibility reports (snapshot summary/alerts, e-mail/HTML/PDF sections, job-step details).
// A report is generated in one locale (the site's `settings.locale`, default English) and stored in that language.
export const reports = {
  // --- shared words ---
  "reports.score.notMeasured": "Not measured",
  "reports.none": "none",
  "reports.status.ok": "ok",
  "reports.status.failed": "failed",
  "reports.status.skipped": "skipped",

  // --- snapshot: summary, alerts, caveats ---
  "reports.summary.insufficient": "Insufficient comparable observations to calculate AI visibility change.",
  "reports.summary.increased": "AI citation visibility increased by {points} percentage points ({previous}% to {current}%) on {pairs} matched model/query pairs.",
  "reports.summary.decreased": "AI citation visibility decreased by {points} percentage points ({previous}% to {current}%) on {pairs} matched model/query pairs.",
  "reports.alert.geoDrop": "GEO score dropped {points} points since the pre-period audit.",
  "reports.alert.eeatDrop": "E-E-A-T proxy dropped {points} points.",
  "reports.alert.citationDrop": "Citation rate dropped {points} percentage points on {pairs} matched model/query pairs.",
  "reports.alert.candidateRise": "Other-source candidate {domain} rose {points} percentage points (not a verified competitor).",
  "reports.caveats": "Citation evidence is provider-reported; E-E-A-T is a rule-based trust proxy, not factual verification. Other-source domains are only competitor candidates. Comparisons require matching model/query pairs; provider model/configuration changes can still affect results. Scores are not carried forward when no audit ran in the period. Action lists show at most 100 items per section.",

  // --- report sections (HTML, PDF, e-mail) ---
  "reports.section.summary": "Executive summary",
  "reports.section.scores": "Scores & evidence",
  "reports.section.trend": "Daily trend (UTC)",
  "reports.section.alerts": "Anomaly alerts",
  "reports.section.pending": "Pending critical actions ({count})",
  "reports.section.resolved": "Resolved critical actions ({count})",
  "reports.section.job": "Job execution",
  "reports.section.method": "Method & limitations",
  "reports.scores.line": "GEO {geo} / SEO {seo} / E-E-A-T proxy {eeat}",
  "reports.scores.changes": "Score changes: GEO {geo}, SEO {seo}, E-E-A-T {eeat} points. Audit: {audit}; baseline: {baseline}.",
  "reports.citations.line": "Citations: {citations}/{checks} checks; previous period {previousCitations}/{previousChecks}. Citation rate: {rate}.",
  "reports.trend.row": "{date} | GEO {geo} | E-E-A-T {eeat} | citations {citations}/{checks}",
  "reports.trend.empty": "No observations in this period.",
  "reports.alerts.empty": "No alert threshold exceeded (or insufficient evidence).",
  "reports.actions.none": "None.",
  "reports.actions.noneResolved": "None resolved in this period.",
  "reports.job.empty": "On-demand report; no checks triggered.",

  // --- HTML / PDF / e-mail chrome ---
  "reports.html.title": "{site} — visibility report",
  "reports.html.brief.weekly": "AI VISIBILITY / WEEKLY BRIEF",
  "reports.html.brief.daily": "AI VISIBILITY / DAILY BRIEF",
  "reports.html.footer": "Generated from recorded observations. Missing measurements are not zero scores.",
  "reports.pdf.title": "AI VISIBILITY / EXECUTIVE BRIEF",
  "reports.email.subject": "AI visibility: {site}",

  // --- scheduler job-step details (shown under "Job execution") ---
  "reports.step.auditNoRunner": "Configure GEO_AUDIT_BIN; no crawl was queued",
  "reports.step.auditDone": "Completed audit {id}: crawl, knowledge graph and E-E-A-T scoring",
  "reports.step.failed": "Check failed; verify configuration and service availability",
  "reports.step.providerCoverage": "{successful}/{attempted} checks succeeded; missing or failed providers were not recorded as zero scores",
  "reports.step.visibilityDone": "{successful}/{attempted} fresh checks succeeded (cache bypassed)",
  "reports.step.indexnowNoKey": "No valid IndexNow key configured",
  "reports.step.indexnowVerified": "Published key matches; this is not proof of indexing or search inclusion",
  "reports.step.indexnowQueue": "{sent}/{claimed} queued notifications submitted; not proof of indexing",
  "reports.step.reportFailed": "Report generation failed; no automatic delivery retry",
} satisfies Record<string, string>;
