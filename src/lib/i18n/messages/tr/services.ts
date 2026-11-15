// Namespace "services" — Turkish. Must define exactly the keys of ../en/services.ts with the same {placeholders}.
import type { services as en } from "../en/services";

export const services: Record<keyof typeof en, string> = {
  "services.som.overlappingCompetitor": "Çakışan rakip yok sayıldı: {url}",
};
