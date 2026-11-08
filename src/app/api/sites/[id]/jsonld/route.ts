import { handle, json } from "@/lib/http";
import { getSiteJsonLd } from "@/lib/services/wikidata";

type Ctx = { params: Promise<{ id: string }> };

/** Site-wide Schema.org @graph (+ validation result and a ready-to-paste <script> tag). */
export const GET = handle<Ctx>(async (_request, { params }) => json(await getSiteJsonLd((await params).id)));
