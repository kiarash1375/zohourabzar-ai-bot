// Zohour Abzar sales assistant - Telegram webhook.
//
// Handles text and voice messages. Voice is transcribed with Whisper and then
// answered exactly like text. Everything the bot says about a product comes
// from the `products` table; the prompt forbids inventing anything else.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { normalize, render, rerank, toman, type Product } from "./lib.ts";

// ---------------------------------------------------------------- config
// Deliberately NOT TELEGRAM_BOT_TOKEN: that secret belongs to the older
// telegram-bot function in this same project and must keep its own value.
const TELEGRAM_TOKEN = Deno.env.get("AI_BOT_TOKEN")!;
const WEBHOOK_SECRET = Deno.env.get("AI_WEBHOOK_SECRET")!;
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY")!;
const OPENAI_BASE = (Deno.env.get("OPENAI_BASE_URL") ?? "https://api.openai.com/v1")
  .replace(/\/$/, "");
const CHAT_MODEL = Deno.env.get("CHAT_MODEL") ?? "gpt-4o-mini";
const EMBED_MODEL = Deno.env.get("EMBED_MODEL") ?? "text-embedding-3-small";
const STT_MODEL = Deno.env.get("STT_MODEL") ?? "whisper-1";

const CANDIDATES = 25;   // pulled from pgvector, then re-ranked here
const TOP_K = 6;         // how many reach the model
const HISTORY_TURNS = 8;
const MAX_VOICE_SECONDS = 60;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const SYSTEM_PROMPT = `تو مشاور فروش فروشگاه اینترنتی «ظهور ابزار» هستی؛ فروشگاه ابزارآلات صنعتی و ساختمانی در مشهد.

قواعدی که هرگز نقض نمی‌کنی:
۱. فقط محصولاتی را پیشنهاد بده که در «کالاهای مرتبط» همین پیام آمده‌اند. اگر چیزی آنجا نیست، یعنی نداریمش.
۲. هیچ مشخصه، قیمت یا موجودی‌ای نگو که در داده‌ها نیامده. اگر نمی‌دانی، بگو نمی‌دانی و بگو مشتری با فروشگاه تماس بگیرد.
۳. قیمت‌ها را دقیقاً همان‌طور که در داده آمده بگو، به تومان.
۴. اگر هیچ کالای مناسبی در لیست نبود، صادقانه بگو این مورد را نداریم. کالای نامرتبط پیشنهاد نده.
۵. فوریت یا کمبود ساختگی نساز. تخفیفی که در داده نیست اعلام نکن.

چطور کمک می‌کنی:
- اول بفهم مشتری می‌خواهد با ابزار چه کاری بکند؛ اگر لازم است یک سؤال کوتاه بپرس.
- کالای مناسب را با دلیل پیشنهاد بده، نه فقط اسم و قیمت.
- اگر ابزار برای کار کردن به لوازم جانبی نیاز دارد (مته مناسب، صفحه، تجهیزات ایمنی) و آن لوازم در لیست هستند، یادآوری کن. این کمک واقعی است، نه فروش زورکی.
- اگر تفاوت دو مدل را می‌پرسند، فقط بر اساس مشخصات موجود مقایسه کن.

لحن: کوتاه، حرفه‌ای، صمیمی. فارسی روان. پاسخ‌ها را کوتاه نگه دار — حداکثر چند جمله، مگر اینکه مقایسه لازم باشد.
همیشه لینک محصولی را که پیشنهاد می‌دهی بیاور.`;

// ---------------------------------------------------------------- OpenAI
async function openai(path: string, body: unknown): Promise<any> {
  const r = await fetch(`${OPENAI_BASE}${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function embed(text: string): Promise<number[]> {
  const j = await openai("/embeddings", { model: EMBED_MODEL, input: text });
  return j.data[0].embedding;
}

/** Whisper: audio bytes in, Persian text out. */
async function transcribe(audio: Blob, filename: string): Promise<string> {
  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model", STT_MODEL);
  form.append("language", "fa");

  const r = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_KEY}` }, // no Content-Type: FormData sets it
    body: form,
  });
  if (!r.ok) {
    throw new Error(`transcription -> ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
  return ((await r.json()).text ?? "").trim();
}

// ---------------------------------------------------------------- Telegram
async function telegram(method: string, payload: unknown): Promise<any> {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json();
}

const send = (chatId: number, text: string) =>
  telegram("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });

/** Download a Telegram file (voice note) as a Blob. */
async function downloadFile(fileId: string): Promise<{ blob: Blob; name: string }> {
  const info = await telegram("getFile", { file_id: fileId });
  if (!info.ok) throw new Error("getFile failed: " + JSON.stringify(info).slice(0, 200));
  const path = info.result.file_path as string;
  const r = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${path}`);
  if (!r.ok) throw new Error(`file download -> ${r.status}`);
  return { blob: await r.blob(), name: path.split("/").pop() || "voice.oga" };
}

// ---------------------------------------------------------------- search
/**
 * pgvector gives us the semantically closest products; a literal token match
 * on the name or SKU (a model code like RH-3000) is much stronger evidence
 * than similarity alone, so those get a bonus before we take the top few.
 */
async function findProducts(question: string): Promise<Product[]> {
  const vector = await embed(question);
  const { data, error } = await supabase.rpc("match_ai_products", {
    query_embedding: vector,
    match_count: CANDIDATES,
  });
  if (error) throw new Error("match_ai_products: " + error.message);

  return rerank(data as Product[], question, TOP_K);
}

// ---------------------------------------------------------------- history
async function loadHistory(chatId: number) {
  const { data } = await supabase
    .from("ai_chat_history")
    .select("role, content")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_TURNS);
  return (data ?? []).reverse().map((r) => ({ role: r.role, content: r.content }));
}

async function saveTurn(chatId: number, question: string, answer: string) {
  await supabase.from("ai_chat_history").insert([
    { chat_id: chatId, role: "user", content: question },
    { chat_id: chatId, role: "assistant", content: answer },
  ]);
}

// ---------------------------------------------------------------- answering
async function answer(chatId: number, question: string) {
  const products = await findProducts(question);
  const context = products.map(render).join("\n\n---\n\n") || "(هیچ کالای مرتبطی یافت نشد)";
  const history = await loadHistory(chatId);

  const completion = await openai("/chat/completions", {
    model: CHAT_MODEL,
    temperature: 0.3,
    max_tokens: 600,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      {
        role: "user",
        content: `سؤال مشتری: ${question}\n\nکالاهای مرتبط موجود در انبار:\n\n${context}`,
      },
    ],
  });

  const reply = (completion.choices[0].message.content ?? "").trim() ||
    "ببخشید، جوابی پیدا نکردم.";
  await saveTurn(chatId, question, reply);
  await send(chatId, reply);
}

// ---------------------------------------------------------------- handler
const GREETING = `سلام 👋
من مشاور فروش ظهور ابزار هستم.

بگو دنبال چه ابزاری هستی یا می‌خوای چه کاری انجام بدی، تا کمکت کنم مناسب‌ترین گزینه رو پیدا کنی.

می‌تونی تایپ کنی یا ویس بفرستی.

مثال: «برای سوراخ کردن دیوار بتنی چی پیشنهاد می‌دی؟»`;

async function handleUpdate(update: any) {
  const message = update.message ?? update.edited_message;
  if (!message) return;

  const chatId = message.chat.id as number;

  // ---- commands
  const text = (message.text ?? "").trim();
  if (text.startsWith("/start")) return void await send(chatId, GREETING);
  if (text.startsWith("/reset")) {
    await supabase.from("ai_chat_history").delete().eq("chat_id", chatId);
    return void await send(chatId, "گفتگو از نو شروع شد.");
  }

  await telegram("sendChatAction", { chat_id: chatId, action: "typing" });

  // ---- voice / audio
  const voice = message.voice ?? message.audio;
  if (voice) {
    if ((voice.duration ?? 0) > MAX_VOICE_SECONDS) {
      return void await send(
        chatId,
        `ویس طولانی‌تر از ${MAX_VOICE_SECONDS} ثانیه رو نمی‌تونم پردازش کنم. کوتاه‌تر بفرست یا تایپ کن.`,
      );
    }
    const { blob, name } = await downloadFile(voice.file_id);
    const heard = await transcribe(blob, name);
    if (!heard) {
      return void await send(chatId, "صدا رو واضح نشنیدم. دوباره بفرست یا تایپ کن.");
    }
    // Echo what we heard, so a mis-transcription is obvious to the customer.
    await send(chatId, `🎤 شنیدم: «${heard}»`);
    await telegram("sendChatAction", { chat_id: chatId, action: "typing" });
    return void await answer(chatId, heard);
  }

  // ---- text
  if (!text) {
    return void await send(chatId, "فعلاً فقط متن و ویس رو می‌فهمم.");
  }
  await answer(chatId, text);
}

Deno.serve(async (req) => {
  // Telegram echoes this header back on every call; without the check anyone
  // who learns the function URL could drive the bot.
  if (req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  // Always 200 to Telegram: a non-200 makes it redeliver the same update in a
  // loop. Errors are logged and reported to the customer instead.
  try {
    await handleUpdate(update);
  } catch (err) {
    console.error("handler failed:", err);
    const chatId = update?.message?.chat?.id;
    if (chatId) {
      await send(chatId, "ببخشید، مشکلی پیش اومد. لطفاً دوباره بپرس یا با فروشگاه تماس بگیر.")
        .catch(() => {});
    }
  }
  return new Response("ok");
});
