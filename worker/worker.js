/*
 * «Кейсовня» — сервер на Cloudflare Workers + D1 (бесплатный тариф).
 * Делает то же, что server.js на VPS: аккаунты, сохранения, рейтинг, лента дропов, админка.
 *
 * Настройка в панели Cloudflare (Worker → Settings):
 *   Bindings → D1 database: имя переменной DB
 *   Variables:
 *     ALLOWED_ORIGINS = https://ваш-логин.github.io          (адрес сайта; несколько — через запятую)
 *     ADMIN_LOGINS    = admin                                (логины админов через запятую)
 * Таблицы в базе создаются сами при первом запросе.
 */

const LOGIN_RE = /^[A-Za-z0-9_]{3,20}$/;
const SEG_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const TOKEN_RE = /^[a-f0-9]{64}$/;
const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 10000; // укладывается в лимит 10 мс процессора на бесплатном тарифе
const MAX_BODY = 300 * 1024;

const uidOf = login => "u_" + login.toLowerCase();
let counter = 0;
const nextVer = () => Date.now() * 1000 + (counter = (counter + 1) % 1000);
const parentOf = p => p.split("/").slice(0, -1).join("/");

/* ---------------- База D1 ---------------- */
let tablesReady = false;
async function ensureTables(db) {
  if (tablesReady) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, parent TEXT NOT NULL, data TEXT NOT NULL, ver INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS docs_parent ON docs(parent)"),
    db.prepare("CREATE TABLE IF NOT EXISTS colver (parent TEXT PRIMARY KEY, ver INTEGER NOT NULL)")
  ]);
  tablesReady = true;
}
function deepMerge(a, b) {
  if (!a || typeof a !== "object" || Array.isArray(a) || !b || typeof b !== "object" || Array.isArray(b)) return b;
  const out = Object.assign({}, a);
  for (const k of Object.keys(b)) out[k] = deepMerge(a[k], b[k]);
  return out;
}
const store = db => ({
  async get(p) {
    const r = await db.prepare("SELECT data, ver FROM docs WHERE path = ?").bind(p).first();
    return r ? { data: JSON.parse(r.data), ver: Number(r.ver) } : null;
  },
  async set(p, data) {
    const v = nextVer();
    await db.batch([
      db.prepare("INSERT INTO docs(path,parent,data,ver) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data, ver=excluded.ver").bind(p, parentOf(p), JSON.stringify(data), v),
      db.prepare("INSERT INTO colver(parent,ver) VALUES(?,?) ON CONFLICT(parent) DO UPDATE SET ver=excluded.ver").bind(parentOf(p), v)
    ]);
  },
  async del(p) {
    const r = await db.prepare("DELETE FROM docs WHERE path = ?").bind(p).run();
    if (r.meta && r.meta.changes) await db.prepare("INSERT INTO colver(parent,ver) VALUES(?,?) ON CONFLICT(parent) DO UPDATE SET ver=excluded.ver").bind(parentOf(p), nextVer()).run();
  },
  async colVer(parent) {
    const r = await db.prepare("SELECT ver FROM colver WHERE parent = ?").bind(parent).first();
    return r ? Number(r.ver) : 0;
  },
  async list(parent, limit) {
    const r = await db.prepare("SELECT path, data FROM docs WHERE parent = ? ORDER BY path LIMIT ?").bind(parent, limit).all();
    return (r.results || []).map(x => ({ id: x.path.split("/").pop(), data: JSON.parse(x.data) }));
  }
});

/* ---------------- Пароли и сессии ---------------- */
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const randomHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
async function pbkdf2(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, key, 256));
}
function sameHex(a, b) { // сравнение без утечки по времени
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
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

/* ---------------- Правила доступа (как на VPS и claude.ai) ---------------- */
function parsePath(p, wantDoc) {
  if (typeof p !== "string" || p.length > 1000) return null;
  const s = p.split("/");
  if (s.length > 16 || !s.every(x => SEG_RE.test(x) && x !== "." && x !== "..")) return null;
  if (wantDoc ? s.length % 2 !== 0 : s.length % 2 !== 1) return null;
  return s;
}
function canRead(s, uid, owner) {
  if (s[0] === "data" && s[1] === "users") return s[2] === uid;
  if (s[0] === "profiles" || s[0] === "config" || s[0] === "feed") return true;
  if (s[0] === "grants") return owner || (s.length > 1 && s[1] === uid);
  return false;
}
function canWrite(s, uid, owner) {
  if (s[0] === "data" && s[1] === "users") return s.length > 2 && s[2] === uid;
  if (s[0] === "profiles") return s.length > 1 && (owner || s[1] === uid);
  if (s[0] === "config" || s[0] === "grants") return owner;
  return false;
}

/* ---------------- Ограничители ---------------- */
const loginTries = new Map(), writeTries = new Map();
function tooMany(map, key, limit, windowMs) {
  const now = Date.now(), b = map.get(key) || { n: 0, t: now };
  if (now - b.t > windowMs) { b.n = 0; b.t = now; }
  map.set(key, b);
  if (map.size > 5000) map.clear();
  return ++b.n > limit;
}

/* ---------------- HTTP ---------------- */
function corsHeaders(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "").split(/[\s,]+/).filter(Boolean);
  const h = { "Vary": "Origin" };
  if (origin && allowed.includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, PUT, PATCH, DELETE, POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Tg-Init-Data";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    const json = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, cors) });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/api" || url.pathname === "/api/") {
      return json(200, { ok: true, name: "Кейсовня", hint: "Сервер работает. Игра открывается с GitHub Pages." });
    }
    if (!env.DB) return json(500, { error: "База D1 не подключена: добавьте привязку с именем DB" });

    try {
      await ensureTables(env.DB);
      const st = store(env.DB);
      const route = req.method + " " + url.pathname;
      const admins = new Set(String(env.ADMIN_LOGINS || "").split(/[\s,]+/).filter(x => LOGIN_RE.test(x)).map(uidOf));
      const readBody = async limit => {
        const len = Number(req.headers.get("Content-Length") || 0);
        if (len > limit) throw { status: 413 };
        const text = await req.text();
        if (text.length > limit) throw { status: 413 };
        try { return text ? JSON.parse(text) : {}; } catch (e) { throw { status: 400 }; }
      };

      // регистрация и вход: возвращают токен, который сайт хранит у себя
      if (route === "POST /api/register" || route === "POST /api/login") {
        const ip = req.headers.get("CF-Connecting-IP") || "?";
        if (tooMany(loginTries, ip, 10, 60000)) return json(429, { error: "Слишком много попыток. Подождите минуту." });
        const body = await readBody(4096);
        const login = String(body.login || "").trim(), pw = String(body.password || "");
        if (!LOGIN_RE.test(login)) return json(400, { error: "Логин: от 3 до 20 символов — латинские буквы, цифры и _" });
        if (pw.length < 6 || pw.length > 200) return json(400, { error: "Пароль должен быть не короче 6 символов" });
        const key = "accounts/" + login.toLowerCase();
        const acc = await st.get(key);
        if (route === "POST /api/register") {
          if (acc) return json(409, { error: "Такой логин уже занят" });
          const salt = randomHex(16);
          await st.set(key, { login, salt, hash: await pbkdf2(pw, salt), created: Date.now() });
        } else if (!acc || !sameHex(await pbkdf2(pw, acc.data.salt), acc.data.hash)) {
          return json(401, { error: "Неверный логин или пароль" });
        }
        const token = randomHex(32);
        await st.set("sessions/" + token, { uid: uidOf(login), login: acc ? acc.data.login : login, exp: Date.now() + SESSION_DAYS * 864e5 });
        return json(200, { ok: true, token });
      }

      // кто это
      const auth = req.headers.get("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      const sess = TOKEN_RE.test(token) ? await st.get("sessions/" + token) : null;
      if (!sess || sess.data.exp < Date.now()) return json(401, { error: "Войдите в аккаунт" });
      const uid = sess.data.uid, owner = admins.has(uid);

      if (route === "POST /api/logout") { await st.del("sessions/" + token); return json(200, { ok: true }); }
      if (route === "GET /api/me") return json(200, { id: uid, owner, name: sess.data.login });

      if (route === "GET /api/doc") {
        const s = parsePath(url.searchParams.get("path"), true);
        if (!s) return json(400, { error: "Неверный путь" });
        if (!canRead(s, uid, owner)) return json(200, { exists: false });
        const d = await st.get(s.join("/"));
        return json(200, d ? { exists: true, data: d.data, ver: d.ver } : { exists: false });
      }
      if (route === "GET /api/col") {
        const s = parsePath(url.searchParams.get("path"), false);
        if (!s) return json(400, { error: "Неверный путь" });
        if (!canRead(s, uid, owner)) return json(200, { docs: [], ver: 0 });
        const parent = s.join("/");
        const ver = await st.colVer(parent);
        // если список не менялся, не читаем его заново: экономит лимит чтения D1
        if (url.searchParams.get("ver") && url.searchParams.get("ver") === String(ver)) return json(200, { same: true, ver });
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit")) || 1000));
        return json(200, { docs: await st.list(parent, limit), ver });
      }
      if (url.pathname === "/api/doc" && ["PUT", "PATCH", "DELETE"].includes(req.method)) {
        if (tooMany(writeTries, uid, 30, 10000)) return json(429, { error: "Слишком часто" });
        const body = req.method === "DELETE" ? {} : await readBody(MAX_BODY);
        const s = parsePath(req.method === "DELETE" ? url.searchParams.get("path") : body.path, true);
        if (!s) return json(400, { error: "Неверный путь" });
        if (!canWrite(s, uid, owner)) return json(403, { error: "Нет прав" });
        const p = s.join("/");
        if (req.method === "DELETE") {
          await st.del(p);
          if (s[0] === "profiles" && s.length === 2) await updateFeed(st, s[1], null);
          return json(200, { ok: true });
        }
        if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) return json(400, { error: "Нужен объект" });
        if (req.method === "PUT") await st.set(p, body.data);
        else {
          const cur = await st.get(p);
          if (!cur) return json(400, { error: "Документа нет" });
          await st.set(p, deepMerge(cur.data, body.data));
        }
        if (s[0] === "profiles" && s.length === 2) await updateFeed(st, s[1], (await st.get(p) || {}).data);
        return json(200, { ok: true });
      }
      return json(404, { error: "Нет такого адреса" });
    } catch (e) {
      if (e && e.status) return json(e.status, { error: e.status === 413 ? "Слишком большой документ" : "Неверный запрос" });
      const msg = String(e && e.message || e);
      if (/exceeded|limit/i.test(msg)) return json(429, { error: "Дневной лимит бесплатного тарифа исчерпан, попробуйте завтра" });
      return json(500, { error: "Ошибка сервера" });
    }
  }
};

export { canRead, canWrite, parsePath, pbkdf2, sameHex };
