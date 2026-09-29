#!/usr/bin/env python3
"""
WooCommerce -> embeddings -> Supabase.

Run this whenever prices, stock or the product list change. The bot reads the
products table live, so there is nothing to redeploy afterwards.

Only in-stock products are synced, and anything that disappears from the
in-stock list is deleted here too - recommending something the shop cannot
ship is the worst failure mode for this bot.

Run:  py sync_products.py
"""
import html
import os
import re
import sys
import time

import requests
from dotenv import load_dotenv

load_dotenv()

SITE = os.getenv("WC_SITE", "").rstrip("/")
WC_KEY = os.getenv("WC_CONSUMER_KEY", "")
WC_SECRET = os.getenv("WC_CONSUMER_SECRET", "")
SB_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SB_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
OPENAI_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_BASE = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
EMBED_MODEL = os.getenv("EMBED_MODEL", "text-embedding-3-small")

missing = [n for n, v in [
    ("WC_SITE", SITE), ("WC_CONSUMER_KEY", WC_KEY),
    ("WC_CONSUMER_SECRET", WC_SECRET), ("SUPABASE_URL", SB_URL),
    ("SUPABASE_SERVICE_ROLE_KEY", SB_KEY), ("OPENAI_API_KEY", OPENAI_KEY),
] if not v]
if missing:
    sys.exit("Missing in .env: " + ", ".join(missing))

PER_PAGE, TIMEOUT, EMBED_BATCH, UPSERT_BATCH = 100, 40, 100, 200

# Some Iranian hosts reject script-looking User-Agents, and some strip the
# Authorization header before PHP sees it - hence browser headers and a
# query-string fallback.
session = requests.Session()
session.headers.update({
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"),
    "Accept": "application/json",
})
AUTH_MODE = "basic"

FIELDS = ("id,name,sku,permalink,price,regular_price,sale_price,stock_quantity,"
          "stock_status,categories,attributes,short_description,description")


def clean(raw: str, limit: int = 700) -> str:
    if not raw:
        return ""
    text = re.sub(r"\[/?[^\]]+\]", " ", raw)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", html.unescape(text)).strip()[:limit]


def to_int(value) -> int:
    try:
        return int(float(str(value).strip() or 0))
    except (TypeError, ValueError):
        return 0


def request_page(page: int, mode: str):
    params = {"per_page": PER_PAGE, "page": page, "status": "publish",
              "stock_status": "instock", "_fields": FIELDS}
    auth = None
    if mode == "basic":
        auth = (WC_KEY, WC_SECRET)
    else:
        params["consumer_key"], params["consumer_secret"] = WC_KEY, WC_SECRET
    return session.get(f"{SITE}/wp-json/wc/v3/products", params=params,
                       auth=auth, timeout=TIMEOUT)


def fetch_page(page: int):
    global AUTH_MODE
    r = request_page(page, AUTH_MODE)
    if r.status_code in (401, 403) and AUTH_MODE == "basic":
        print("  basic auth refused; retrying with query-string auth...")
        alt = request_page(page, "query")
        if alt.status_code == 200:
            AUTH_MODE, r = "query", alt
        else:
            sys.exit(f"WooCommerce refused: {r.status_code} (basic) / "
                     f"{alt.status_code} (query).\n{alt.text[:300]}")
    if r.status_code != 200:
        sys.exit(f"WooCommerce HTTP {r.status_code}\n{r.text[:300]}")
    try:
        return r.json(), int(r.headers.get("X-WP-TotalPages", 1) or 1)
    except ValueError:
        sys.exit("WooCommerce did not return JSON - most likely a firewall "
                 f"page.\n{r.text[:300]}")


def search_text(p: dict) -> str:
    parts = [p["name"]]
    if p["sku"]:
        parts.append(p["sku"])
    if p["categories"]:
        parts.append(" ".join(p["categories"]))
    if p["attributes"]:
        parts.append(" ".join(f"{k}: {v}" for k, v in p["attributes"].items()))
    if p["summary"]:
        parts.append(p["summary"][:300])
    return " | ".join(parts)


def embed_all(texts):
    vectors = []
    for start in range(0, len(texts), EMBED_BATCH):
        r = requests.post(
            f"{OPENAI_BASE}/embeddings",
            headers={"Authorization": f"Bearer {OPENAI_KEY}"},
            json={"model": EMBED_MODEL, "input": texts[start:start + EMBED_BATCH]},
            timeout=120,
        )
        if r.status_code != 200:
            sys.exit(f"Embeddings HTTP {r.status_code}\n{r.text[:300]}")
        vectors.extend(d["embedding"] for d in r.json()["data"])
        print(f"  embedded {min(start + EMBED_BATCH, len(texts))}/{len(texts)}")
    return vectors


def sb(method: str, path: str, **kwargs):
    headers = {
        "apikey": SB_KEY,
        "Authorization": f"Bearer {SB_KEY}",
        "Content-Type": "application/json",
    }
    headers.update(kwargs.pop("extra_headers", {}))
    r = requests.request(method, f"{SB_URL}/rest/v1{path}", headers=headers,
                         timeout=120, **kwargs)
    if r.status_code >= 300:
        sys.exit(f"Supabase {method} {path} -> {r.status_code}\n{r.text[:400]}")
    return r


def main():
    print("1/4  reading WooCommerce...")
    products, page, total_pages = [], 1, 1
    while page <= total_pages:
        batch, total_pages = fetch_page(page)
        if not batch:
            break
        for p in batch:
            price = to_int(p.get("price"))
            if price <= 0:
                continue
            attrs = {a["name"]: ", ".join(map(str, a.get("options") or []))[:120]
                     for a in (p.get("attributes") or [])
                     if a.get("name") and a.get("options")}
            products.append({
                "id": p["id"],
                "name": (p.get("name") or "").strip(),
                "sku": p.get("sku") or None,
                "url": p.get("permalink") or None,
                "price": price,
                "regular_price": to_int(p.get("regular_price")) or None,
                "on_sale": to_int(p.get("sale_price")) > 0,
                "stock_qty": p.get("stock_quantity"),
                "categories": [c["name"] for c in (p.get("categories") or [])],
                "attributes": attrs,
                "summary": clean(p.get("short_description")) or clean(p.get("description")),
            })
        print(f"     page {page}/{total_pages} -> {len(products)} kept")
        page += 1
        time.sleep(0.3)

    if not products:
        sys.exit("No in-stock products found - refusing to wipe the table.")

    print(f"\n2/4  embedding {len(products)} products...")
    vectors = embed_all([search_text(p) for p in products])

    print("\n3/4  upserting into Supabase...")
    rows = []
    for p, v in zip(products, vectors):
        rows.append({**p, "search_text": search_text(p), "embedding": v,
                     "updated_at": "now()"})
    for start in range(0, len(rows), UPSERT_BATCH):
        sb("POST", "/ai_products",
           extra_headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
           json=rows[start:start + UPSERT_BATCH])
        print(f"     upserted {min(start + UPSERT_BATCH, len(rows))}/{len(rows)}")

    print("\n4/4  removing products that are no longer in stock...")
    keep = {p["id"] for p in products}
    existing = sb("GET", "/ai_products?select=id").json()
    stale = [row["id"] for row in existing if row["id"] not in keep]
    for start in range(0, len(stale), UPSERT_BATCH):
        chunk = stale[start:start + UPSERT_BATCH]
        sb("DELETE", "/ai_products?id=in.(" + ",".join(map(str, chunk)) + ")")
    print(f"     deleted {len(stale)}")

    with_specs = sum(1 for p in products if p["attributes"] or p["summary"])
    pct = with_specs * 100 // len(products)
    print(f"\nDone. {len(products)} in-stock products live in Supabase.")
    print(f"{with_specs} of them ({pct}%) have specs or a description.")
    if pct < 50:
        print("NOTE: most products carry no spec text, so the bot can find "
              "items but cannot compare them in any depth. That is a catalogue "
              "problem, not a prompt problem.")


if __name__ == "__main__":
    main()
