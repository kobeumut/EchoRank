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
export type VisibilityList = { items: VisibilityRecord[]; total: number; queries: string[] };
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
