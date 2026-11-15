// Minimal Turkish morphology for query templates: vowel harmony, consonant assimilation,
// apostrophes for proper nouns, and pronunciation of digits / acronyms ("iPhone 15'in", "BMW'den").
//
// Orthography decides harmony; foreign names that are pronounced differently from how they are
// written ("Apple" → "epıl") are only handled for the common consonant+"le" ending.
//
// This module is deliberately Turkish: the letter names, numerals (sıfır, bir, iki …) and suffix tables below are
// language data needed to generate grammatical Turkish prompts for Turkish-language sites. It is not UI text and is
// not translated; the English counterparts of the query templates live in services/query-generator.ts.

const BACK = new Set(["a", "ı", "o", "u", "â", "û"]);
const VOWELS = new Set(["a", "e", "ı", "i", "o", "ö", "u", "ü", "â", "î", "û"]);
const HARD = new Set(["f", "s", "t", "k", "ç", "ş", "h", "p"]); // "fıstıkçı şahap"

/** How Turkish speakers read a letter when it stands alone (acronyms, model letters). */
const LETTER_NAMES: Record<string, string> = {
  a: "a", b: "be", c: "ce", ç: "çe", d: "de", e: "e", f: "fe", g: "ge", ğ: "yumuşak ge", h: "he",
  ı: "ı", i: "i", j: "je", k: "ke", l: "le", m: "me", n: "ne", o: "o", ö: "ö", p: "pe", q: "kü",
  r: "re", s: "se", ş: "şe", t: "te", u: "u", ü: "ü", v: "ve", w: "ve", x: "iks", y: "ye", z: "ze",
};
const ONES = ["sıfır", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz"];
const TENS = ["", "on", "yirmi", "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan"];

export const trLower = (s: string) => s.toLocaleLowerCase("tr-TR");

/** The spoken form of the number's final word — the only part suffixes attach to. */
export function spokenNumberTail(digits: string): string {
  const n = digits.replace(/^0+(?=\d)/, "");
  if (/^0+$/.test(n)) return "sıfır";
  const last = Number(n.at(-1));
  if (last) return ONES[last];
  const ten = Number(n.at(-2) ?? 0);
  if (ten) return TENS[ten];
  const zeros = n.length - n.replace(/0+$/, "").length;
  if (zeros === 2) return "yüz";
  if (zeros < 6) return "bin"; // 1.000 / 10.000 / 100.000 all end in "bin"
  return zeros >= 6 && zeros < 9 ? "milyon" : "milyar";
}

/** The spoken form of the last word of a phrase (letters only, lower case). */
export function spokenTail(phrase: string): string {
  const words = phrase.trim().split(/\s+/);
  let word = (words.at(-1) ?? "").replace(/[^\p{L}\p{N}+]+$/u, "");
  if (/\+$/.test(word)) return "artı"; // C++ → "artı"
  if (!word) return "e";
  const digits = word.match(/\d+$/)?.[0];
  if (digits) return spokenNumberTail(digits);
  word = word.replace(/[^\p{L}]/gu, "");
  if (!word) return "e";
  const lower = trLower(word);
  const hasVowel = [...lower].some((c) => VOWELS.has(c));
  // Acronyms and model letters: "BMW", "TV", "X" → spelled out letter by letter.
  if (word.length <= 4 && word === word.toLocaleUpperCase("tr-TR") && (word.length <= 3 || !hasVowel)) {
    return LETTER_NAMES[lower.at(-1)!] ?? lower;
  }
  if (!hasVowel) return LETTER_NAMES[lower.at(-1)!] ?? lower;
  // Foreign consonant + "le" endings are pronounced "-ıl": Apple, Google, Kettle (not "-lle": Breville → "-il").
  if (/[^aeıioöuül]le$/.test(lower) && lower.length >= 4 && !/[çğışöü]/.test(lower)) return `${lower.slice(0, -2)}ıl`;
  if (/[aeiou]lle$/.test(lower) && !/[çğışöü]/.test(lower)) return lower.slice(0, -1); // Breville, Rochelle → "-ll"
  return lower;
}

function lastVowel(spoken: string): string {
  for (let i = spoken.length - 1; i >= 0; i--) if (VOWELS.has(spoken[i])) return spoken[i];
  return "e";
}

const twoWay = (v: string) => (BACK.has(v) ? "a" : "e");
function fourWay(v: string) {
  if (v === "a" || v === "ı" || v === "â") return "ı";
  if (v === "e" || v === "i" || v === "î") return "i";
  if (v === "o" || v === "u" || v === "û") return "u";
  return "ü";
}

export type SuffixCase = "ablative" | "locative" | "genitive" | "dative" | "accusative";

/** "Kahve Dünyası", "Türk Hava Yolları": a multi-word name whose head carries the 3rd-person possessive. */
function isPossessiveCompound(phrase: string) {
  const words = phrase.trim().split(/\s+/);
  return words.length >= 2 && /\p{L}{2,}(s[ıiuü]|l[ae]r[ıi])$/u.test(trLower(words.at(-1)!));
}

/** Suffix only (without apostrophe), e.g. ("Acme", "ablative") → "den". */
export function suffixFor(phrase: string, kind: SuffixCase): string {
  const spoken = spokenTail(phrase);
  const v = lastVowel(spoken);
  const end = spoken.at(-1) ?? "e";
  const endsVowel = VOWELS.has(end);
  const hard = HARD.has(end);
  // Possessive compounds take the pronominal "n": Kahve Dünyası'ndan, Türk Hava Yolları'na.
  const n = isPossessiveCompound(phrase) ? "n" : "";
  switch (kind) {
    case "ablative": return n ? `nd${twoWay(v)}n` : `${hard ? "t" : "d"}${twoWay(v)}n`;
    case "locative": return n ? `nd${twoWay(v)}` : `${hard ? "t" : "d"}${twoWay(v)}`;
    case "dative": return n ? `n${twoWay(v)}` : `${endsVowel ? "y" : ""}${twoWay(v)}`;
    case "accusative": return n ? `n${fourWay(v)}` : `${endsVowel ? "y" : ""}${fourWay(v)}`;
    case "genitive": return `${endsVowel ? "n" : ""}${fourWay(v)}n`;
  }
}

/** Proper-noun inflection: "Acme" → "Acme'den", "iPhone 15" → "iPhone 15'in", "BMW" → "BMW'den". */
export function inflect(phrase: string, kind: SuffixCase, proper = true): string {
  const clean = phrase.trim().replace(/[.,;:!?]+$/, "");
  return `${clean}${proper ? "'" : ""}${suffixFor(clean, kind)}`;
}

/** Yes/no question particle written separately: "Acme mi", "Rival mı", "Ürün mü". */
export function questionParticle(phrase: string): string {
  return `m${fourWay(lastVowel(spokenTail(phrase)))}`;
}

/** Accent/case folding for comparisons (not for display). */
export function foldTurkish(s: string): string {
  return trLower(s)
    .replace(/ı/g, "i").replace(/ğ/g, "g").replace(/ş/g, "s").replace(/ç/g, "c").replace(/ö/g, "o").replace(/ü/g, "u")
    .normalize("NFKD").replace(/\p{M}+/gu, "");
}

const TR_MARKERS = /[çğışöüÇĞİŞÖÜ]|(?<!\p{L})(ve|ile|için|nedir|nasıl|nelerdir|hangi|neden|mı|mi|mu|mü|en iyi|nereden|kaç|fiyatı)(?!\p{L})/iu;
const EN_MARKERS = /(?<!\p{L})(the|and|what|how|which|why|where|is|are|does|do|best|can|of|for|with)(?!\p{L})/iu;

/** Rough language guess for crawled text (FAQ questions, headings). */
export function detectLanguage(text: string): "tr" | "en" | null {
  const tr = TR_MARKERS.test(text);
  const en = EN_MARKERS.test(text);
  if (tr && !en) return "tr";
  if (en && !tr) return "en";
  if (tr && en) return /[çğışöüİ]/.test(text) ? "tr" : "en";
  return null;
}

/**
 * Language guess for short names (categories, concepts) where function words are absent:
 * Turkish letters or plural/compound suffixes → tr; letters foreign to Turkish (w, q, x) or English
 * derivational endings → en.
 */
export function guessNameLanguage(name: string): "tr" | "en" | null {
  const sentence = detectLanguage(name);
  if (sentence) return sentence;
  if (/[çğışöüÇĞİŞÖÜ]/.test(name)) return "tr";
  const words = name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4);
  if (words.some((w) => /(lar|ler|ları|leri|lari|ları|ması|mesi|lık|lik|cı|ci|si|sı)$/.test(w) && !/(ies|ers)$/.test(w))) return "tr";
  // Spellings Turkish orthography never produces: w/q/x, digraphs, plural consonant clusters, English suffixes.
  if (/[wqx]/i.test(name) || words.some((w) => /(sh|ch|ph|ck|th|oo|ee|ea|ou)|(ers|ing|tion|ness|ment|ies|able|ful|ware|ive|ous|ly)$|[lgdtpy]s$/.test(w))) return "en";
  return null;
}
