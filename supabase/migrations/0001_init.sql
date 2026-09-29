-- Zohour Abzar sales bot - database schema
-- Run once in the Supabase SQL editor.

create extension if not exists vector;

-- ---------------------------------------------------------------- ai_products
-- A copy of the in-stock WooCommerce catalogue plus one embedding per row.
-- Refreshed by sync/sync_products.py; the bot only ever reads it.
create table if not exists ai_products (
    id             bigint primary key,          -- WooCommerce product id
    name           text        not null,
    sku            text,
    url            text,
    price          bigint      not null,        -- toman
    regular_price  bigint,
    on_sale        boolean     not null default false,
    stock_qty      integer,
    categories     text[]      not null default '{}',
    attributes     jsonb       not null default '{}',
    summary        text,
    search_text    text,                        -- what the embedding was built from
    embedding      vector(1536),
    updated_at     timestamptz not null default now()
);

-- At this catalogue size (under ~1k rows) exact search is instant, so there
-- is deliberately no ivfflat/hnsw index: an approximate index here would add
-- tuning work and could silently drop the correct product from the results.

-- Nearest neighbours by cosine distance. The bot asks for a wider set than
-- it needs and re-ranks in TypeScript, where it can also reward literal
-- model-code matches.
create or replace function match_ai_products(
    query_embedding vector(1536),
    match_count     integer default 25
)
returns table (
    id            bigint,
    name          text,
    sku           text,
    url           text,
    price         bigint,
    regular_price bigint,
    on_sale       boolean,
    stock_qty     integer,
    categories    text[],
    attributes    jsonb,
    summary       text,
    similarity    double precision
)
language sql
stable
as $$
    select p.id, p.name, p.sku, p.url, p.price, p.regular_price, p.on_sale,
           p.stock_qty, p.categories, p.attributes, p.summary,
           1 - (p.embedding <=> query_embedding) as similarity
    from ai_products p
    where p.embedding is not null
    order by p.embedding <=> query_embedding
    limit match_count;
$$;

-- ------------------------------------------------------------ chat history
-- Edge Functions are stateless, so conversation memory lives here.
create table if not exists ai_chat_history (
    id         bigserial primary key,
    chat_id    bigint      not null,
    role       text        not null check (role in ('user', 'assistant')),
    content    text        not null,
    created_at timestamptz not null default now()
);

create index if not exists ai_chat_history_chat_idx
    on ai_chat_history (chat_id, created_at desc);

-- Both tables are written only by the service role (the sync script and the
-- Edge Function). RLS on with no policies = no access for anon/authenticated
-- keys, which is what we want.
alter table ai_products     enable row level security;
alter table ai_chat_history enable row level security;
