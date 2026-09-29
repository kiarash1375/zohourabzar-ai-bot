// Unit tests for the pure helpers. Run:  node --experimental-strip-types test/lib.test.ts
import assert from "node:assert/strict";
import { normalize, toman, render, rerank, type Product } from
  "../supabase/functions/telegram/lib.ts";

let failures = 0;
function check(label: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS  ${label}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${label}: ${(e as Error).message}`);
  }
}

const p = (over: Partial<Product>): Product => ({
  id: 1, name: "x", sku: null, url: null, price: 1000, regular_price: null,
  on_sale: false, stock_qty: null, categories: null, attributes: null,
  summary: null, similarity: 0.5, ...over,
});

check("folds Persian digits", () =>
  assert.equal(normalize("۹ میلی‌متر RH-3000"), "9 میلی متر RH-3000"));

check("folds Arabic kaf/ya", () => assert.equal(normalize("كاتر ياسر"), "کاتر یاسر"));

check("collapses whitespace", () => assert.equal(normalize("  a   b  "), "a b"));

check("empty input is safe", () => assert.equal(normalize(""), ""));

check("formats toman with separators", () =>
  assert.equal(toman(371413), "371,413 تومان"));

check("renders price, stock and link", () => {
  const out = render(p({
    name: "کاتر رونیکس", price: 371413, stock_qty: 4,
    url: "https://z.ir/1", categories: ["ابزار دستی"],
    attributes: { "عرض تیغه": "۹ میلی‌متر" }, summary: "کاتر حرفه‌ای",
  }));
  assert.match(out, /371,413 تومان/);
  assert.match(out, /موجودی: 4 عدد/);
  assert.match(out, /https:\/\/z\.ir\/1/);
  assert.match(out, /عرض تیغه/);
});

check("shows the old price only when on sale", () => {
  assert.match(render(p({ on_sale: true, regular_price: 420000 })),
    /قیمت قبل از تخفیف: 420,000 تومان/);
  assert.doesNotMatch(render(p({ on_sale: false, regular_price: 420000 })),
    /قیمت قبل از تخفیف/);
});

check("falls back when stock quantity is unknown", () =>
  assert.match(render(p({ stock_qty: null })), /موجودی: موجود/));

check("caps attributes at six lines", () => {
  const attrs = Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`k${i}`, `v${i}`]));
  const out = render(p({ attributes: attrs }));
  assert.equal((out.match(/^k\d: v\d$/gm) ?? []).length, 6);
});

// --- the ranking rule that actually decides whether we quote the right price
// Similarities below are what an embedding plausibly returns: a question made
// mostly of question words ("قیمت ... چنده") scores poorly against every
// product, which is exactly when the lexical signals have to carry the result.
const candidates: Product[] = [
  p({ id: 1, name: "کاتر ۹ میلی متری رونیکس مدل Ronix RH-3000", sku: "10310", similarity: 0.58 }),
  p({ id: 2, name: "کاتر ۱۸ میلی متری اسیست مدل ASSIST 38G", sku: "9001", similarity: 0.62 }),
  p({ id: 3, name: "دستکش ایمنی لاتکس", sku: "10251", similarity: 0.80 }),
];

check("literal model code beats a big similarity gap", () => {
  const adversarial = candidates.map((c) =>
    c.id === 1 ? { ...c, similarity: 0.20 } : { ...c, similarity: 0.85 });
  assert.equal(rerank(adversarial, "قیمت Ronix RH-3000 چنده", 3)[0].id, 1);
});

check("the other model code picks the other product", () =>
  assert.equal(rerank(candidates, "ASSIST 38G موجوده؟", 3)[0].id, 2));

// Two near-identical cutters; only the brand word separates them, and the
// wrong one starts slightly ahead on similarity.
check("the one distinguishing word decides between look-alikes", () =>
  assert.equal(rerank(candidates, "کاتر ۹ میلی متری رونیکس", 3)[0].id, 1));

check("asking for the other brand flips the result", () =>
  assert.equal(rerank(candidates, "کاتر میلی متری اسیست", 3)[0].id, 2));

check("without lexical evidence, similarity order is kept", () =>
  assert.deepEqual(rerank(candidates, "چی داری", 3).map((x) => x.id), [3, 2, 1]));

check("SKU match counts too", () =>
  assert.equal(rerank(candidates, "کد 10251", 3)[0].id, 3));

check("question words alone must not rank anything", () =>
  assert.deepEqual(
    rerank(candidates, "قیمت چنده لطفا", 3).map((x) => x.id), [3, 2, 1]));

check("a code that matches nothing changes nothing", () =>
  assert.deepEqual(
    rerank(candidates, "مدل XY-9999", 3).map((x) => x.id), [3, 2, 1]));

check("respects topK", () =>
  assert.equal(rerank(candidates, "کاتر", 2).length, 2));

check("short tokens are ignored", () =>
  assert.deepEqual(rerank(candidates, "را ت", 3).map((x) => x.id), [3, 2, 1]));

check("empty candidate list does not throw", () =>
  assert.deepEqual(rerank([], "هرچیزی", 6), []));

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
