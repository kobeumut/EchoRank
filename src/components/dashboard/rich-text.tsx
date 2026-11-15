import { Fragment, type ReactNode } from "react";

/**
 * Renders an already-translated message that contains `{name}` slots for React nodes (a link, `<code>`, `<b>` …).
 * Keeps the whole sentence in one catalog entry so translators can reorder the slots:
 *
 *   rich(t("studio.cmsHelp"), { link: <Link href="…">AI Distribution</Link>, code: <code>autogeo.suggestion.applied</code> })
 *
 * Slots without a matching entry in `parts` are left as written.
 */
export function rich(message: string, parts: Record<string, ReactNode>): ReactNode {
  return message.split(/(\{\w+\})/g).map((chunk, i) => {
    const name = /^\{(\w+)\}$/.exec(chunk)?.[1];
    return name && name in parts ? <Fragment key={i}>{parts[name]}</Fragment> : chunk;
  });
}
