import { test } from "node:test";
import assert from "node:assert/strict";
import { generateData } from "../lib/data.js";
import { prioritise } from "../lib/priority.js";
import { scriptedExtract, draftOutreach, extractOutcome } from "../lib/assistant.js";

const data = generateData({ today: new Date("2026-11-13T00:00:00Z") });
const a = prioritise(data, 1)[0];

test("draft names the outlet owner and the suggested total", async () => {
  const d = await draftOutreach(a);
  assert.match(d.message, new RegExp(a.outlet.owner));
  assert.ok(d.talking_points.length >= 2);
});

test("extract: numbers in Persian or Latin digits and number words", () => {
  const r = scriptedExtract("گفت ۲ کارتن روغن و یه کیسه برنج بفرستید، ماکارونی هنوز داره");
  assert.equal(r.outcome, "ordered");
  assert.deepEqual(r.order, [{ productId: "P01", qty: 2 }, { productId: "P02", qty: 1 }]);
});

test("extract: 'نه' means no, not nine", () => {
  const r = scriptedExtract("نه، روغن نمی‌خواد، قیمت رقیب ارزان‌تره");
  assert.equal(r.outcome, "declined");
  assert.equal(r.order.length, 0);
});

test("extract: product words inside other words are ignored", () => {
  const r = scriptedExtract("تجربه‌ی بدی با ارسال آبان داشت، ۳ بار دیر رسید");
  assert.notEqual(r.outcome, "ordered");
});

test("extract: callback and handoff", () => {
  assert.equal(scriptedExtract("گفت هفته بعد زنگ بزنید").outcome, "callback");
  assert.equal(scriptedExtract("از جنس خراب قبلی شکایت داشت").outcome, "handoff");
});

test("extractOutcome adds totals and keeps only catalogue products", async () => {
  const r = await extractOutcome(a, "۳ تا چای و ۲ تا نوشابه");
  assert.equal(r.outcome, "ordered");
  assert.equal(r.total, 3 * 2_800_000 + 2 * 420_000);
});
