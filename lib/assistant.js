// Operator assistant (phase 1): a human operator or visitor talks to the
// shopkeeper. The AI (1) drafts the message / call opener and talking points
// for each outlet, and (2) turns the operator's free-text call note into a
// structured order or no-buy reason, which the operator confirms before saving.

import { z } from "zod";
import { PRODUCTS } from "./data.js";
import { askClaude, hasClaude, cleanOrder, orderTotal, COMPANY, PROVIDER } from "./agent.js";

const fa = (n) => String(n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
const toman = (n) => `${fa(Math.round(n).toLocaleString("en-US"))} تومان`;
const product = (id) => PRODUCTS.find((p) => p.id === id);
const catalog = () => PRODUCTS.map((p) => `${p.id}: ${p.name} (${p.unit}) — ${toman(p.price)}`).join("\n");
const line = (it) => `${product(it.productId).name} ${fa(it.qty)} ${product(it.productId).unit}`;

function outletContext(a) {
  const history = a.history
    .map((inv) => `${inv.date}: ` + inv.items.map((it) => `${product(it.productId).name} × ${it.qty}`).join("، "))
    .join("\n");
  return `مغازه: ${a.outlet.name}، محله‌ی ${a.outlet.area}، ${a.outlet.owner}
وضعیت: ${a.reasons.join("؛ ")}
آخرین خریدها:
${history}
سفارش پیشنهادی بر اساس خریدهای معمول: ${a.suggested.map(line).join("، ")}`;
}

// ---------- 1. draft ----------
export const DraftSchema = z.object({
  message: z.string().describe("پیام آماده برای ارسال در پیام‌رسان یا جمله‌ی شروع تماس"),
  talking_points: z.array(z.string()).describe("۳ تا ۴ نکته‌ی کوتاه برای اپراتور"),
});

function scriptedDraft(a) {
  const total = orderTotal(a.suggested);
  return {
    message: `سلام ${a.outlet.owner}، وقت بخیر. از ${COMPANY} پیام می‌دهم. مدتی است سفارش نداشتید؛ اگر موافق باشید مثل همیشه ${a.suggested.map(line).join("، ")} بفرستیم، جمعاً ${toman(total)}.`,
    talking_points: [
      a.reasons[0],
      `پرفروش‌ترین اقلامش: ${a.suggested.slice(0, 2).map((it) => product(it.productId).name).join(" و ")}`,
      "اگر نخرید، علتش را بپرسید (قیمت، موجودی، ویزیتور، رقیب)",
    ],
  };
}

export async function draftOutreach(a) {
  if (!hasClaude()) return { ...scriptedDraft(a), mode: "scripted" };
  const out = await askClaude({
    system: `تو دستیار اپراتورهای فروش شرکت «${COMPANY}» هستی. اپراتور انسانی با مغازه‌دار تماس می‌گیرد یا پیام می‌دهد؛ تو فقط برای او متن آماده می‌کنی و خودت با مغازه‌دار حرف نمی‌زنی.

${outletContext(a)}

فهرست کالا و قیمت:
${catalog()}`,
    messages: [{ role: "user", content: `برای این مغازه دو چیز بنویس:
۱. message: یک پیام کوتاه و محترمانه (حداکثر سه جمله) که اپراتور بتواند همان را در پیام‌رسان بفرستد یا با آن تماس را شروع کند: سلام، معرفی ${COMPANY}، اشاره‌ی ملایم به اینکه مدتی است خرید نکرده، و سفارش پیشنهادی با مبلغ کل.
۲. talking_points: سه یا چهار نکته‌ی کوتاه برای اپراتور: چرا این مغازه، چه چیزی پیشنهاد بدهد، و اگر نخرید چه بپرسد.
هیچ تخفیف، شرط پرداخت یا زمان تحویلی قول نده.` }],
    schema: DraftSchema,
  });
  return { ...(out ?? scriptedDraft(a)), mode: out ? PROVIDER : "scripted" };
}

// ---------- 2. extract ----------
export const OutcomeSchema = z.object({
  outcome: z.enum(["ordered", "declined", "callback", "handoff"]),
  order: z.array(z.object({ productId: z.string(), qty: z.number().int() })),
  no_buy_reason: z.string().nullable(),
  summary: z.string().describe("خلاصه‌ی یک‌جمله‌ای نتیجه برای مدیر فروش"),
  unclear: z.array(z.string()).describe("چیزهایی در یادداشت که مبهم بود و اپراتور باید چک کند"),
});

// "نه" is left out on purpose: in a note it almost always means "no", not nine.
const NUM_WORDS = { "یک": 1, "یه": 1, "دو": 2, "سه": 3, "چهار": 4, "پنج": 5, "شش": 6, "شیش": 6, "هفت": 7, "هشت": 8, "ده": 10 };
const KEYWORDS = { P01: ["روغن"], P02: ["برنج"], P03: ["ماکارونی"], P04: ["رب گوجه", "رب"], P05: ["ظرفشویی"], P06: ["پودر", "لباسشویی"],
  P07: ["شامپو"], P08: ["دستمال"], P09: ["نوشابه"], P10: ["آب معدنی"], P11: ["چای"], P12: ["تن ماهی", "کنسرو"] };
const toLatin = (s) => s.replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d));
const EDGE = "[\\s،,.؛:!؟?()]";
// index of w as a whole word (Persian has no \b), or -1
const wordIndex = (text, w) => {
  const m = new RegExp(`(^|${EDGE})${w}(?=${EDGE}|$)`).exec(text);
  return m ? m.index + m[1].length : -1;
};

// Offline stand-in: finds "<number> <product word>" or "<product word> <number>" in the note.
export function scriptedExtract(note) {
  const text = toLatin(note);
  const order = [];
  for (const [pid, words] of Object.entries(KEYWORDS)) {
    for (const w of words) {
      const i = wordIndex(text, w);
      if (i < 0) continue;
      const around = text.slice(Math.max(0, i - 14), i + w.length + 14);
      const digit = around.match(/\d+/);
      const word = Object.keys(NUM_WORDS).find((k) => new RegExp(`(^|\\s)${k}(\\s|$)`).test(around));
      const qty = digit ? Number(digit[0]) : word ? NUM_WORDS[word] : null;
      if (qty) order.push({ productId: pid, qty });
      break;
    }
  }
  const clean = cleanOrder(order);
  if (clean.length) return { outcome: "ordered", order: clean, no_buy_reason: null, summary: `سفارش: ${clean.map(line).join("، ")}`, unclear: [] };
  if (/(بعدا|بعداً|دوباره|فردا|هفته بعد|زنگ بزن)/.test(note)) return { outcome: "callback", order: [], no_buy_reason: null, summary: "خواست بعداً تماس بگیریم", unclear: [] };
  if (/(شکایت|ناراضی|مرجوع|خراب|مدیر)/.test(note)) return { outcome: "handoff", order: [], no_buy_reason: note.slice(0, 80), summary: "نیاز به پیگیری سرپرست", unclear: [] };
  return { outcome: "declined", order: [], no_buy_reason: note.slice(0, 80), summary: "خرید نکرد", unclear: [] };
}

export async function extractOutcome(a, note) {
  let out = null;
  if (hasClaude()) {
    out = await askClaude({
      system: `تو دستیار اپراتورهای فروش شرکت «${COMPANY}» هستی. اپراتور بعد از تماس با مغازه‌دار یک یادداشت کوتاه و محاوره‌ای می‌نویسد. تو آن را به نتیجه‌ی ساختاریافته تبدیل می‌کنی تا اپراتور تأیید کند.

${outletContext(a)}

فهرست کالا (فقط این شناسه‌ها معتبرند):
${catalog()}

قواعد:
- outcome: ordered اگر سفارش داد؛ declined اگر نخرید؛ callback اگر خواست بعداً تماس بگیریم؛ handoff اگر شکایت یا مشکلی داشت که سرپرست باید پیگیری کند.
- order: فقط اقلامی که در یادداشت آمده، با شناسه‌ی کالا و تعداد. «مثل همیشه» یعنی سفارش پیشنهادی بالا. حدس نزن.
- no_buy_reason: اگر نخرید، علت را کوتاه بنویس؛ وگرنه null.
- unclear: هر چیزی که مبهم بود (کالای ناموجود در فهرست، تعداد نامشخص) تا اپراتور چک کند.`,
      messages: [{ role: "user", content: `یادداشت اپراتور:\n${note}` }],
      schema: OutcomeSchema,
    });
  }
  const raw = out ?? scriptedExtract(note);
  const order = cleanOrder(raw.order);
  const outcome = raw.outcome === "ordered" && !order.length ? "declined" : raw.outcome;
  return { ...raw, outcome, order, total: orderTotal(order), mode: out ? PROVIDER : "scripted" };
}
