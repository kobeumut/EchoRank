// Schema.org JSON-LD @graph from the stored knowledge graph + a strict validator.
// TypeScript twin of services/crawler/src/geo_crawler/jsonld.py — keep the node shapes and rules in sync.
//
// Every node has a stable @id and references others by { "@id" } only: WebSite → publisher → Organization,
// Article → author → Person → knowsAbout → Thing, Product → brand → Brand, Offer → seller → Organization.
// Nodes that would fail Google's rich-result rules are left out (e.g. a Product without offers or rating).

export type GraphNode = {
  key: string;
  type: string;
  name: string;
  url?: string | null;
  properties: Record<string, unknown>;
  sourceUrls?: string[];
};
export type GraphEdge = { source: string; target: string; type: string; properties?: Record<string, unknown> | null };
type Json = Record<string, unknown>;

export const SCHEMA_CONTEXT = "https://schema.org";
export const HEADLINE_MAX = 110;
const AVAILABILITY: Record<string, string> = {
  in_stock: "InStock", out_of_stock: "OutOfStock", pre_order: "PreOrder", back_order: "BackOrder",
  discontinued: "Discontinued", limited: "LimitedAvailability",
};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const HTTP = /^https?:\/\//;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const slug = (key: string) => key.split(":").slice(1).join(":") || key;
const date = (v: unknown) => (typeof v === "string" && ISO_DATE.test(v) ? v : undefined);
const httpList = (v: unknown) =>
  [...new Set((Array.isArray(v) ? v : []).filter((u): u is string => typeof u === "string" && HTTP.test(u)))];

function price(v: unknown): string | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : undefined;
}

function absolute(url: unknown, base: string): string | undefined {
  const s = str(url);
  if (!s) return undefined;
  try {
    const u = new URL(s, base).toString();
    return HTTP.test(u) ? u : undefined;
  } catch {
    return undefined;
  }
}

/** Drops undefined / null / "" / [] / {} recursively (empty properties are Rich Results warnings). */
function clean<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clean).filter((v) => !isEmpty(v)) as T;
  if (value && typeof value === "object") {
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) {
      const c = clean(v);
      if (!isEmpty(c)) out[k] = c;
    }
    return out as T;
  }
  return value;
}
const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

const host = (url: unknown) => {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

export function buildJsonLd(site: { url: string; title?: string | null }, nodes: GraphNode[], edges: GraphEdge[]) {
  const base = new URL(site.url).origin + "/";
  const siteHost = host(base);
  const byKey = new Map(nodes.filter((n) => !n.properties.placeholder).map((n) => [n.key, n]));
  const out = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    if (!byKey.has(e.source) || !byKey.has(e.target)) continue;
    out.set(e.source, [...(out.get(e.source) ?? []), e]);
    incoming.set(e.target, [...(incoming.get(e.target) ?? []), e]);
  }
  const outTo = (k: string, type: string) => (out.get(k) ?? []).filter((e) => e.type === type).map((e) => e.target);
  const inFrom = (k: string, type: string) => (incoming.get(k) ?? []).filter((e) => e.type === type).map((e) => e.source);
  const ofType = (t: string) => [...byKey.values()].filter((n) => n.type === t);

  const orgs = ofType("Organization");
  const primary = orgs
    .map((n) => ({
      n,
      rank: [host(n.properties.url ?? n.url) === siteHost ? 0 : 1, -inFrom(n.key, "published_by").length, -(n.sourceUrls?.length ?? 0)],
    }))
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2])[0]?.n;

  const ids = new Map<string, string>();
  const id = (n: GraphNode) => {
    let i = ids.get(n.key);
    if (i) return i;
    if (n.key === primary?.key) i = `${base}#organization`;
    else if (n.type === "Product") i = `${absolute(n.properties.url ?? n.url, base) ?? base}#product-${slug(n.key)}`;
    else if (n.type === "Page") i = `${absolute(n.properties.url ?? n.url, base) ?? base}#article`;
    else i = `${base}#/schema/${n.type.toLowerCase()}/${slug(n.key)}`;
    ids.set(n.key, i);
    return i;
  };
  const ref = (n?: GraphNode) => (n ? { "@id": id(n) } : undefined);
  const sameAs = (n: GraphNode) => httpList(n.properties.sameAs ?? n.properties.same_as);
  const reconciledThings = (keys: string[], limit = 10) =>
    [...new Set(keys)].map((k) => byKey.get(k)).filter((n): n is GraphNode => !!n && n.type === "Concept" && !!str(n.properties.wikidataId)).slice(0, limit);
  const wdThings = (n: GraphNode, prop: string, type: string, extra: Json = {}) =>
    (Array.isArray(n.properties[prop]) ? (n.properties[prop] as Json[]) : [])
      .filter((x) => x && typeof x === "object" && str(x.name))
      .map((x) => ({ "@type": type, name: x.name, ...extra, sameAs: str(x.wikidataId) ? `https://www.wikidata.org/wiki/${x.wikidataId}` : undefined }));

  const graph: Json[] = [];
  const emitted = new Set<string>();
  const emit = (n: GraphNode, node: Json | null) => {
    if (!node) return;
    graph.push(node);
    emitted.add(n.key);
  };

  for (const n of orgs) {
    const p = n.properties;
    const isPrimary = n.key === primary?.key;
    const logo = absolute(p.logo, base);
    emit(n, {
      "@type": "Organization", "@id": id(n), name: n.name,
      url: absolute(p.url ?? n.url, base) ?? (isPrimary ? base : undefined),
      logo: logo ? { "@type": "ImageObject", ...(isPrimary ? { "@id": `${base}#logo` } : {}), url: logo } : undefined,
      telephone: str(p.telephone), address: str(p.address), sameAs: sameAs(n),
    });
  }
  for (const n of ofType("Person")) {
    const p = n.properties;
    const topics = reconciledThings(inFrom(n.key, "written_by").flatMap((a) => outTo(a, "mentions_entity")));
    const employers = Array.isArray(p.employerWikidataIds) ? p.employerWikidataIds : [];
    const worksFor = primary && employers.includes(primary.properties.wikidataId) ? primary : undefined;
    emit(n, {
      "@type": "Person", "@id": id(n), name: n.name, url: absolute(p.url, base), jobTitle: str(p.job_title),
      sameAs: sameAs(n),
      knowsAbout: [...topics.map(ref), ...wdThings(n, "knowsAbout", "Thing")],
      alumniOf: wdThings(n, "alumniOf", "EducationalOrganization"),
      hasCredential: wdThings(n, "hasCredential", "EducationalOccupationalCredential", { credentialCategory: "degree" }),
      worksFor: ref(worksFor),
    });
  }

  const offer = (n: GraphNode): Json | undefined => {
    const url = absolute(n.properties.url ?? n.url, base) ?? base;
    const offers = outTo(n.key, "has_offer").map((k) => byKey.get(k)!).filter(Boolean);
    for (const o of offers.length ? offers : [n]) {
      const op = o.properties;
      const amount = price(op.price);
      const currency = String(op.currency ?? "").toUpperCase();
      if (!amount || !/^[A-Z]{3}$/.test(currency)) continue;
      const av = AVAILABILITY[String(op.availability ?? "")];
      const availability = av ? `https://schema.org/${av}` : undefined;
      const high = price(op.high_price);
      if (high && Number(high) > Number(amount)) {
        return { "@type": "AggregateOffer", lowPrice: amount, highPrice: high, priceCurrency: currency, availability, url };
      }
      return { "@type": "Offer", price: amount, priceCurrency: currency, url, seller: ref(primary), availability };
    }
    return undefined;
  };
  const products = ofType("Product").map((n) => {
    const p = n.properties;
    const o = offer(n);
    const reviews = Number(p.review_count);
    const rating = Number(p.rating) && reviews > 0
      ? { "@type": "AggregateRating", ratingValue: Number(p.rating), reviewCount: Math.trunc(reviews) }
      : undefined;
    if (!o && !rating) return { n, node: null };
    const brand = byKey.get(outTo(n.key, "has_brand")[0] ?? "");
    const category = byKey.get(outTo(n.key, "has_category")[0] ?? "");
    const url = absolute(p.url ?? n.url, base);
    return {
      n,
      brand,
      node: {
        "@type": "Product", "@id": id(n), name: n.name, url, sku: str(p.sku), description: str(p.description),
        image: absolute(p.image, url ?? base), brand: ref(brand), category: category?.name,
        offers: o, aggregateRating: rating, sameAs: sameAs(n),
      } as Json,
    };
  });
  const usedBrands = new Set(products.filter((x) => x.node && x.brand).map((x) => x.brand!.key));
  for (const n of ofType("Brand")) {
    if (usedBrands.has(n.key) || str(n.properties.wikidataId)) {
      emit(n, { "@type": "Brand", "@id": id(n), name: n.name, sameAs: sameAs(n) });
    }
  }
  for (const { n, node } of products) emit(n, node);
  for (const n of ofType("Concept")) {
    if (str(n.properties.wikidataId)) emit(n, { "@type": "Thing", "@id": id(n), name: n.name, sameAs: sameAs(n) });
  }
  for (const n of ofType("Page")) {
    const p = n.properties;
    if (p.page_type !== "article") continue;
    let headline = str(p.headline) ?? str(p.h1) ?? str(p.title) ?? "";
    const authors = outTo(n.key, "written_by").filter((k) => emitted.has(k)).map((k) => byKey.get(k)!);
    if (!headline || !authors.length) continue;
    if (headline.length > HEADLINE_MAX) headline = headline.slice(0, HEADLINE_MAX - 1).trimEnd() + "…";
    const publisher = byKey.get(outTo(n.key, "published_by").find((k) => emitted.has(k)) ?? "") ?? primary;
    const mentions = outTo(n.key, "mentions_entity");
    const url = absolute(p.url ?? n.url, base);
    emit(n, {
      "@type": "Article", "@id": id(n), headline, url, mainEntityOfPage: url, inLanguage: str(p.lang),
      datePublished: date(p.date_published), dateModified: date(p.date_modified),
      author: authors.map(ref), publisher: ref(publisher), isPartOf: { "@id": `${base}#website` },
      about: reconciledThings(mentions).map(ref),
      mentions: mentions.filter((k) => emitted.has(k) && byKey.get(k)?.type === "Product").map((k) => ref(byKey.get(k))),
      description: str(p.description),
    });
  }
  const home = ofType("Page").find((n) => n.properties.page_type === "home");
  graph.unshift({
    "@type": "WebSite", "@id": `${base}#website`, url: base,
    name: primary?.name ?? str(home?.properties.title) ?? str(site.title) ?? siteHost,
    inLanguage: str(home?.properties.lang), publisher: ref(primary),
  });
  return clean({ "@context": SCHEMA_CONTEXT, "@graph": graph });
}

// ---------------------------------------------------------------- validation

const REQUIRED: Record<string, string[]> = {
  WebSite: ["url", "name"],
  Organization: ["name"],
  Person: ["name"],
  Brand: ["name"],
  Thing: ["name"],
  Product: ["name"],
  Offer: ["price", "priceCurrency"],
  AggregateOffer: ["lowPrice", "priceCurrency"],
  AggregateRating: ["ratingValue"],
  Article: ["headline", "author"],
  ImageObject: ["url"],
  EducationalOrganization: ["name"],
  EducationalOccupationalCredential: ["name"],
};
const URL_KEYS = new Set(["url", "sameAs", "mainEntityOfPage", "image", "availability"]);

/** Schema.org + Google rich-result rules; returns problems (empty array = valid). */
export function validateJsonLd(doc: unknown): string[] {
  const errors: string[] = [];
  const d = doc as Json;
  if (d?.["@context"] !== SCHEMA_CONTEXT) errors.push("@context must be https://schema.org");
  const graph = d?.["@graph"];
  if (!Array.isArray(graph) || graph.length === 0) return [...errors, "@graph must be a non-empty array"];
  const nodes = new Map<string, Json>();
  graph.forEach((node: Json, i) => {
    const nid = node?.["@id"];
    if (typeof nid !== "string" || !nid) return void errors.push(`@graph[${i}] has no @id`);
    if (nodes.has(nid)) errors.push(`duplicate @id ${nid}`);
    nodes.set(nid, node);
  });
  const isRef = (o: unknown): o is { "@id": string } =>
    !!o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === 1 && "@id" in o;

  const check = (obj: unknown, path: string): void => {
    if (Array.isArray(obj)) {
      if (!obj.length) errors.push(`${path}: empty array`);
      obj.forEach((v, j) => check(v, `${path}[${j}]`));
      return;
    }
    if (!obj || typeof obj !== "object") {
      if (obj === null || obj === undefined || obj === "") errors.push(`${path}: empty value`);
      return;
    }
    if (isRef(obj)) {
      if (!nodes.has(obj["@id"])) errors.push(`${path}: dangling reference ${obj["@id"]}`);
      return;
    }
    const o = obj as Json;
    const t = String(o["@type"] ?? "");
    if (!t) errors.push(`${path}: missing @type`);
    for (const key of REQUIRED[t] ?? []) if (isEmpty(o[key])) errors.push(`${path}: ${t} requires '${key}'`);
    if (t === "Product" && !["offers", "aggregateRating", "review"].some((k) => o[k])) {
      errors.push(`${path}: Product requires offers, review or aggregateRating`);
    }
    if (t === "Offer" || t === "AggregateOffer") {
      if (!/^[A-Z]{3}$/.test(String(o.priceCurrency ?? ""))) errors.push(`${path}: priceCurrency must be ISO 4217`);
      for (const k of ["price", "lowPrice", "highPrice"]) {
        if (k in o && !/^\d+(\.\d+)?$/.test(String(o[k]))) errors.push(`${path}: ${k} must be a plain number`);
      }
      if (o.availability && !String(o.availability).startsWith("https://schema.org/")) {
        errors.push(`${path}: availability must be a schema.org ItemAvailability URL`);
      }
    }
    if (t === "AggregateRating" && !(o.reviewCount || o.ratingCount)) {
      errors.push(`${path}: AggregateRating requires reviewCount or ratingCount`);
    }
    if (t === "Article") {
      if (String(o.headline ?? "").length > HEADLINE_MAX) errors.push(`${path}: headline longer than ${HEADLINE_MAX} characters`);
      for (const k of ["datePublished", "dateModified"]) {
        if (k in o && !ISO_DATE.test(String(o[k]))) errors.push(`${path}: ${k} must be ISO 8601`);
      }
      for (const a of Array.isArray(o.author) ? o.author : [o.author]) {
        const target = isRef(a) ? nodes.get(a["@id"]) : (a as Json);
        if (!target || !["Person", "Organization"].includes(String(target["@type"])) || !target.name) {
          errors.push(`${path}: author must be a named Person or Organization`);
        }
      }
    }
    for (const [k, v] of Object.entries(o)) {
      if (URL_KEYS.has(k)) {
        for (const u of Array.isArray(v) ? v : [v]) {
          if (typeof u === "string" && !HTTP.test(u)) errors.push(`${path}.${k}: '${u}' is not an absolute URL`);
        }
      }
      if (k === "sameAs" && Array.isArray(v) && new Set(v).size !== v.length) errors.push(`${path}.sameAs: duplicate URLs`);
      if (!["@type", "@id", "@context"].includes(k)) check(v, `${path}.${k}`);
    }
  };
  graph.forEach((node, i) => check(node, `@graph[${i}]`));
  return errors;
}
