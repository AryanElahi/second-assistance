// «ویزیتور دوم» demo server. No framework: node server.js, then open http://localhost:3000
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { generateData, invoicesToCsv, PRODUCTS } from "./lib/data.js";
import { prioritise, analyseOutlet } from "./lib/priority.js";
import { agentTurn, PROVIDER, MODEL, COMPANY, cleanOrder, orderTotal } from "./lib/agent.js";
import { draftOutreach, extractOutcome } from "./lib/assistant.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const STORE = path.join(here, "data", "store.json");

const data = generateData();
const priority = prioritise(data, 20);
const byId = new Map(data.outlets.map((o) => [o.id, o]));

// follow-up outcomes: { [outletId]: {status, order, total, reason, at} }
let store = {};
try { store = JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { store = {}; }
const save = () => { fs.mkdirSync(path.dirname(STORE), { recursive: true }); fs.writeFileSync(STORE, JSON.stringify(store, null, 2)); };

function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 200_000) req.destroy(); });
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
}

function dashboard() {
  const entries = Object.entries(store);
  const ordered = entries.filter(([, v]) => v.status === "ordered");
  const declined = entries.filter(([, v]) => v.status === "declined");
  const handoff = entries.filter(([, v]) => v.status === "handoff");
  return {
    queue: priority.length,
    followedUp: entries.length,
    orders: ordered.length,
    revenue: ordered.reduce((s, [, v]) => s + v.total, 0),
    declined: declined.length,
    handoff: handoff.length,
    callback: entries.filter(([, v]) => v.status === "callback").length,
    rows: entries.map(([id, v]) => ({ id, name: byId.get(id)?.name, ...v })).sort((a, b) => b.at.localeCompare(a.at)),
  };
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/api/state") {
      return send(res, 200, {
        company: COMPANY, today: data.today, mode: PROVIDER, model: MODEL,
        outlets: data.outlets.length, invoices: data.invoices.length, products: PRODUCTS,
        priority: priority.map((a) => ({ ...a, history: undefined, status: store[a.outlet.id]?.status || null })),
      });
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard") return send(res, 200, dashboard());
    if (req.method === "GET" && url.pathname === "/api/invoices.csv") {
      return send(res, 200, invoicesToCsv(data.invoices, data.outlets), "text/csv; charset=utf-8");
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const { outletId, turns } = await readBody(req);
      const outlet = byId.get(outletId);
      if (!outlet || !Array.isArray(turns) || turns.length > 40) return send(res, 400, { error: "درخواست نامعتبر" });
      const analysis = analyseOutlet(outlet, data.invoices, data.today);
      const turn = await agentTurn(analysis, turns);
      const at = new Date().toISOString();
      if (turn.order_status === "confirmed" && turn.order.length) {
        store[outletId] = { status: "ordered", order: turn.order, total: turn.total, reason: null, at };
        save();
      } else if (turn.handoff) {
        store[outletId] = { status: "handoff", order: [], total: 0, reason: turn.no_buy_reason, at };
        save();
      } else if (turn.no_buy_reason && turn.no_buy_reason !== "در حال پرسیدن" && turn.order_status === "none") {
        store[outletId] = { status: "declined", order: [], total: 0, reason: turn.no_buy_reason, at };
        save();
      }
      return send(res, 200, turn);
    }
    // ----- operator assistant (phase 1) -----
    if (req.method === "POST" && ["/api/draft", "/api/extract", "/api/confirm"].includes(url.pathname)) {
      const body = await readBody(req);
      const outlet = byId.get(body.outletId);
      if (!outlet) return send(res, 400, { error: "درخواست نامعتبر" });
      const analysis = analyseOutlet(outlet, data.invoices, data.today);
      if (url.pathname === "/api/draft") return send(res, 200, await draftOutreach(analysis));
      if (url.pathname === "/api/extract") {
        const note = String(body.note || "").trim().slice(0, 2000);
        if (!note) return send(res, 400, { error: "یادداشت خالی است" });
        return send(res, 200, await extractOutcome(analysis, note));
      }
      // confirm: the operator approved (and may have edited) the extracted result
      const STATUSES = { ordered: "ordered", declined: "declined", callback: "callback", handoff: "handoff" };
      const status = STATUSES[body.outcome];
      if (!status) return send(res, 400, { error: "نتیجه‌ی نامعتبر" });
      const order = status === "ordered" ? cleanOrder(body.order) : [];
      if (status === "ordered" && !order.length) return send(res, 400, { error: "سفارش خالی است" });
      store[outlet.id] = { status, order, total: orderTotal(order), reason: body.no_buy_reason || null, summary: body.summary || null, at: new Date().toISOString(), by: "operator" };
      save();
      return send(res, 200, store[outlet.id]);
    }
    if (req.method === "POST" && url.pathname === "/api/reset") { store = {}; save(); return send(res, 200, { ok: true }); }

    const file = path.join(here, "public", url.pathname === "/" ? "index.html" : url.pathname);
    if (file.startsWith(path.join(here, "public")) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || "application/octet-stream");
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    let msg = err.userMessage || "خطای داخلی";
    if (err instanceof Anthropic.AuthenticationError) msg = "کلید API نامعتبر است";
    else if (err instanceof Anthropic.RateLimitError) msg = "محدودیت تعداد درخواست؛ کمی بعد دوباره امتحان کنید";
    else if (err instanceof Anthropic.APIConnectionError) msg = "اتصال به سرویس مدل برقرار نشد";
    else if (err instanceof Anthropic.APIError) msg = `خطای سرویس مدل (${err.status})`;
    send(res, 500, { error: msg });
  }
});

server.listen(PORT, () => {
  console.log(`ویزیتور دوم: http://localhost:${PORT}  (مدل: ${PROVIDER} ${MODEL})`);
});
