/*
 * Сервер «ПиксельДропа» для Telegram Mini App. Без сторонних пакетов: нужен только Node.js 22+.
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
const LOGIN_RE = /^[A-Za-z0-9_]{3,20}$/;
const uidOf = login => "u_" + login.toLowerCase();
// ADMIN_IDS: числа — Telegram ID, слова — логины аккаунтов на сайте
const ADMINS = new Set(ADMIN_IDS.split(/[\s,]+/).filter(Boolean).map(x => (/^\d+$/.test(x) ? "tg" + x : x === DEV_USER ? x : LOGIN_RE.test(x) ? uidOf(x) : x)));
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


/* ---------------- Общая лента дропов ----------------
 * Сервер сам собирает последние дропы всех игроков в один небольшой документ feed/main,
 * чтобы сайт мог часто проверять ленту, не скачивая все профили. */
const FEED_MAX = 40;
async function updateFeed(st, pid, prof) {
  const cur = await st.get("feed/main");
  const items = cur && Array.isArray(cur.data.items) ? cur.data.items : [];
  const mine = [];
  if (prof && Array.isArray(prof.drops)) {
    for (const d of prof.drops.slice(0, 10)) {
      if (!d || typeof d !== "object") continue;
      mine.push({
        pid, nick: String(prof.nick || "").slice(0, 20),
        av: { g: (prof.av && prof.av.g) | 0, c: (prof.av && prof.av.c) | 0 },
        d: { c: String(d.c || "").slice(0, 20), s: d.s | 0, w: d.w | 0, st: !!d.st, price: Number(d.price) || 0, fl: Number(d.fl) || 0, id: String(d.id || "").slice(0, 24), t: Number(d.t) || 0 }
      });
    }
  }
  const before = JSON.stringify(items.filter(x => x.pid === pid));
  const others = items.filter(x => x.pid !== pid);
  const next = others.concat(mine).sort((a, b) => b.d.t - a.d.t).slice(0, FEED_MAX);
  if (before === JSON.stringify(next.filter(x => x.pid === pid)) && next.length === items.length) return; // дропы не менялись — не пишем
  await st.set("feed/main", { items: next });
}


/* ---------------- Батлы кейсов ----------------
 * Все изменения батла идут через сервер: он проверяет очередь игроков и сам выдаёт случайное зерно,
 * из которого у всех игроков одинаково считаются выпавшие предметы. */
const BOT_NAMES = ["Бот Вася", "Бот Шустрый", "Бот Профи", "Бот Удачник", "Бот Сникерс", "Бот Кэп"];
const bhex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, "0")).join("");
async function battleAction(st, uid, owner, b) {
  b = b && typeof b === "object" ? b : {};
  const now = Date.now();
  const nick = String(b.nick || "Игрок").slice(0, 20);
  const av = { g: (b.av && b.av.g) | 0, c: (b.av && b.av.c) | 0 };
  if (b.action === "create") {
    const cases = Array.isArray(b.cases) ? b.cases.slice(0, 8).map(x => String(x)).filter(x => /^[a-z0-9_-]{1,20}$/i.test(x)) : [];
    const size = [2, 3, 4].includes(b.size) ? b.size : 2;
    const cost = Math.round(Number(b.cost));
    if (!cases.length) return { error: "Выберите кейсы" };
    if (!(cost > 0) || cost > 1e9) return { error: "Неверная цена" };
    const all = await st.list("battles", 1000);
    if (all.filter(x => x.data.by === uid && x.data.state === "open").length >= 3) return { error: "У вас уже 3 открытых батла" };
    let cleaned = 0; // старые батлы (старше двух суток) убираем понемногу
    for (const x of all) if (cleaned < 10 && now - (Number(x.data.ts) || 0) > 48 * 3600e3) { await st.del("battles/" + x.id); cleaned++; }
    const id = now.toString(36) + bhex(3);
    const d = { id, by: uid, cases, size, cost, players: [{ pid: uid, nick, av }], state: "open", ts: now };
    await st.set("battles/" + id, d);
    return { battle: d };
  }
  const id = String(b.id || "");
  if (!/^[a-z0-9]{1,40}$/i.test(id)) return { error: "Батл не найден" };
  const cur = await st.get("battles/" + id);
  if (!cur) return { error: "Батл не найден" };
  const d = cur.data;
  if (b.action === "join" || b.action === "bots") {
    if (d.state !== "open") return { error: "Батл уже начался", battle: d };
    if (b.action === "join") {
      if (d.players.some(p => p.pid === uid)) return { error: "Вы уже в этом батле", battle: d };
      d.players.push({ pid: uid, nick, av });
    } else {
      if (d.by !== uid && !owner) return { error: "Позвать ботов может только создатель" };
      let i = 0;
      while (d.players.length < d.size) { i++; d.players.push({ pid: "bot" + d.players.length, nick: BOT_NAMES[(now + i) % BOT_NAMES.length], bot: true, av: { g: (now + i) % 12, c: (now + i * 3) % 8 } }); }
    }
    if (d.players.length >= d.size) { d.state = "done"; d.seed = bhex(8); d.started = now; }
    await st.set("battles/" + id, d);
    return { battle: d };
  }
  if (b.action === "cancel") {
    if (d.by !== uid && !owner) return { error: "Отменить может только создатель" };
    if (d.state !== "open") return { error: "Батл уже начался", battle: d };
    d.state = "cancel"; d.ended = now;
    await st.set("battles/" + id, d);
    return { battle: d };
  }
  return { error: "Неизвестное действие" };
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
  if (s[0] === "profiles" || s[0] === "config" || s[0] === "feed" || s[0] === "battles") return true; // рейтинг, настройки, лента и батлы — всем
  if (s[0] === "grants") return owner || (s.length > 1 && s[1] === uid); // почтовый ящик — свой, админу все
  return false;
}
function canWrite(s, uid, owner) {
  if (s[0] === "data" && s[1] === "users") return s.length > 2 && s[2] === uid;
  if (s[0] === "profiles") return s.length > 1 && (owner || s[1] === uid);
  if (s[0] === "config" || s[0] === "grants") return owner;
  return false;
}

/* ---------------- Аккаунты для обычного сайта ----------------
 * Пароли хранятся как scrypt-хэш с солью. Сессия — случайный токен в HttpOnly-cookie на 30 дней.
 * Документы accounts/* и sessions/* недоступны через API: их читает только сам сервер. */
const SESSION_DAYS = 30;
const SID_RE = /^[a-f0-9]{64}$/;
function hashPassword(pw, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") };
}
function checkPassword(pw, acc) {
  const calc = crypto.scryptSync(pw, acc.salt, 64), saved = Buffer.from(acc.hash, "hex");
  return saved.length === calc.length && crypto.timingSafeEqual(calc, saved);
}
function parseCookies(h) {
  const out = {};
  for (const part of String(h || "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0) { try { out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1)); } catch (e) {} }
  }
  return out;
}
function sessionCookie(req, token, maxAge) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
async function setAccountPassword(store, login, pw) {
  const key = "accounts/" + login.toLowerCase();
  const old = await store.get(key);
  await store.set(key, Object.assign({ login, created: Date.now() }, old ? { login: old.data.login, created: old.data.created } : {}, hashPassword(pw)));
  return !old;
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

  const tries = new Map();
  const tooManyLogins = ip => {
    const now = Date.now(), b = tries.get(ip) || { n: 0, t: now };
    if (now - b.t > 60000) { b.n = 0; b.t = now; }
    tries.set(ip, b);
    return ++b.n > 10; // не больше 10 попыток входа в минуту с одного адреса
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/")) return serveStatic(req, res, url.pathname);
    try {
      const route = req.method + " " + url.pathname;

      // регистрация и вход
      if (route === "POST /api/tgcheck") {
        const body = await readBody(req).catch(() => ({}));
        const channel = String(process.env.TG_CHANNEL || "").trim();
        if (!BOT_TOKEN || !channel) return send(res, 200, { enabled: false });
        const chat = /^-?\d+$/.test(channel) ? channel : "@" + channel.replace(/^@/, "");
        const link = /^-?\d+$/.test(channel) ? "" : "https://t.me/" + chat.slice(1);
        const u = checkInitData(body.initData);
        if (!u || !u.id) return send(res, 200, { enabled: true, ok: false, link, channel: chat, error: "Откройте игру через бота." });
        try {
          const j = await (await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chat)}&user_id=${u.id}`)).json();
          if (!j.ok) return send(res, 200, { enabled: true, ok: true, link, channel: chat, warn: j.description || "ошибка" });
          const st = j.result.status;
          return send(res, 200, { enabled: true, link, channel: chat, ok: st === "creator" || st === "administrator" || st === "member" || (st === "restricted" && j.result.is_member) });
        } catch (e) { return send(res, 200, { enabled: true, ok: true, link, channel: chat, warn: "Telegram недоступен" }); }
      }
      if (route === "POST /api/register" || route === "POST /api/login") {
        const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
        if (tooManyLogins(ip)) return send(res, 429, { error: "Слишком много попыток. Подождите минуту." });
        const body = await readBody(req, 4096);
        const login = String(body.login || "").trim(), pw = String(body.password || "");
        if (!LOGIN_RE.test(login)) return send(res, 400, { error: "Логин: от 3 до 20 символов — латинские буквы, цифры и _" });
        if (pw.length < 6 || pw.length > 200) return send(res, 400, { error: "Пароль должен быть не короче 6 символов" });
        const acc = await store.get("accounts/" + login.toLowerCase());
        if (route === "POST /api/register") {
          if (acc) return send(res, 409, { error: "Такой логин уже занят" });
          await setAccountPassword(store, login, pw);
        } else if (!acc || !checkPassword(pw, acc.data)) {
          return send(res, 401, { error: "Неверный логин или пароль" });
        }
        const token = crypto.randomBytes(32).toString("hex");
        await store.set("sessions/" + token, { uid: uidOf(login), login: acc ? acc.data.login : login, exp: Date.now() + SESSION_DAYS * 864e5 });
        res.setHeader("Set-Cookie", sessionCookie(req, token, SESSION_DAYS * 86400));
        return send(res, 200, { ok: true });
      }
      if (route === "POST /api/logout") {
        const sid = parseCookies(req.headers.cookie).sid;
        if (sid && SID_RE.test(sid)) await store.del("sessions/" + sid);
        res.setHeader("Set-Cookie", sessionCookie(req, "", 0));
        return send(res, 200, { ok: true });
      }

      // кто это: Telegram, аккаунт сайта или режим разработки
      const u = checkInitData(req.headers["x-tg-init-data"] || "");
      let uid, name;
      if (u && u.id) { uid = "tg" + u.id; name = u.username || [u.first_name, u.last_name].filter(Boolean).join(" "); }
      else {
        const sid = parseCookies(req.headers.cookie).sid;
        const sess = sid && SID_RE.test(sid) ? await store.get("sessions/" + sid) : null;
        if (sess && sess.data.exp > Date.now()) { uid = sess.data.uid; name = sess.data.login; }
        else if (DEV_USER) { uid = DEV_USER; name = DEV_USER; }
        else return send(res, 401, { error: "Войдите в аккаунт" });
      }
      const owner = ADMINS.has(uid);

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
      if (route === "POST /api/battle") {
        if (tooMany(uid)) return send(res, 429, { error: "Слишком часто" });
        return send(res, 200, await battleAction(store, uid, owner, await readBody(req)));
      }
      if (url.pathname === "/api/doc" && ["PUT", "PATCH", "DELETE"].includes(req.method)) {
        if (tooMany(uid)) return send(res, 429, { error: "Слишком часто" });
        const body = req.method === "DELETE" ? {} : await readBody(req);
        const s = parsePath(req.method === "DELETE" ? url.searchParams.get("path") : body.path, true);
        if (!s) return send(res, 400, { error: "Неверный путь" });
        if (!canWrite(s, uid, owner)) return send(res, 403, { error: "Нет прав" });
        const p = s.join("/");
        if (req.method === "DELETE") {
          await store.del(p);
          if (s[0] === "profiles" && s.length === 2) await updateFeed(store, s[1], null);
          return send(res, 200, { ok: true });
        }
        if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) return send(res, 400, { error: "Нужен объект" });
        if (req.method === "PUT") await store.set(p, body.data);
        else if (!(await store.patch(p, body.data))) return send(res, 400, { error: "Документа нет" });
        if (s[0] === "profiles" && s.length === 2) await updateFeed(store, s[1], (await store.get(p) || {}).data);
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
    console.log(`ПиксельДроп: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}  хранилище: ${store.kind}  админы: ${[...ADMINS].join(", ") || "не заданы"}`);
    if (!BOT_TOKEN) console.log("Telegram не подключён: вход по логину и паролю.");
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
            text: "Добро пожаловать в ПиксельДроп! Открывайте кейсы, делайте апгрейды и попадайте в рейтинг. Все деньги и предметы виртуальные.",
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

if (require.main === module) {
  if (process.argv[2] === "set-password") {
    // Создать аккаунт или сменить пароль:  PASS=пароль node server.js set-password логин
    (async () => {
      const login = process.argv[3] || "", pw = process.env.PASS || "";
      if (!LOGIN_RE.test(login) || pw.length < 6) {
        console.error("Использование: PASS=пароль node server.js set-password логин\nЛогин: 3–20 символов латиницей, цифры и _. Пароль: от 6 символов.");
        process.exit(1);
      }
      const store = await openStore();
      const created = await setAccountPassword(store, login, pw);
      await new Promise(r => setTimeout(r, 800)); // даём JSON-хранилищу записаться на диск
      console.log((created ? "Аккаунт создан: " : "Пароль обновлён: ") + login);
      process.exit(0);
    })().catch(e => { console.error(e.message); process.exit(1); });
  } else {
    main().catch(e => { console.error(e.message); process.exit(1); });
  }
}
module.exports = { checkInitData, canRead, canWrite, parsePath, hashPassword, checkPassword, parseCookies };
