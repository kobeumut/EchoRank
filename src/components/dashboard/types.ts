// Response shapes of the REST API as consumed by the dashboard (JSON-serialized: dates are strings).

export type LatestAudit = { id: string; geoScore: number | null; seoScore: number | null; eeatScore: number | null; createdAt: string };
export type SiteSummary = {
  id: string;
  url: string;
  title: string;
  description: string | null;
  targetKeywords: unknown;
  settings: unknown;
  integrations: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  latestAudit?: LatestAudit | null;
  openActionItems?: number;
};
export type SiteList = { items: SiteSummary[]; total: number };

export type CrawlState = { id: string; status: string; pagesCrawled: number; pagesFailed: number; startedAt: string | null; finishedAt: string | null };
export type AuditRow = {
  id: string;
  status: string;
  geoScore: number | null;
  seoScore: number | null;
  eeatScore: number | null;
  summary: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  crawlSession: CrawlState | null;
  _count: { actionItems: number };
};

export type ModelStats = { cited: number; mentioned: number; none: number; total: number; visibilityRate: number; citationRate: number };
export type SiteReport = {
  site: { id: string; url: string; title: string };
  period: { days: number; since: string; until: string };
  scores: {
    geo: number | null;
    seo: number | null;
    eeat: number | null;
    metrics: unknown;
    auditedAt: string;
    delta: { geo: number | null; seo: number | null; eeat: number | null };
  } | null;
  history: { date: string; geo: number | null; seo: number | null; eeat: number | null }[];
  visibility: { totalChecks: number; citationRate: number; visibilityRate: number; perModel: Record<string, ModelStats> };
  actions: { open: number; byImpact: Record<string, number>; byCategory: Record<string, number>; byStatus: Record<string, number> };
  schedules: { id: string; frequency: string; enabled: boolean; nextRunAt: string | null }[];
};

export type Snippet = { language?: string; code?: string; filename?: string; instructions?: string };
export type ActionDetails = {
  check_id?: string;
  evidence?: string[];
  expected_gain?: number;
  affected_urls?: string[];
  affected_count?: number;
  snippet?: Snippet;
};
export type ActionItem = {
  id: string;
  title: string;
  description: string | null;
  category: string;
  impact: string;
  effort: string | null;
  ruleId: string | null;
  priority: number | null;
  details: ActionDetails | null;
  status: string;
  targetUrl: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};

export type GraphNode = { id: string; key: string; type: string; label: string; url: string | null; properties: unknown; inDegree: number; outDegree: number };
export type GraphEdge = { id: string; source: string; target: string; type: string; weight: number };
export type GraphPayload = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: { totalEntities: number; returnedEntities: number; truncated: boolean; edges: number; byType: Record<string, number>; orphanPages: number };
};

export type VisibilityRecord = {
  id: string;
  model: string;
  query: string;
  citationStatus: string;
  position: number | null;
  excerpt: string | null;
  responseMeta: unknown;
  checkedAt: string;
};
export type QuerySuggestion = {
  text: string;
  intent: "informational" | "comparative" | "transactional" | "reputation";
  language: "tr" | "en";
  branded: boolean;
  source: string;
  difficulty: { score: number; level: "low" | "medium" | "high" };
  volume: { score: number; level: "low" | "medium" | "high" };
};
export type VisibilityList = { items: VisibilityRecord[]; total: number; queries: string[]; querySuggestions?: QuerySuggestion[] };
export type VisibilityRunResult = {
  items: { query: string; model: string; cached?: boolean; error?: string; record?: VisibilityRecord }[];
  attempted: number;
  successful: number;
  failed: number;
  citationRate: number | null;
};

export type Submission = { id: string; platform: string; status: string; createdAt: string; response: unknown; urlCount: number };
export type KeyFile = { key?: string; fileName: string; fileContent: string; contentType: string; publicUrl?: string; keyLocation?: string } & Record<string, unknown>;
export type DistributionOverview = {
  settings: { enabled: boolean; autoDispatch: boolean; channels: Record<string, boolean>; syndication: { frequency: string; itemsPerPeriod: number; webhooks: unknown[] } } & Record<string, unknown>;
  readiness: {
    indexnow: { enabled: boolean; keyConfigured: boolean; keyFile: KeyFile | null };
    googleSearchConsole: { enabled: boolean; serviceAccount: boolean };
    googleIndexingApi: { enabled: boolean; serviceAccount: boolean };
    webhooks: { count: number; signed: boolean };
  };
  outputs: Record<string, { publicPath: string; api: string }>;
  queue: unknown;
  recentSubmissions: Submission[];
};

export type QueryIntent = "informational" | "comparative" | "transactional" | "reputation";
export type SentimentLabel = "positive" | "neutral" | "negative" | "unknown";
export type CompetitorSnapshot = {
  id?: string;
  competitorDomain: string;
  competitorName: string | null;
  shareOfModel: number;
  mentionShare: number | null;
  citedQueriesCount: number;
  gapQueriesCount: number;
  topCitedUrls: { url: string; count: number }[] | null;
  sentimentScore: number | null;
  samples: number;
  windowDays: number;
  lastCheckedAt: string;
};
export type CitationGap = {
  query: string;
  model: string;
  checkedAt: string;
  targetMentioned: boolean;
  targetPage: string | null;
  intent: QueryIntent;
  intentSource: "synthetic_query" | "classifier";
  competitors: { domain: string; urls: string[]; missingFactors: string[] }[];
};
export type ModelShare = { domain: string; citationShare: number | null; recommendationShare: number | null; citations: number };
export type SentimentCounts = Record<SentimentLabel, number>;
export type HallucinationFinding = {
  recordId: string;
  query: string;
  model: string;
  checkedAt: string;
  subject: string;
  text: string;
  conflictingClaim: string;
  expected: string;
  sourceUrl: string;
  verifiedAt: string;
};
export type BrandSafetySummary = {
  method: { sentiment: string | null; hallucinations: string | null };
  samples: number;
  sentiment: SentimentCounts & { averageScore: number | null };
  perModel: Record<string, SentimentCounts>;
  evidence: {
    recordId: string;
    query: string;
    model: string;
    checkedAt: string;
    label: SentimentLabel;
    score: number | null;
    quotes: { text: string; score: number; terms: { term: string; polarity: number }[] }[];
  }[];
  hallucinations: { checkedFacts: number; findingCount: number; affectedAnswers: number; items: HallucinationFinding[] };
  textCoverage: { full: number; truncated: number };
};
export type CompetitorReport = {
  refreshed: true;
  method: string;
  site: CompetitorSnapshot;
  competitors: CompetitorSnapshot[];
  citationGaps: CitationGap[];
  citationGapTotal: number;
  gapIntents: Record<QueryIntent, number>;
  perModel: Record<string, { samples: number; shares: ModelShare[] }>;
  trend: { granularity: "day" | "week"; points: { start: string; samples: number; shares: { domain: string; citationShare: number | null }[] }[] };
  brandSafety: BrandSafetySummary;
  window: { days: number; since: string; total: number; limit: number; truncated: boolean };
  settingsValid: boolean;
  warnings: string[];
};
