/*
 * Сервер «Кейсовни» для Telegram Mini App. Без сторонних пакетов: нужен только Node.js 22+.
 * - отдаёт сайт из папки public
 * - проверяет подпись Telegram (initData) и узнаёт игрока
 * - хранит данные: PostgreSQL (если задан DATABASE_URL и установлен пакет pg),
 *   иначе встроенная SQLite (файл data.sqlite), иначе JSON-файл
 * - при наличии BOT_TOKEN и WEBAPP_URL настраивает кнопку бота и отвечает на /start
 */
"use strict";
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/* ---------------- Настройки из .env ---------------- */
(function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch (e) {}
})();
const {
  BOT_TOKEN = "", WEBAPP_URL = "", DATABASE_URL = "", ADMIN_IDS = "", DEV_USER = "",
  PORT = 3000, HOST = "0.0.0.0", DB_FILE = path.join(__dirname, "data.sqlite"), BUTTON_TEXT = "Играть"
} = process.env;
const ADMINS = new Set(ADMIN_IDS.split(/[\s,]+/).filter(Boolean).map(x => (/^\d+$/.test(x) ? "tg" + x : x)));
const PUBLIC = path.join(__dirname, "public");

/* ---------------- Хранилище ----------------
 * Документ: path (чётное число сегментов), data (JSON), ver (растущий номер версии).
 * У каждой коллекции свой номер версии, чтобы клиент не скачивал неизменившиеся списки. */
let counter = 0;
const nextVer = () => Date.now() * 1000 + (counter = (counter + 1) % 1000);
const parentOf = p => p.split("/").slice(0, -1).join("/");
function deepMerge(a, b) {
  if (!a || typeof a !== "object" || Array.isArray(a) || !b || typeof b !== "object" || Array.isArray(b)) return b;
  const out = Object.assign({}, a);
  for (const k of Object.keys(b)) out[k] = deepMerge(a[k], b[k]);
  return out;
}

function sqliteStore() {
  process.removeAllListeners("warning"); // не пугаем предупреждением «experimental»
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(DB_FILE);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, parent TEXT NOT NULL, data TEXT NOT NULL, ver INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS docs_parent ON docs(parent);
    CREATE TABLE IF NOT EXISTS colver (parent TEXT PRIMARY KEY, ver INTEGER NOT NULL);`);
  const qGet = db.prepare("SELECT data, ver FROM docs WHERE path = ?");
  const qSet = db.prepare("INSERT INTO docs(path,parent,data,ver) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data, ver=excluded.ver");
  const qDel = db.prepare("DELETE FROM docs WHERE path = ?");
  const qList = db.prepare("SELECT path, data FROM docs WHERE parent = ? ORDER BY path LIMIT ?");
  const qTouch = db.prepare("INSERT INTO colver(parent, ver) VALUES(?,?) ON CONFLICT(parent) DO UPDATE SET ver=excluded.ver");
  const qColVer = db.prepare("SELECT ver FROM colver WHERE parent = ?");
  const touch = p => qTouch.run(parentOf(p), nextVer());
  const store = {
    kind: "sqlite (" + path.basename(DB_FILE) + ")",
    async get(p) { const r = qGet.get(p); return r ? { data: JSON.parse(r.data), ver: Number(r.ver) } : null; },
    async set(p, data) { qSet.run(p, parentOf(p), JSON.stringify(data), nextVer()); touch(p); },
    async patch(p, data) { const cur = await store.get(p); if (!cur) return false; await store.set(p, deepMerge(cur.data, data)); return true; },
    async del(p) { if (qDel.run(p).changes) touch(p); },
    async list(parent, limit) {
      const docs = qList.all(parent, limit).map(r => ({ id: r.path.split("/").pop(), data: JSON.parse(r.data) }));
      const v = qColVer.get(parent);
      return { docs, ver: v ? Number(v.ver) : 0 };
    }
  };
  return store;
}

function jsonStore() {
  const file = path.join(__dirname, "data.json");
  let state = { docs: {}, cols: {} };
  try { state = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
  let t = 0;
  const persist = () => { clearTimeout(t); t = setTimeout(() => fs.writeFile(file, JSON.stringify(state), () => {}), 500); };
  const touch = p => { state.cols[parentOf(p)] = nextVer(); persist(); };
  const store = {
    kind: "json (data.json)",
    async get(p) { return state.docs[p] || null; },
    async set(p, data) { state.docs[p] = { data, ver: nextVer() }; touch(p); },
    async patch(p, data) { const cur = state.docs[p]; if (!cur) return false; await store.set(p, deepMerge(cur.data, data)); return true; },
    async del(p) { if (state.docs[p]) { delete state.docs[p]; touch(p); } },
    async list(parent, limit) {
      const docs = Object.keys(state.docs).filter(k => parentOf(k) === parent).sort().slice(0, limit).map(k => ({ id: k.split("/").pop(), data: state.docs[k].data }));
      return { docs, ver: state.cols[parent] || 0 };
    }
  };
  return store;
}

async function pgStore() {
  let Pool;
  try { ({ Pool } = require("pg")); }
  catch (e) { throw new Error("Задан DATABASE_URL, но не установлен пакет pg. Выполните: npm install pg"); }
  const noSsl = /sslmode=disable|@localhost|@127\.0\.0\.1/.test(DATABASE_URL);
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: noSsl ? false : { rejectUnauthorized: false } });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS docs (path text PRIMARY KEY, parent text NOT NULL, data jsonb NOT NULL, ver bigint NOT NULL);
    CREATE INDEX IF NOT EXISTS docs_parent ON docs(parent);
    CREATE TABLE IF NOT EXISTS colver (parent text PRIMARY KEY, ver bigint NOT NULL);`);
  const touch = p => pool.query("INSERT INTO colver(parent, ver) VALUES($1,$2) ON CONFLICT(parent) DO UPDATE SET ver = EXCLUDED.ver", [parentOf(p), nextVer()]);
  const store = {
    kind: "postgres",
    async get(p) { const r = await pool.query("SELECT data, ver FROM docs WHERE path=$1", [p]); return r.rows[0] ? { data: r.rows[0].data, ver: Number(r.rows[0].ver) } : null; },
    async set(p, data) {
      await pool.query("INSERT INTO docs(path,parent,data,ver) VALUES($1,$2,$3,$4) ON CONFLICT(path) DO UPDATE SET data=EXCLUDED.data, ver=EXCLUDED.ver", [p, parentOf(p), JSON.stringify(data), nextVer()]);
      await touch(p);
    },
    async patch(p, data) { const cur = await store.get(p); if (!cur) return false; await store.set(p, deepMerge(cur.data, data)); return true; },
    async del(p) { const r = await pool.query("DELETE FROM docs WHERE path=$1", [p]); if (r.rowCount) await touch(p); },
    async list(parent, limit) {
      const r = await pool.query("SELECT path, data FROM docs WHERE parent=$1 ORDER BY path LIMIT $2", [parent, limit]);
      const v = await pool.query("SELECT ver FROM colver WHERE parent=$1", [parent]);
      return { docs: r.rows.map(x => ({ id: x.path.split("/").pop(), data: x.data })), ver: v.rows[0] ? Number(v.rows[0].ver) : 0 };
    }
  };
  return store;
}

async function openStore() {
  if (DATABASE_URL) return pgStore();
  try { return sqliteStore(); } catch (e) { return jsonStore(); }
}

/* ---------------- Проверка Telegram ----------------
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app */
function checkInitData(initData, botToken = BOT_TOKEN) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheck = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calc = crypto.createHmac("sha256", secret).update(dataCheck).digest("hex");
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const authDate = Number(params.get("auth_date")) || 0;
  if (Date.now() / 1000 - authDate > 7 * 24 * 3600) return null; // подписи старше недели не принимаем
  try { return JSON.parse(params.get("user") || "null"); } catch (e) { return null; }
}

/* ---------------- Правила доступа (те же, что были на claude.ai) ---------------- */
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
function parsePath(p, wantDoc) {
  if (typeof p !== "string" || p.length > 1000) return null;
  const s = p.split("/");
  if (s.length > 16 || !s.every(x => SEG.test(x) && x !== "." && x !== "..")) return null;
  if (wantDoc ? s.length % 2 !== 0 : s.length % 2 !== 1) return null;
  return s;
}
function canRead(s, uid, owner) {
  if (s[0] === "data" && s[1] === "users") return s[2] === uid;        // личные данные — только свои
  if (s[0] === "profiles" || s[0] === "config") return true;            // рейтинг и настройки — всем
  if (s[0] === "grants") return owner || (s.length > 1 && s[1] === uid); // почтовый ящик — свой, админу все
  return false;
}
function canWrite(s, uid, owner) {
  if (s[0] === "data" && s[1] === "users") return s.length > 2 && s[2] === uid;
  if (s[0] === "profiles") return s.length > 1 && (owner || s[1] === uid);
  if (s[0] === "config" || s[0] === "grants") return owner;
  return false;
}

/* ---------------- HTTP ---------------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp" };
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}
function readBody(req, limit = 300 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject({ status: 413 }); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject({ status: 400 }); } });
    req.on("error", () => reject({ status: 400 }));
  });
}
function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  if (pathname === "/" || !path.extname(file)) file = path.join(PUBLIC, "index.html");
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Не найдено"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": file.endsWith("index.html") ? "no-cache" : "public, max-age=3600" });
    res.end(buf);
  });
}

async function main() {
  const store = await openStore();
  const buckets = new Map();
  const tooMany = uid => {
    const now = Date.now(), b = buckets.get(uid) || { n: 0, t: now };
    if (now - b.t > 10000) { b.n = 0; b.t = now; }
    buckets.set(uid, b);
    return ++b.n > 30; // не больше 30 записей за 10 секунд на игрока
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/")) return serveStatic(req, res, url.pathname);
    try {
      // кто это
      const u = checkInitData(req.headers["x-tg-init-data"] || "");
      let uid, name;
      if (u && u.id) { uid = "tg" + u.id; name = u.username || [u.first_name, u.last_name].filter(Boolean).join(" "); }
      else if (DEV_USER) { uid = DEV_USER; name = DEV_USER; }
      else return send(res, 401, { error: "Откройте игру через Telegram" });
      const owner = ADMINS.has(uid);
      const route = req.method + " " + url.pathname;

      if (route === "GET /api/me") return send(res, 200, { id: uid, owner, name: name || "" });

      if (route === "GET /api/doc") {
        const s = parsePath(url.searchParams.get("path"), true);
        if (!s) return send(res, 400, { error: "Неверный путь" });
        if (!canRead(s, uid, owner)) return send(res, 200, { exists: false });
        const d = await store.get(s.join("/"));
        return send(res, 200, d ? { exists: true, data: d.data, ver: d.ver } : { exists: false });
      }
      if (route === "GET /api/col") {
        const s = parsePath(url.searchParams.get("path"), false);
        if (!s) return send(res, 400, { error: "Неверный путь" });
        if (!canRead(s, uid, owner)) return send(res, 200, { docs: [], ver: 0 });
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit")) || 1000));
        return send(res, 200, await store.list(s.join("/"), limit));
      }
      if (url.pathname === "/api/doc" && ["PUT", "PATCH", "DELETE"].includes(req.method)) {
        if (tooMany(uid)) return send(res, 429, { error: "Слишком часто" });
        const body = req.method === "DELETE" ? {} : await readBody(req);
        const s = parsePath(req.method === "DELETE" ? url.searchParams.get("path") : body.path, true);
        if (!s) return send(res, 400, { error: "Неверный путь" });
        if (!canWrite(s, uid, owner)) return send(res, 403, { error: "Нет прав" });
        const p = s.join("/");
        if (req.method === "DELETE") { await store.del(p); return send(res, 200, { ok: true }); }
        if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) return send(res, 400, { error: "Нужен объект" });
        if (req.method === "PUT") await store.set(p, body.data);
        else if (!(await store.patch(p, body.data))) return send(res, 400, { error: "Документа нет" });
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: "Нет такого адреса" });
    } catch (e) {
      if (e && e.status) return send(res, e.status, { error: e.status === 413 ? "Слишком большой документ" : "Неверный запрос" });
      console.error(e);
      return send(res, 500, { error: "Ошибка сервера" });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`Кейсовня: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}  хранилище: ${store.kind}  админы: ${[...ADMINS].join(", ") || "не заданы"}`);
    if (!BOT_TOKEN) console.log("BOT_TOKEN не задан: вход через Telegram работать не будет.");
    if (DEV_USER) console.log(`Режим разработки: запросы без Telegram идут от "${DEV_USER}". Не включайте его на боевом сервере!`);
  });

  if (BOT_TOKEN && WEBAPP_URL) startBot().catch(e => console.error("Бот:", e.message));
}

/* ---------------- Бот: кнопка меню и ответ на /start ---------------- */
async function tgApi(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.description}`);
  return j.result;
}
async function startBot() {
  await tgApi("setChatMenuButton", { menu_button: { type: "web_app", text: BUTTON_TEXT, web_app: { url: WEBAPP_URL } } });
  await tgApi("deleteWebhook", {});
  console.log("Бот: кнопка меню настроена, жду /start");
  let offset = 0;
  for (;;) {
    try {
      const updates = await tgApi("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] });
      for (const u of updates) {
        offset = u.update_id + 1;
        const m = u.message;
        if (m && m.text && m.text.startsWith("/start")) {
          await tgApi("sendMessage", {
            chat_id: m.chat.id,
            text: "Добро пожаловать в Кейсовню! Открывайте кейсы, делайте апгрейды и попадайте в рейтинг. Все деньги и предметы виртуальные.",
            reply_markup: { inline_keyboard: [[{ text: BUTTON_TEXT, web_app: { url: WEBAPP_URL } }]] }
          });
        }
      }
    } catch (e) {
      console.error("Бот:", e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { checkInitData, canRead, canWrite, parsePath };
