// Pure helpers - no Deno, no network, no database. Kept separate so they can
// be unit tested with plain node (see ../../../test/lib.test.ts).

export interface Product {
  id: number;
  name: string;
  sku: string | null;
  url: string | null;
  price: number;
  regular_price: number | null;
  on_sale: boolean;
  stock_qty: number | null;
  categories: string[] | null;
  attributes: Record<string, string> | null;
  summary: string | null;
  similarity: number;
}

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/** Fold Persian/Arabic digit and letter variants so matching works. */
export function normalize(s: string): string {
  if (!s) return "";
  let out = s.normalize("NFKC");
  for (let i = 0; i < 10; i++) {
    out = out.replaceAll(FA_DIGITS[i], String(i))
      .replaceAll(AR_DIGITS[i], String(i));
  }
  return out
    .replaceAll("ي", "ی")
    .replaceAll("ك", "ک")
    .replace(/[‌‎‏]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const toman = (n: number) => `${n.toLocaleString("en-US")} تومان`;

/** One product as compact text for the model's context. */
export function render(p: Product): string {
  const lines = [`نام: ${p.name}`, `قیمت: ${toman(p.price)}`];
  if (p.on_sale && p.regular_price) {
    lines.push(`قیمت قبل از تخفیف: ${toman(p.regular_price)}`);
  }
  lines.push(
    typeof p.stock_qty === "number" ? `موجودی: ${p.stock_qty} عدد` : "موجودی: موجود",
  );
  if (p.categories?.length) {
    lines.push("دسته: " + p.categories.slice(0, 3).join(" / "));
  }
  for (const [k, v] of Object.entries(p.attributes ?? {}).slice(0, 6)) {
    lines.push(`${k}: ${v}`);
  }
  if (p.summary) lines.push("توضیح: " + p.summary.slice(0, 300));
  if (p.url) lines.push(`لینک: ${p.url}`);
  return lines.join("\n");
}

/**
 * Persian question words that never appear in a product name. Left in, they
 * dilute the coverage ratio below and make a real match look like a weak one.
 */
const STOPWORDS = new Set([
  "قیمت", "چنده", "چند", "هست", "هستش", "دارید", "داری", "دارین", "دارین؟",
  "میخوام", "میخواهم", "میخواستم", "برای", "چیه", "چیست", "لطفا", "سلام",
  "بهتر", "بهترین", "کدوم", "کدام", "میشه", "این", "اون", "یه", "یک",
  "تومن", "تومان", "ممنون", "دارم", "خرید", "بخرم", "موجوده", "موجود",
  "ارزون", "ارزان", "گرون", "گران", "که", "رو", "را", "از", "با", "در", "به",
  "چطور", "چگونه", "کنم", "کنید", "هم", "تا", "های", "ها",
]);

/** A model code: mixes in a digit and is long enough not to match by accident. */
const isCode = (token: string) => /\d/.test(token) && token.length >= 3;

export interface RerankOptions {
  /** weight on the share of content words found in the product name */
  coverageWeight?: number;
  /** flat bonus when a model code from the question appears in name or SKU */
  codeBonus?: number;
}

/**
 * pgvector returns the semantically closest products, but semantic similarity
 * alone gets model numbers wrong: "کاتر رونیکس RH-3000" and "کاتر رونیکس
 * RH-4000" look nearly identical to an embedding, and an unrelated product can
 * outscore the right one when the question is mostly question words.
 *
 * So two lexical signals are added on top:
 *   - coverage: what share of the question's content words appear in the name
 *   - code match: a model code is near-unique, so it is close to conclusive
 *
 * The code bonus is deliberately large enough to overturn a big similarity
 * gap. Quoting the price of a similar-but-different tool is the failure this
 * is here to prevent.
 */
export function rerank(
  candidates: Product[],
  question: string,
  topK: number,
  options: RerankOptions = {},
): Product[] {
  const { coverageWeight = 0.4, codeBonus = 0.6 } = options;
  if (candidates.length === 0) return [];

  const tokens = normalize(question)
    .toLowerCase()
    .split(" ")
    .filter((t) => t.length > 2);
  const content = tokens.filter((t) => !STOPWORDS.has(t));
  const codes = tokens.filter(isCode);

  const hays = candidates.map((p) =>
    normalize(`${p.name} ${p.sku ?? ""}`).toLowerCase()
  );

  // Weight each word by how well it separates these candidates. In a tool
  // catalogue most shortlisted products share the generic words ("کاتر",
  // "میلی", "متری") and differ by one: the brand or the size. Averaging the
  // words equally buries that one; inverse document frequency surfaces it.
  const weights = new Map<string, number>();
  for (const token of content) {
    const df = hays.filter((h) => h.includes(token)).length;
    weights.set(token, Math.log(1 + candidates.length / Math.max(df, 1)));
  }
  const totalWeight = content.reduce((sum, t) => sum + weights.get(t)!, 0);

  return candidates
    .map((p, i) => {
      const hay = hays[i];
      const matched = content.reduce(
        (sum, t) => sum + (hay.includes(t) ? weights.get(t)! : 0),
        0,
      );
      const coverage = totalWeight > 0 ? matched / totalWeight : 0;
      const codeHit = codes.some((t) => hay.includes(t));
      return {
        p,
        score: p.similarity + coverageWeight * coverage + (codeHit ? codeBonus : 0),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => x.p);
}
