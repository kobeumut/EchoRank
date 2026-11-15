// Namespace "autogeo" — English (source of truth; every key must also exist in ../tr/autogeo.ts).
// Text written by the AutoGEO integration itself (src/lib/services/autogeo.ts, autogeo-suggestions.ts): metric labels,
// ActionItem titles / descriptions and the instructions shown with the copy-paste diffs.
export const autogeo = {
  // ------------------------------------------------------------ metrics: label + how to apply the suggested patch
  "autogeo.metric.statistics.label": "Statistics and numeric data",
  "autogeo.metric.statistics.instructions": "Fill in the bracketed placeholders ([NUMBER], [X]% …) with verified figures and their sources.",
  "autogeo.metric.quotations.label": "Expert quotations",
  "autogeo.metric.quotations.instructions": "Use a direct quotation from a real, consenting expert with a title; include their name, title and organisation.",
  "autogeo.metric.citations.label": "Authoritative source citations",
  "autogeo.metric.citations.instructions": "Replace the placeholder links with the URLs of .gov/.edu sources, DOIs or well-known industry reports.",
  "autogeo.metric.answer_capsules.label": "Answer capsules (40-60 words)",
  "autogeo.metric.answer_capsules.instructions": "Place the paragraph right below the heading; keep it 40-60 words and understandable on its own.",
  "autogeo.metric.authority_fluency.label": "Authoritative tone and fluency",
  "autogeo.metric.authority_fluency.instructions": "Check that the meaning is preserved before publishing the suggested text.",
  "autogeo.metric.keyword_stuffing.label": "Keyword stuffing",
  "autogeo.metric.keyword_stuffing.instructions": "Replace the [synonym/pronoun] placeholders with natural synonyms or pronouns.",

  // ------------------------------------------------------------ ActionItem title / description
  "autogeo.item.title_one": "{label}: {count} improvement — /{path}",
  "autogeo.item.title_other": "{label}: {count} improvements — /{path}",
  "autogeo.item.titleWeak": "{label}: needs work — /{path}",
  "autogeo.item.titleComparison": "Add a comparison table — /{path}",
  "autogeo.item.description.score": "{label} score {score}/100. {detail}",
  "autogeo.item.description.gain": "Estimated visibility gain: +{gain}%.",
  "autogeo.item.description.others": "These patches also improve: {labels}.",

  // ------------------------------------------------------------ "Apply to CMS" webhook delivery
  "autogeo.cms.delivered": "Delivered",
} satisfies Record<string, string>;
