# Zohour Abzar - AI sales assistant

A Telegram bot that advises customers on the zohourabzar.ir catalogue: what we
stock, what it costs, how many are left, and which tool suits the job. It
accepts text and voice notes (transcribed with Whisper, answered in text).

Everything it says about a product comes from the `products` table. The prompt
forbids stating any price, spec or stock figure that is not in the data, and
only in-stock products are ever loaded - recommending something the shop
cannot ship is the failure this design is built to avoid.

## How it fits together

```
customer ──► Telegram ──► Supabase Edge Function ──► OpenAI (chat, embeddings, Whisper)
                                    │
                                    ▼
                          Supabase Postgres + pgvector
                                    ▲
                                    │
               sync_products.py ────┘   (run locally when prices change)
```

The Edge Function is always on, so nothing has to stay running on your machine.
Refreshing the catalogue never needs a redeploy: the bot reads the table live.

## One-time setup

### 1. Database

Supabase dashboard -> SQL Editor -> paste `supabase/migrations/0001_init.sql`
-> Run. This creates the `products` and `chat_history` tables, the pgvector
extension and the `match_products` function.

### 2. Bot token

Message @BotFather, `/newbot`, copy the token.

### 3. Function secrets

Supabase dashboard -> Edge Functions -> Secrets. Add:

| Secret | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | from BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | any random string you invent (see step 5) |
| `OPENAI_API_KEY` | your key |
| `OPENAI_BASE_URL` | `https://api.gapgpt.app/v1` |
| `CHAT_MODEL` | `gpt-4o-mini` (optional) |
| `EMBED_MODEL` | `text-embedding-3-small` (optional) |
| `STT_MODEL` | `whisper-1` (optional) |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically -
do not add them here.

### 4. Deploy the function

```
npm install -g supabase
supabase login
supabase link --project-ref <your-project-ref>
supabase functions deploy telegram --no-verify-jwt
```

`--no-verify-jwt` is required: Telegram cannot send a Supabase JWT. The
function is protected by the webhook secret instead (step 5), and it refuses
any request without it.

### 5. Point Telegram at it

Replace both placeholders and open the URL in a browser once:

```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<project-ref>.supabase.co/functions/v1/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>
```

You should get `{"ok":true,...}`. The `secret_token` must match the
`TELEGRAM_WEBHOOK_SECRET` secret exactly.

### 6. Load the catalogue

```
cd sync
py -m pip install -r requirements.txt
cp ../.env.example ../.env     # then fill it in
py sync_products.py
```

Takes a couple of minutes. Re-run it whenever prices, stock or the product
list change - no redeploy needed.

## Day to day

| Task | What to do |
|---|---|
| Prices or stock changed | `py sync/sync_products.py` |
| Changed the prompt or bot logic | `supabase functions deploy telegram --no-verify-jwt` |
| Watch live logs | Supabase dashboard -> Edge Functions -> telegram -> Logs |
| Run the tests | `node --experimental-strip-types test/lib.test.ts` |

## Commands in Telegram

| Command | Effect |
|---|---|
| `/start` | greeting and an example |
| `/reset` | clears that chat's conversation history |

Anything else is treated as a question. Voice notes up to 60 seconds are
transcribed; the bot echoes back what it heard so a mis-transcription is
obvious to the customer.

## How an answer is produced

1. The question is embedded and `match_products` returns the 25 nearest
   products by cosine distance.
2. Those 25 are re-ranked in `lib.ts`, which adds two lexical signals to the
   similarity score:
   - **coverage** - what share of the question's content words appear in the
     product name, each word weighted by how well it separates the candidates.
     In this catalogue most shortlisted products share the generic words and
     differ by one (brand or size); that word is the one that matters.
   - **code match** - a model code like `RH-3000` is near-unique, so it gets a
     large flat bonus, big enough to overturn a wide similarity gap.
3. The top 6 are rendered as text and sent to the chat model with the system
   prompt and the last few turns of conversation.
4. The model may only recommend products from that block.

Step 2 exists because embeddings alone confuse `RH-3000` with `RH-4000`.
Quoting the price of a similar-but-different tool is the specific mistake it
prevents; `test/lib.test.ts` pins that behaviour down.

## Layout

| Path | Purpose |
|---|---|
| `supabase/migrations/0001_init.sql` | tables, pgvector, `match_products` |
| `supabase/functions/telegram/index.ts` | webhook: routing, voice, LLM calls |
| `supabase/functions/telegram/lib.ts` | pure helpers (normalising, ranking, rendering) |
| `sync/sync_products.py` | WooCommerce -> embeddings -> Supabase |
| `test/lib.test.ts` | unit tests for `lib.ts` |

## Known limits

- Prices come from WooCommerce, which mirrors Hesabfa exactly. Whatever is
  wrong in Hesabfa is wrong here too. **Do not put this in front of real
  customers until the catalogue prices are correct.**
- The sync deletes products that have left the in-stock list, so the bot never
  sees them. It refuses to run if WooCommerce returns an empty list, rather
  than wiping the table.
- The bot can find products but cannot compare them in depth unless the
  catalogue carries spec attributes or descriptions. `sync_products.py` prints
  what share of products have any spec text; if that number is low, the fix is
  the product-research project, not the prompt.
- Voice replies are text only, by design for now.
