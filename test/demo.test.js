import { test } from "node:test";
import assert from "node:assert/strict";
import { generateData } from "../lib/data.js";
import { prioritise, analyseOutlet } from "../lib/priority.js";
import { cleanOrder, orderTotal, agentTurn } from "../lib/agent.js";

const data = generateData({ today: new Date("2026-11-13T00:00:00Z") });

test("data is deterministic", () => {
  const again = generateData({ today: new Date("2026-11-13T00:00:00Z") });
  assert.equal(again.invoices.length, data.invoices.length);
  assert.deepEqual(again.outlets[5], data.outlets[5]);
});

test("priority list is 20 outlets, ordered by score, each with a reason", () => {
  const top = prioritise(data, 20);
  assert.equal(top.length, 20);
  for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].score >= top[i].score);
  for (const a of top) assert.ok(a.reasons.length > 0 && a.suggested.length > 0);
});

test("lapsed outlets rank above regular buyers", () => {
  const top = prioritise(data, 20);
  const lapsed = top.filter((a) => a.outlet.behaviour === "lapsed").length;
  assert.ok(lapsed >= 10, `only ${lapsed} lapsed outlets in top 20`);
});

test("an outlet that buys on time has no reason to be followed", () => {
  const regular = data.outlets.filter((o) => o.behaviour === "regular")
    .map((o) => analyseOutlet(o, data.invoices, data.today))
    .filter((a) => a && a.daysSince <= a.cycle);
  assert.ok(regular.length > 50);
  assert.ok(regular.every((a) => a.reasons.length === 0 || a.basketChange < -0.25));
});

test("cleanOrder drops unknown products and bad quantities, merges duplicates", () => {
  const order = cleanOrder([
    { productId: "P01", qty: 2 }, { productId: "P01", qty: 1 },
    { productId: "XX", qty: 3 }, { productId: "P02", qty: 0 }, { productId: "P03", qty: 999 },
  ]);
  assert.deepEqual(order, [{ productId: "P01", qty: 3 }]);
  assert.equal(orderTotal(order), 3 * 2_400_000);
});

test("offline agent: proposes, then records an order on yes", async () => {
  const a = prioritise(data, 1)[0];
  const first = await agentTurn(a, []);
  assert.equal(first.order_status, "proposed");
  assert.ok(first.order.length > 0);
  const second = await agentTurn(a, [{ role: "agent", raw: first }, { role: "shop", text: "باشه بفرست" }]);
  assert.equal(second.order_status, "confirmed");
  assert.equal(second.total, first.total);
});

test("offline agent: asks the reason on no, then records it", async () => {
  const a = prioritise(data, 1)[0];
  const first = await agentTurn(a, []);
  const ask = await agentTurn(a, [{ role: "agent", raw: first }, { role: "shop", text: "نه فعلا" }]);
  const done = await agentTurn(a, [{ role: "agent", raw: first }, { role: "shop", text: "نه فعلا" }, { role: "agent", raw: ask }, { role: "shop", text: "قیمت رقیب ارزان‌تره" }]);
  assert.equal(done.no_buy_reason, "قیمت رقیب ارزان‌تره");
  assert.equal(done.order.length, 0);
});
