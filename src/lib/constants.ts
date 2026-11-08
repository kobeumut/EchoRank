// Enum-like domain values. Stored as String columns (portable between SQLite
// and PostgreSQL) and validated at the API boundary with zod.

export const CRAWL_STATUSES = ["queued", "running", "completed", "failed", "cancelled"] as const;
export const AUDIT_STATUSES = ["pending", "running", "completed", "failed"] as const;
export const CRAWL_TRIGGERS = ["manual", "scheduled", "api"] as const;

export const ENTITY_TYPES = [
  "Page",
  "Product",
  "Category",
  "FAQ",
  "Organization",
  "Author",
  "Brand",
  "Article",
  "Concept",
] as const;

export const RELATION_TYPES = [
  "links_to",
  "has_category",
  "contains_product",
  "written_by",
  "mentions_entity",
  "answers_question",
  "same_as",
  "part_of",
] as const;

export const LLM_MODELS = ["chatgpt", "gemini", "claude", "perplexity", "copilot", "other"] as const;
export const CITATION_STATUSES = ["cited", "mentioned", "none"] as const;

export const ACTION_CATEGORIES = ["crawler", "schema", "content", "authority", "technical"] as const;
export const ACTION_IMPACTS = ["high", "medium", "low"] as const;
export const ACTION_EFFORTS = ["high", "medium", "low"] as const;
export const ACTION_STATUSES = ["open", "in_progress", "resolved", "dismissed"] as const;

export const REPORT_FREQUENCIES = ["daily", "weekly"] as const;
export const SUBMISSION_STATUSES = ["queued", "sent", "failed"] as const;

export type CrawlStatus = (typeof CRAWL_STATUSES)[number];
export type AuditStatus = (typeof AUDIT_STATUSES)[number];
export type EntityType = (typeof ENTITY_TYPES)[number];
export type RelationType = (typeof RELATION_TYPES)[number];
export type LlmModel = (typeof LLM_MODELS)[number];
export type CitationStatus = (typeof CITATION_STATUSES)[number];
export type ActionCategory = (typeof ACTION_CATEGORIES)[number];
export type ActionImpact = (typeof ACTION_IMPACTS)[number];
export type ActionEffort = (typeof ACTION_EFFORTS)[number];
export type ActionStatus = (typeof ACTION_STATUSES)[number];
export type ReportFrequency = (typeof REPORT_FREQUENCIES)[number];

// ---- AI distribution (GENE-97) ----
/** Per-URL notification channels. Google Search Console sitemap submits are site-level, not queued per URL. */
export const QUEUE_CHANNELS = ["indexnow", "google_indexing"] as const;
export const QUEUE_STATUSES = ["pending", "processing", "sent", "failed", "skipped"] as const;
export const CHANGE_REASONS = ["created", "updated", "deleted"] as const;
/** PlatformSubmission.platform values written by the distribution engine. */
export const SUBMISSION_PLATFORMS = ["indexnow", "google_indexing", "google_search_console", "webhook"] as const;
export const SYNDICATION_FREQUENCIES = ["daily", "weekly"] as const;

export type QueueChannel = (typeof QUEUE_CHANNELS)[number];
export type QueueStatus = (typeof QUEUE_STATUSES)[number];
export type ChangeReason = (typeof CHANGE_REASONS)[number];
export type SubmissionPlatform = (typeof SUBMISSION_PLATFORMS)[number];
