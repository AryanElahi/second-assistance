// Synthetic data for the demo: products, 200 outlets, ~6 months of invoices.
// Deterministic (seeded) so the demo looks the same on every run.

export const PRODUCTS = [
  { id: "P01", name: "روغن مایع ۱٫۸ لیتری", unit: "کارتن ۶تایی", price: 2_400_000 },
  { id: "P02", name: "برنج ایرانی ۵ کیلویی", unit: "کیسه", price: 1_900_000 },
  { id: "P03", name: "ماکارونی ۵۰۰ گرمی", unit: "کارتن ۲۰تایی", price: 1_100_000 },
  { id: "P04", name: "رب گوجه ۸۰۰ گرمی", unit: "کارتن ۱۲تایی", price: 1_300_000 },
  { id: "P05", name: "مایع ظرفشویی ۱ لیتری", unit: "کارتن ۱۲تایی", price: 950_000 },
  { id: "P06", name: "پودر لباسشویی ۵۰۰ گرمی", unit: "کارتن ۲۴تایی", price: 1_600_000 },
  { id: "P07", name: "شامپو ۴۰۰ میلی‌لیتری", unit: "کارتن ۱۲تایی", price: 1_450_000 },
  { id: "P08", name: "دستمال کاغذی", unit: "کارتن ۱۰تایی", price: 900_000 },
  { id: "P09", name: "نوشابه ۱٫۵ لیتری", unit: "شیرینک ۶تایی", price: 420_000 },
  { id: "P10", name: "آب معدنی ۱٫۵ لیتری", unit: "شیرینک ۶تایی", price: 180_000 },
  { id: "P11", name: "چای ۴۵۰ گرمی", unit: "کارتن ۱۰تایی", price: 2_800_000 },
  { id: "P12", name: "کنسرو تن ماهی", unit: "کارتن ۲۴تایی", price: 3_600_000 },
];

const KINDS = ["سوپرمارکت", "هایپرمارکت", "بقالی", "فروشگاه", "مینی‌مارکت"];
const NAMES = ["رضا", "امید", "ستاره", "بهار", "آفتاب", "نگین", "سعادت", "مهر", "یاس", "پارس", "البرز", "سپید",
  "نیکان", "آرمان", "کوثر", "میلاد", "شقایق", "توحید", "فدک", "رسالت", "صدف", "آسمان", "خلیج", "دماوند", "زاگرس"];
const OWNERS = ["آقای کریمی", "آقای رضایی", "خانم احمدی", "آقای محمدی", "آقای حسینی", "خانم موسوی", "آقای جعفری",
  "آقای صادقی", "خانم رحیمی", "آقای نوری", "آقای قاسمی", "آقای اکبری", "خانم یوسفی", "آقای عباسی"];
const AREAS = ["نارمک", "تهرانپارس", "پیروزی", "نظام‌آباد", "مجیدیه", "شمیران‌نو", "پیروزی", "هفت‌حوض", "وحیدیه", "تهرانپارس"];

const DAY = 86_400_000;

function rng(seed) {
  // mulberry32
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function isoDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}

// behaviour mix: most outlets buy regularly; some lapsed, some declining
export function generateData({ today = new Date(), seed = 1405, outlets: count = 200, days = 180 } = {}) {
  const r = rng(seed);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const start = end - days * DAY;

  const outlets = [];
  const invoices = [];
  let invNo = 1;

  for (let i = 1; i <= count; i++) {
    const id = `S${String(i).padStart(3, "0")}`;
    const roll = r();
    const behaviour = roll < 0.12 ? "lapsed" : roll < 0.22 ? "declining" : "regular";
    const cycle = pick([7, 7, 10, 14]);
    const lines = 2 + Math.floor(r() * 4);
    // each outlet has its own favourite products
    const favourites = [...PRODUCTS].sort(() => r() - 0.5).slice(0, lines + 2).map((p) => p.id);
    const baseQty = 1 + Math.floor(r() * 3);
    outlets.push({
      id,
      name: `${pick(KINDS)} ${pick(NAMES)}`,
      owner: pick(OWNERS),
      area: pick(AREAS),
      phone: `۰۹۱۲‌***‌${String(1000 + Math.floor(r() * 9000)).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d])}`,
      behaviour,
    });

    // lapsed outlets stop 3–6 weeks before today
    const stopAt = behaviour === "lapsed" ? end - (20 + Math.floor(r() * 25)) * DAY : end;
    let t = start + Math.floor(r() * cycle) * DAY;
    while (t <= stopAt) {
      const progress = (t - start) / (end - start); // 0..1
      const shrink = behaviour === "declining" && progress > 0.6 ? 0.45 : 1;
      const items = [];
      for (const pid of favourites.slice(0, lines)) {
        if (r() < 0.8) {
          const qty = Math.max(1, Math.round(baseQty * shrink * (0.7 + r() * 0.6)));
          items.push({ productId: pid, qty });
        }
      }
      if (items.length) {
        const total = items.reduce((s, it) => s + it.qty * PRODUCTS.find((p) => p.id === it.productId).price, 0);
        invoices.push({ id: `F${invNo++}`, outletId: id, date: isoDay(t), items, total });
      }
      const jitter = Math.round((r() - 0.5) * 4);
      t += Math.max(3, cycle + jitter) * DAY;
    }
  }
  return { outlets, invoices, products: PRODUCTS, today: isoDay(end) };
}

export function invoicesToCsv(invoices, outlets) {
  const byId = new Map(outlets.map((o) => [o.id, o]));
  const rows = ["invoice_id,date,outlet_id,outlet_name,product_id,qty"];
  for (const inv of invoices) {
    for (const it of inv.items) {
      rows.push([inv.id, inv.date, inv.outletId, byId.get(inv.outletId).name, it.productId, it.qty].join(","));
    }
  }
  return rows.join("\n");
}
