const $ = (s) => document.querySelector(s);
const fa = (n) => String(n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
const toman = (n) => `${fa(Math.round(n).toLocaleString("en-US"))} تومان`;
const STATUS = { ordered: "سفارش داد", declined: "نخرید", handoff: "ارجاع به سرپرست", callback: "تماس دوباره" };

let state = null;
let mode = "assist"; // "assist" (phase 1) or "agent" (phase 2)
const drafts = new Map(); // outletId -> {message, talking_points}
const notes = new Map(); // outletId -> operator note
const results = new Map(); // outletId -> extracted outcome awaiting confirmation
let products = new Map();
let current = null; // { a: analysis, turns: [] }
const chats = new Map(); // outletId -> turns
let busy = false;

function el(tag, attrs = {}, text) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

async function load() {
  state = await fetch("/api/state").then((r) => r.json());
  products = new Map(state.products.map((p) => [p.id, p]));
  $("#company").textContent = `شرکت ${state.company} · داده‌ی ساختگی`;
  $("#mode").textContent = state.mode === "claude" ? `مدل: Claude (${state.model})` : state.mode === "kilo" ? `مدل رایگان: ${state.model.split("/").pop()}` : "حالت نمایشی بدون مدل";
  $("#dataline").textContent = `از ${fa(state.outlets)} مغازه و ${fa(state.invoices.toLocaleString("en-US"))} فاکتور ۶ ماه گذشته · امروز ${fa(state.today)}`;
  renderQueue();
}

function renderQueue() {
  const q = $("#queue");
  q.replaceChildren();
  state.priority.forEach((a, i) => {
    const li = el("li");
    if (current?.a.outlet.id === a.outlet.id) li.classList.add("active");
    const top = el("div", { class: "q-top" });
    top.append(el("span", { class: "q-name" }, `${fa(i + 1)}. ${a.outlet.name}`));
    if (a.status) top.append(el("span", { class: `tag ${a.status}` }, STATUS[a.status]));
    li.append(top, el("div", { class: "q-reason" }, a.reasons[0]));
    li.append(el("div", { class: "q-reason" }, `${a.outlet.area} · ارزش ماهانه ${toman(a.monthlyValue)}`));
    li.onclick = () => open(a);
    q.append(li);
  });
}

function open(a) {
  current = { a, turns: chats.get(a.outlet.id) || [] };
  chats.set(a.outlet.id, current.turns);
  $("#chat-empty").hidden = true;
  $("#chat-box").hidden = false;
  $("#chat-title").textContent = `${a.outlet.name} · ${a.outlet.owner}`;
  $("#chat-sub").textContent = `${a.outlet.area} · ${a.outlet.phone} · آخرین خرید ${fa(a.lastDate)}`;
  const why = $("#why");
  why.replaceChildren(...a.reasons.map((r) => el("li", {}, r)),
    el("li", { class: "muted" }, `میانگین سبد اخیر ${toman(a.recentAvg)} (قبلاً ${toman(a.earlierAvg)})`));
  renderQueue();
  showMode();
}

// ---------- mode switch: assistant (phase 1) / autonomous agent (phase 2) ----------
function showMode() {
  document.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $("#assist-view").hidden = mode !== "assist";
  $("#agent-view").hidden = mode !== "agent";
  if (!current) return;
  if (mode === "agent") {
    $("#cart-title").textContent = "سبد فعلی";
    renderMessages();
    const lastAgent = [...current.turns].reverse().find((t) => t.role === "agent");
    renderCart(lastAgent?.raw);
    if (!current.turns.length) step();
    $("#input").focus();
  } else {
    $("#cart-title").textContent = "سفارش پیشنهادی";
    const order = current.a.suggested;
    renderCart({ order, total: order.reduce((s, it) => s + it.qty * products.get(it.productId).price, 0) });
    renderAssist();
  }
}

document.querySelectorAll(".seg-btn").forEach((b) => { b.onclick = () => { mode = b.dataset.mode; showMode(); }; });

function renderAssist() {
  const id = current.a.outlet.id;
  const d = drafts.get(id);
  $("#draft").value = d?.message || "";
  $("#points").replaceChildren(...(d?.talking_points || []).map((p) => el("li", {}, p)));
  $("#note").value = notes.get(id) || "";
  renderResult(results.get(id));
  if (!d) loadDraft();
}

async function api(pathname, body) {
  const res = await fetch(pathname, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || "خطا");
  return json;
}

async function loadDraft() {
  const c = current;
  $("#draft").value = "";
  $("#draft").placeholder = "در حال نوشتن…";
  $("#redraft").disabled = true;
  try {
    const d = await api("/api/draft", { outletId: c.a.outlet.id });
    drafts.set(c.a.outlet.id, d);
    if (current === c) renderAssist();
  } catch (err) {
    $("#draft").placeholder = err.message;
  } finally {
    $("#redraft").disabled = false;
  }
}

$("#redraft").onclick = () => { drafts.delete(current.a.outlet.id); loadDraft(); };
$("#copy").onclick = async () => {
  try { await navigator.clipboard.writeText($("#draft").value); $("#copy").textContent = "کپی شد"; }
  catch { $("#draft").select(); $("#copy").textContent = "انتخاب شد؛ Ctrl+C"; }
  setTimeout(() => { $("#copy").textContent = "کپی"; }, 1500);
};
$("#note").oninput = () => notes.set(current.a.outlet.id, $("#note").value);

$("#extract").onclick = async () => {
  const c = current;
  const note = $("#note").value.trim();
  if (!note) return;
  $("#extract").disabled = true;
  $("#extract").textContent = "در حال خواندن یادداشت…";
  try {
    const r = await api("/api/extract", { outletId: c.a.outlet.id, note });
    results.set(c.a.outlet.id, r);
    if (current === c) renderResult(r);
  } catch (err) {
    alert(err.message);
  } finally {
    $("#extract").disabled = false;
    $("#extract").textContent = "تبدیل به سفارش";
  }
};

function renderResult(r) {
  $("#result").hidden = !r;
  if (!r) return;
  const tag = $("#r-outcome");
  tag.className = `tag ${r.outcome}`;
  tag.textContent = STATUS[r.outcome];
  $("#r-summary").textContent = r.summary;
  const t = $("#r-order");
  t.replaceChildren();
  if (r.outcome === "ordered") {
    const head = el("tr");
    head.append(el("th", {}, "کالا"), el("th", {}, "تعداد"), el("th", {}, "مبلغ"));
    t.append(head);
    for (const it of r.order) {
      const p = products.get(it.productId);
      const tr = el("tr");
      const input = el("input", { type: "number", min: "0", max: "50", class: "qty", "data-pid": it.productId, value: String(it.qty) });
      const cell = el("td");
      cell.append(input);
      tr.append(el("td", {}, `${p.name} (${p.unit})`), cell, el("td", {}, toman(p.price * it.qty)));
      t.append(tr);
    }
    const tot = el("tr", { class: "total" });
    tot.append(el("td", {}, "جمع"), el("td"), el("td", {}, toman(r.total)));
    t.append(tot);
  }
  $("#r-reason-wrap").hidden = r.outcome === "ordered";
  $("#r-reason").value = r.no_buy_reason || "";
  $("#r-unclear").replaceChildren(...(r.unclear || []).map((u) => el("li", {}, `بررسی کنید: ${u}`)));
}

$("#confirm").onclick = async () => {
  const c = current;
  const r = results.get(c.a.outlet.id);
  if (!r) return;
  const order = [...document.querySelectorAll("#r-order .qty")]
    .map((i) => ({ productId: i.dataset.pid, qty: Number(i.value) }))
    .filter((it) => it.qty > 0);
  $("#confirm").disabled = true;
  try {
    await api("/api/confirm", { outletId: c.a.outlet.id, outcome: r.outcome, order, no_buy_reason: $("#r-reason").value || null, summary: r.summary });
    results.delete(c.a.outlet.id);
    notes.delete(c.a.outlet.id);
    if (current === c) { renderAssist(); $("#r-summary").textContent = ""; }
    await refreshStatus();
  } catch (err) {
    alert(err.message);
  } finally {
    $("#confirm").disabled = false;
  }
};

function renderMessages() {
  const box = $("#messages");
  box.replaceChildren();
  for (const t of current.turns) {
    if (t.role === "note") { box.append(el("div", { class: `note ${t.kind}` }, t.text)); continue; }
    const m = el("div", { class: `msg ${t.role}` });
    m.append(el("span", { class: "who" }, t.role === "agent" ? "ویزیتور دوم" : current.a.outlet.owner));
    m.append(document.createTextNode(t.role === "agent" ? t.raw.reply : t.text));
    box.append(m);
  }
  if (busy) box.append(el("div", { class: "msg agent typing" }, "در حال نوشتن…"));
  $("#composer button").disabled = busy;
  box.scrollTop = box.scrollHeight;
}

function renderCart(turn) {
  const t = $("#cart");
  t.replaceChildren();
  const status = $("#cart-status");
  status.className = "pill";
  status.textContent = "";
  if (!turn || !turn.order?.length) { t.append(el("tr", {}, "")); t.rows[0].append(el("td", { class: "muted" }, "سبدی در کار نیست")); return; }
  const head = el("tr");
  head.append(el("th", {}, "کالا"), el("th", {}, "تعداد"), el("th", {}, "مبلغ"));
  t.append(head);
  for (const it of turn.order) {
    const p = products.get(it.productId);
    const tr = el("tr");
    tr.append(el("td", {}, `${p.name} (${p.unit})`), el("td", {}, fa(it.qty)), el("td", {}, toman(p.price * it.qty)));
    t.append(tr);
  }
  const tot = el("tr", { class: "total" });
  tot.append(el("td", {}, "جمع"), el("td"), el("td", {}, toman(turn.total)));
  t.append(tot);
  if (turn.order_status === "confirmed") { status.classList.add("confirmed"); status.textContent = "ثبت شد"; }
  else if (turn.order_status === "proposed") { status.classList.add("proposed"); status.textContent = "پیشنهاد شده، منتظر تأیید"; }
}

async function step() {
  if (busy) return;
  busy = true;
  renderMessages();
  const c = current;
  const turns = c.turns.filter((t) => t.role !== "note").map((t) => (t.role === "agent" ? { role: "agent", raw: t.raw } : { role: "shop", text: t.text }));
  try {
    const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ outletId: c.a.outlet.id, turns }) });
    const turn = await res.json();
    if (!res.ok) throw new Error(turn.error || "خطا");
    const { mode, total, ...raw } = turn;
    c.turns.push({ role: "agent", raw: { ...raw, total } });
    if (turn.order_status === "confirmed" && turn.order.length) c.turns.push({ role: "note", kind: "ordered", text: `سفارش ثبت شد · ${toman(total)}` });
    else if (turn.handoff) c.turns.push({ role: "note", kind: "handoff", text: "به اپراتور انسانی ارجاع شد" });
    else if (turn.no_buy_reason && turn.no_buy_reason !== "در حال پرسیدن" && turn.order_status === "none") c.turns.push({ role: "note", kind: "declined", text: `علت نخریدن ثبت شد: ${turn.no_buy_reason}` });
    if (current === c) renderCart({ ...raw, total });
    await refreshStatus();
  } catch (err) {
    c.turns.push({ role: "note", kind: "error", text: err.message });
  } finally {
    busy = false;
    if (current === c) renderMessages();
  }
}

async function refreshStatus() {
  const s = await fetch("/api/state").then((r) => r.json());
  state.priority = s.priority;
  renderQueue();
}

$("#composer").onsubmit = (e) => {
  e.preventDefault();
  const text = $("#input").value.trim();
  if (!text || !current || busy) return;
  current.turns.push({ role: "shop", text });
  $("#input").value = "";
  step();
};

async function loadDash() {
  const d = await fetch("/api/dashboard").then((r) => r.json());
  $("#k-queue").textContent = fa(d.queue);
  $("#k-followed").textContent = fa(d.followedUp);
  $("#k-orders").textContent = fa(d.orders);
  $("#k-revenue").textContent = toman(d.revenue);
  const t = $("#results");
  t.replaceChildren();
  const head = el("tr");
  head.append(el("th", {}, "مغازه"), el("th", {}, "نتیجه"), el("th", {}, "مبلغ سفارش"), el("th", {}, "علت / توضیح"));
  t.append(head);
  if (!d.rows.length) { const tr = el("tr"); tr.append(el("td", { class: "muted", colspan: "4" }, "هنوز پیگیری‌ای انجام نشده")); t.append(tr); }
  for (const r of d.rows) {
    const tr = el("tr");
    tr.append(el("td", {}, r.name), el("td", {}, STATUS[r.status]), el("td", {}, r.total ? toman(r.total) : "—"), el("td", {}, r.reason || r.summary || "—"));
    t.append(tr);
  }
}

document.querySelectorAll(".tab").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
    $("#view-today").hidden = b.dataset.view !== "today";
    $("#view-dash").hidden = b.dataset.view !== "dash";
    if (b.dataset.view === "dash") loadDash();
  };
});

$("#reset").onclick = async () => {
  await fetch("/api/reset", { method: "POST" });
  chats.clear();
  drafts.clear();
  notes.clear();
  results.clear();
  current = null;
  $("#chat-box").hidden = true;
  $("#chat-empty").hidden = false;
  await refreshStatus();
  loadDash();
};

load();
