// Aggregates the per-namespace catalogs from the single source of truth in /locales/{en,tr}.
// Keys are globally unique, dotted and prefixed by namespace (e.g. "actions.empty.title").
// English is the source of truth: `MessageKey` is derived from it and compile-time types +
// tests/i18n.test.ts verify that every other locale defines the same keys and {placeholders}.

import type { Locale } from "../config";

import en_access from "@locales/en/access.json";
import en_actions from "@locales/en/actions.json";
import en_api from "@locales/en/api.json";
import en_auth from "@locales/en/auth.json";
import en_autogeo from "@locales/en/autogeo.json";
import en_bot_simulator from "@locales/en/bot_simulator.json";
import en_bots from "@locales/en/bots.json";
import en_botsim from "@locales/en/botsim.json";
import en_common from "@locales/en/common.json";
import en_competitors from "@locales/en/competitors.json";
import en_distribution from "@locales/en/distribution.json";
import en_eeat from "@locales/en/eeat.json";
import en_engine from "@locales/en/engine.json";
import en_entities from "@locales/en/entities.json";
import en_graph from "@locales/en/graph.json";
import en_labels from "@locales/en/labels.json";
import en_misc from "@locales/en/misc.json";
import en_overview from "@locales/en/overview.json";
import en_queries from "@locales/en/queries.json";
import en_readability from "@locales/en/readability.json";
import en_reports from "@locales/en/reports.json";
import en_schema_rules from "@locales/en/schema_rules.json";
import en_seo from "@locales/en/seo.json";
import en_services from "@locales/en/services.json";
import en_shared from "@locales/en/shared.json";
import en_signals from "@locales/en/signals.json";
import en_sites from "@locales/en/sites.json";
import en_snippets from "@locales/en/snippets.json";
import en_studio from "@locales/en/studio.json";
import en_visibility from "@locales/en/visibility.json";

import tr_access from "@locales/tr/access.json";
import tr_actions from "@locales/tr/actions.json";
import tr_api from "@locales/tr/api.json";
import tr_auth from "@locales/tr/auth.json";
import tr_autogeo from "@locales/tr/autogeo.json";
import tr_bot_simulator from "@locales/tr/bot_simulator.json";
import tr_bots from "@locales/tr/bots.json";
import tr_botsim from "@locales/tr/botsim.json";
import tr_common from "@locales/tr/common.json";
import tr_competitors from "@locales/tr/competitors.json";
import tr_distribution from "@locales/tr/distribution.json";
import tr_eeat from "@locales/tr/eeat.json";
import tr_engine from "@locales/tr/engine.json";
import tr_entities from "@locales/tr/entities.json";
import tr_graph from "@locales/tr/graph.json";
import tr_labels from "@locales/tr/labels.json";
import tr_misc from "@locales/tr/misc.json";
import tr_overview from "@locales/tr/overview.json";
import tr_queries from "@locales/tr/queries.json";
import tr_readability from "@locales/tr/readability.json";
import tr_reports from "@locales/tr/reports.json";
import tr_schema_rules from "@locales/tr/schema_rules.json";
import tr_seo from "@locales/tr/seo.json";
import tr_services from "@locales/tr/services.json";
import tr_shared from "@locales/tr/shared.json";
import tr_signals from "@locales/tr/signals.json";
import tr_sites from "@locales/tr/sites.json";
import tr_snippets from "@locales/tr/snippets.json";
import tr_studio from "@locales/tr/studio.json";
import tr_visibility from "@locales/tr/visibility.json";

export const en = {
  ...en_access,
  ...en_actions,
  ...en_api,
  ...en_auth,
  ...en_autogeo,
  ...en_bot_simulator,
  ...en_bots,
  ...en_botsim,
  ...en_common,
  ...en_competitors,
  ...en_distribution,
  ...en_eeat,
  ...en_engine,
  ...en_entities,
  ...en_graph,
  ...en_labels,
  ...en_misc,
  ...en_overview,
  ...en_queries,
  ...en_readability,
  ...en_reports,
  ...en_schema_rules,
  ...en_seo,
  ...en_services,
  ...en_shared,
  ...en_signals,
  ...en_sites,
  ...en_snippets,
  ...en_studio,
  ...en_visibility,
} as const;

export const tr: Record<keyof typeof en, string> = {
  ...tr_access,
  ...tr_actions,
  ...tr_api,
  ...tr_auth,
  ...tr_autogeo,
  ...tr_bot_simulator,
  ...tr_bots,
  ...tr_botsim,
  ...tr_common,
  ...tr_competitors,
  ...tr_distribution,
  ...tr_eeat,
  ...tr_engine,
  ...tr_entities,
  ...tr_graph,
  ...tr_labels,
  ...tr_misc,
  ...tr_overview,
  ...tr_queries,
  ...tr_readability,
  ...tr_reports,
  ...tr_schema_rules,
  ...tr_seo,
  ...tr_services,
  ...tr_shared,
  ...tr_signals,
  ...tr_sites,
  ...tr_snippets,
  ...tr_studio,
  ...tr_visibility,
};

export type MessageKey = keyof typeof en;

/** All catalogs by locale. */
export const catalogs: Record<Locale, Record<string, string>> = { en, tr };

/** Messages for `locale`, with English filled in for anything the locale does not define. */
export function getMessages(locale: Locale): Record<string, string> {
  return locale === "en" ? en : { ...en, ...catalogs[locale] };
}
