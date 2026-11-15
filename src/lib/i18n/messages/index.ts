// Aggregates the per-namespace catalogs. Keys are globally unique, dotted and prefixed by namespace
// (e.g. "actions.empty.title"). English is the source of truth: `MessageKey` is derived from it and
// tests/i18n.test.ts verifies that every other locale defines the same keys and {placeholders}.

import type { Locale } from "../config";
import { common as en_common } from "./en/common";
import { labels as en_labels } from "./en/labels";
import { auth as en_auth } from "./en/auth";
import { sites as en_sites } from "./en/sites";
import { overview as en_overview } from "./en/overview";
import { actions as en_actions } from "./en/actions";
import { visibility as en_visibility } from "./en/visibility";
import { distribution as en_distribution } from "./en/distribution";
import { shared as en_shared } from "./en/shared";
import { competitors as en_competitors } from "./en/competitors";
import { graph as en_graph } from "./en/graph";
import { entities as en_entities } from "./en/entities";
import { studio as en_studio } from "./en/studio";
import { bots as en_bots } from "./en/bots";
import { services as en_services } from "./en/services";
import { botsim as en_botsim } from "./en/botsim";
import { autogeo as en_autogeo } from "./en/autogeo";
import { queries as en_queries } from "./en/queries";
import { reports as en_reports } from "./en/reports";
import { api as en_api } from "./en/api";
import { common as tr_common } from "./tr/common";
import { labels as tr_labels } from "./tr/labels";
import { auth as tr_auth } from "./tr/auth";
import { sites as tr_sites } from "./tr/sites";
import { overview as tr_overview } from "./tr/overview";
import { actions as tr_actions } from "./tr/actions";
import { visibility as tr_visibility } from "./tr/visibility";
import { distribution as tr_distribution } from "./tr/distribution";
import { shared as tr_shared } from "./tr/shared";
import { competitors as tr_competitors } from "./tr/competitors";
import { graph as tr_graph } from "./tr/graph";
import { entities as tr_entities } from "./tr/entities";
import { studio as tr_studio } from "./tr/studio";
import { bots as tr_bots } from "./tr/bots";
import { services as tr_services } from "./tr/services";
import { botsim as tr_botsim } from "./tr/botsim";
import { autogeo as tr_autogeo } from "./tr/autogeo";
import { queries as tr_queries } from "./tr/queries";
import { reports as tr_reports } from "./tr/reports";
import { api as tr_api } from "./tr/api";

export const en = {
  ...en_common,
  ...en_labels,
  ...en_auth,
  ...en_sites,
  ...en_overview,
  ...en_actions,
  ...en_visibility,
  ...en_distribution,
  ...en_shared,
  ...en_competitors,
  ...en_graph,
  ...en_entities,
  ...en_studio,
  ...en_bots,
  ...en_services,
  ...en_botsim,
  ...en_autogeo,
  ...en_queries,
  ...en_reports,
  ...en_api,
} as const;

const tr = {
  ...tr_common,
  ...tr_labels,
  ...tr_auth,
  ...tr_sites,
  ...tr_overview,
  ...tr_actions,
  ...tr_visibility,
  ...tr_distribution,
  ...tr_shared,
  ...tr_competitors,
  ...tr_graph,
  ...tr_entities,
  ...tr_studio,
  ...tr_bots,
  ...tr_services,
  ...tr_botsim,
  ...tr_autogeo,
  ...tr_queries,
  ...tr_reports,
  ...tr_api,
};

export type MessageKey = keyof typeof en;

/** All catalogs by locale. Add a language by creating `tr`-style files and registering it here + in config.ts. */
export const catalogs: Record<Locale, Record<string, string>> = { en, tr };

/** Messages for `locale`, with English filled in for anything the locale does not define. */
export function getMessages(locale: Locale): Record<string, string> {
  return locale === "en" ? en : { ...en, ...catalogs[locale] };
}
