// Priority engine: which outlets to follow up today, and why.
// Demo version is rule-based (explainable); a learned model replaces it once
// real follow-up outcomes exist.

const DAY = 86_400_000;
const fa = (n) => String(n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function analyseOutlet(outlet, invoices, today) {
  const own = invoices.filter((i) => i.outletId === outlet.id).sort((a, b) => a.date.localeCompare(b.date));
  if (own.length < 3) return null;
  const t = (d) => Date.parse(d + "T00:00:00Z");
  const gaps = own.slice(1).map((inv, k) => (t(inv.date) - t(own[k].date)) / DAY);
  const cycle = Math.max(3, Math.round(median(gaps)));
  const daysSince = Math.round((t(today) - t(own.at(-1).date)) / DAY);

  const recent = own.slice(-3);
  const earlier = own.slice(-9, -3);
  const avg = (xs) => xs.reduce((s, i) => s + i.total, 0) / xs.length;
  const recentAvg = avg(recent);
  const earlierAvg = earlier.length ? avg(earlier) : recentAvg;
  const basketChange = earlierAvg ? recentAvg / earlierAvg - 1 : 0; // negative = shrinking

  // monthly value of this outlet when it buys normally
  const monthlyValue = (earlierAvg * 30) / cycle;

  const overdue = Math.max(0, daysSince / cycle - 1); // 0 = on time, 1 = one full cycle late
  const decline = Math.max(0, -basketChange); // 0..1
  // a late outlet and a shrinking outlet are both at risk; take the stronger signal
  const risk = Math.max(Math.min(1, overdue / 2), Math.min(1, decline / 0.5) * 0.6);
  const score = Math.round(risk * monthlyValue);

  const reasons = [];
  if (overdue > 0.3) reasons.push(`${fa(daysSince)} روز است خرید نکرده؛ معمولاً هر ${fa(cycle)} روز می‌خرید`);
  if (basketChange < -0.25) reasons.push(`سبد خرید ${fa(Math.round(-basketChange * 100))}٪ کوچک‌تر شده`);

  // suggested order: the outlet's usual products and quantities
  const counts = new Map();
  for (const inv of own.slice(-6)) {
    for (const it of inv.items) {
      const c = counts.get(it.productId) || { n: 0, qty: 0 };
      c.n += 1; c.qty += it.qty;
      counts.set(it.productId, c);
    }
  }
  const suggested = [...counts.entries()]
    .filter(([, c]) => c.n >= 2)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 4)
    .map(([productId, c]) => ({ productId, qty: Math.max(1, Math.round(c.qty / c.n)) }));

  return {
    outlet, cycle, daysSince, lastDate: own.at(-1).date, invoiceCount: own.length,
    recentAvg: Math.round(recentAvg), earlierAvg: Math.round(earlierAvg), basketChange,
    monthlyValue: Math.round(monthlyValue), risk, score, reasons, suggested,
    history: own.slice(-5),
  };
}

export function prioritise({ outlets, invoices, today }, limit = 20) {
  return outlets
    .map((o) => analyseOutlet(o, invoices, today))
    .filter((a) => a && a.reasons.length)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
