// Namespace "api" — Turkish. Must define exactly the keys of ../en/api.ts with the same {placeholders}.
import type { api as en } from "../en/api";

export const api: Record<keyof typeof en, string> = {};
