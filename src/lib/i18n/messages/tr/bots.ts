// Namespace "bots" — Turkish. Must define exactly the keys of ../en/bots.ts with the same {placeholders}.
import type { bots as en } from "../en/bots";

export const bots: Record<keyof typeof en, string> = {};
