// Conversation agent: talks to a shopkeeper in Persian, proposes an order from
// the outlet's history, reads it back, and records the order or the reason
// for not buying.
// Model provider, in order:
//   1. Claude, when ANTHROPIC_API_KEY is set (paid; best quality)
//   2. a free model on the Kilo AI gateway (default; no key, ~200 requests/hour per IP;
//      free providers may log prompts, so use synthetic data only)
//   3. a small scripted stand-in when DEMO_PROVIDER=offline, or as a fallback

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { PRODUCTS } from "./data.js";

export const PROVIDER = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
  ? "claude"
  : process.env.DEMO_PROVIDER === "offline" ? "offline" : "kilo";
export const MODEL = process.env.DEMO_MODEL
  || (PROVIDER === "claude" ? "claude-opus-5-5" : PROVIDER === "kilo" ? "nvidia/nemotron-3-ultra-550b-a55b:free" : "—");
const KILO_URL = "https://ai-gateway.kilo.ai/api/v1/chat/completions";
export const COMPANY = "پخش نمونه";

const fa = (n) => String(n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
const toman = (n) => `${fa(Math.round(n).toLocaleString("en-US"))} تومان`;
const product = (id) => PRODUCTS.find((p) => p.id === id);

export const TurnSchema = z.object({
  reply: z.string().describe("پیام بعدی به مغازه‌دار، فارسی و کوتاه"),
  order_status: z.enum(["none", "proposed", "confirmed"]),
  order: z.array(z.object({ productId: z.string(), qty: z.number().int() })),
  no_buy_reason: z.string().nullable(),
  handoff: z.boolean(),
});

export function cleanOrder(order) {
  const seen = new Map();
  for (const it of order || []) {
    const p = product(it.productId);
    const qty = Math.round(Number(it.qty));
    if (!p || !Number.isFinite(qty) || qty < 1 || qty > 50) continue;
    seen.set(p.id, (seen.get(p.id) || 0) + qty);
  }
  return [...seen.entries()].map(([productId, qty]) => ({ productId, qty }));
}

export function orderTotal(order) {
  return order.reduce((s, it) => s + it.qty * product(it.productId).price, 0);
}

function systemPrompt(a) {
  const catalog = PRODUCTS.map((p) => `${p.id}: ${p.name} (${p.unit}) — ${toman(p.price)}`).join("\n");
  const history = a.history
    .map((inv) => `${inv.date}: ` + inv.items.map((it) => `${product(it.productId).name} × ${it.qty}`).join("، "))
    .join("\n");
  const suggested = a.suggested.map((it) => `${it.productId} (${product(it.productId).name}) × ${it.qty}`).join("، ");
  return `تو دستیار فروش شرکت «${COMPANY}» هستی و در پیام‌رسان با صاحب یک مغازه گفت‌وگو می‌کنی.

مغازه: ${a.outlet.name}، محله‌ی ${a.outlet.area}، ${a.outlet.owner}
وضعیت: ${a.reasons.join("؛ ")}
آخرین خریدها:
${history}
سفارش پیشنهادی بر اساس خریدهای معمول: ${suggested}

فهرست کالا و قیمت (فقط همین‌ها را می‌توانی بفروشی):
${catalog}

روش کار:
- مؤدب، کوتاه و خودمانیِ محترمانه بنویس، مثل یک ویزیتور باتجربه. هر پیام حداکثر سه جمله.
- پیام اول: سلام، خودت را دستیار ${COMPANY} معرفی کن، بگو مدتی است سفارش نداشته‌اند و سفارش پیشنهادی را با قیمت کل پیشنهاد بده.
- اگر مغازه‌دار تغییری خواست، سفارش را مطابق خواسته‌اش عوض کن. کالای خارج از فهرست را نپذیر و بگو موجود نداریم.
- قبل از ثبت، سفارش نهایی را با اقلام، تعداد و مبلغ کل بازخوانی کن و تأیید بخواه (order_status = "proposed").
- فقط وقتی مغازه‌دار صریحاً تأیید کرد، order_status را "confirmed" بگذار و بگو سفارش ثبت شد و پیامک تأیید می‌آید.
- اگر نخرید، محترمانه علت را بپرس و در no_buy_reason کوتاه بنویس (مثلاً «قیمت رقیب ارزان‌تر است»، «ویزیتور نیامده»، «موجودی دارد»).
- اگر شکایت، مشکل پرداخت یا درخواستی خارج از اختیار تو بود، handoff را true کن و بگو همکار انسانی تماس می‌گیرد.
- در order همیشه سبد فعلی را بنویس (شناسه‌ی کالا و تعداد). اگر سبدی در کار نیست، آرایه‌ی خالی.
- هیچ تخفیف، شرط پرداخت یا زمان تحویلی که در این متن نیامده قول نده.`;
}

function toApiMessages(turns) {
  // turns: [{role: "agent", raw}, {role: "shop", text}, ...]; the conversation opens with the agent.
  const msgs = [{ role: "user", content: "[گفت‌وگو شروع شد. پیام اول را بفرست.]" }];
  for (const t of turns) {
    if (t.role === "agent") msgs.push({ role: "assistant", content: JSON.stringify(t.raw) });
    else msgs.push({ role: "user", content: t.text });
  }
  return msgs;
}

let client = null;
// true when a language model (Claude or the free Kilo model) is in use
export function hasClaude() {
  return PROVIDER !== "offline";
}

// Error with a message fit for the UI
export class ModelError extends Error {
  constructor(userMessage) { super(userMessage); this.userMessage = userMessage; }
}

// One structured call to the model; returns parsed output, or null on refusal / unparsable output.
export async function askClaude(args) {
  if (PROVIDER === "kilo") {
    // free models are less reliable at strict JSON: one retry
    return (await askKilo(args)) ?? (await askKilo(args));
  }
  client ||= new Anthropic();
  const { system, messages, schema, maxTokens = 4000 } = args;
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages,
    output_config: { effort: "low", format: betaZodOutputFormat(schema) },
  });
  if (response.stop_reason === "refusal") return null;
  return response.parsed_output ?? null;
}

// OpenAI-compatible call to the Kilo gateway; the schema is described in the prompt
// and the reply is validated with zod.
// Free models sometimes write Arabic ي/ك for Persian ی/ک, or leak stray characters
// from other scripts; clean every string in the reply.
function tidy(value) {
  if (typeof value === "string") {
    return value.replace(/ي/g, "ی").replace(/ك/g, "ک")
      .replace(/[\u0400-\u04FF\u1100-\u11FF\u3040-\u30FF\u3130-\u318F\u4E00-\u9FFF\uAC00-\uD7AF]+/g, "").trim();
  }
  if (Array.isArray(value)) return value.map(tidy);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, tidy(v)]));
  return value;
}

async function askKilo(args) {
  // the free gateway returns 502/503 now and then: retry those twice
  for (let attempt = 0; ; attempt++) {
    try {
      return await askKiloOnce(args);
    } catch (err) {
      if (!(err.retryable && attempt < 2)) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

async function askKiloOnce({ system, messages, schema, maxTokens = 2000 }) {
  const schemaText = JSON.stringify(z.toJSONSchema(schema));
  let res;
  try {
    res = await fetch(KILO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(process.env.KILO_API_KEY ? { Authorization: `Bearer ${process.env.KILO_API_KEY}` } : {}) },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `${system}\n\nپاسخ را فقط به‌صورت یک شیء JSON با این ساختار بده و هیچ متن دیگری ننویس:\n${schemaText}` },
          ...messages,
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw new ModelError("اتصال به سرویس مدل رایگان برقرار نشد");
  }
  if (res.status === 429) throw new ModelError("سقف استفاده‌ی رایگان (حدود ۲۰۰ درخواست در ساعت) پر شده؛ کمی بعد امتحان کنید");
  if (!res.ok) {
    const err = new ModelError(`سرویس مدل رایگان خطا داد (${res.status})`);
    err.retryable = res.status >= 500;
    throw err;
  }
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content ?? "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let data;
  try { data = tidy(JSON.parse(text.slice(start, end + 1))); } catch { return null; }
  // free models often send "" or leave out nullable / list fields
  for (const [key, field] of Object.entries(schema.shape)) {
    if (data[key] === "" && field.safeParse(null).success) data[key] = null;
    if (data[key] === undefined) {
      if (field.safeParse(null).success) data[key] = null;
      else if (field.safeParse([]).success) data[key] = [];
      else if (field.safeParse(false).success) data[key] = false;
    }
  }
  const parsed = schema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

async function claudeTurn(analysis, turns) {
  const out = await askClaude({ system: systemPrompt(analysis), messages: toApiMessages(turns), schema: TurnSchema });
  return out ?? { reply: "ببخشید، الان نمی‌توانم ادامه بدهم. همکارم با شما تماس می‌گیرد.", order_status: "none", order: [], no_buy_reason: null, handoff: true };
}

// Offline stand-in: enough to click through the flow without a key.
const YES = /(باشه|بفرست|اوکی|ok|بله|آره|قبول|تایید|تأیید|ثبت کن|حله)/i;
const NO = /(نه|نمی‌خوام|نمیخوام|فعلا|فعلاً|لازم نیست|نیاز ندار)/;
function scriptedTurn(analysis, turns) {
  const last = turns.at(-1);
  const order = analysis.suggested;
  const list = order.map((it) => `${product(it.productId).name} ${fa(it.qty)} ${product(it.productId).unit}`).join("، ");
  if (!last) {
    return { reply: `سلام ${analysis.outlet.owner}، وقت بخیر. دستیار ${COMPANY} هستم. مدتی است از ما سفارش نداشتید؛ مثل همیشه ${list} بفرستیم؟ جمعاً ${toman(orderTotal(order))}.`, order_status: "proposed", order, no_buy_reason: null, handoff: false };
  }
  const prev = [...turns].reverse().find((t) => t.role === "agent")?.raw;
  if (prev?.no_buy_reason === "در حال پرسیدن") {
    return { reply: "ممنون که گفتید؛ به مدیر فروش منتقل می‌کنم. هر وقت نیاز داشتید همین‌جا پیام بدهید.", order_status: "none", order: [], no_buy_reason: last.text.slice(0, 80), handoff: false };
  }
  if (YES.test(last.text)) {
    return { reply: `سفارش ثبت شد: ${list}، جمعاً ${toman(orderTotal(order))}. پیامک تأیید برایتان می‌آید.`, order_status: "confirmed", order, no_buy_reason: null, handoff: false };
  }
  if (NO.test(last.text)) {
    return { reply: "چشم. اگر اشکالی ندارد بفرمایید چرا این مدت از ما خرید نکردید؟ قیمت، موجودی یا چیز دیگری؟", order_status: "none", order: [], no_buy_reason: "در حال پرسیدن", handoff: false };
  }
  return { reply: "در حالت نمایشی بدون مدل فقط «بله» یا «نه» را می‌فهمم. سفارش را بفرستیم؟", order_status: "proposed", order, no_buy_reason: null, handoff: false };
}

export async function agentTurn(analysis, turns) {
  const raw = hasClaude() ? await claudeTurn(analysis, turns) : scriptedTurn(analysis, turns);
  const order = cleanOrder(raw.order);
  return { ...raw, order, total: orderTotal(order), mode: hasClaude() ? PROVIDER : "scripted" };
}
