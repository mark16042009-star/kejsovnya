/*
 * «ПиксельДроп» — сервер на Cloudflare Workers + D1 (бесплатный тариф).
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
  async setIf(p, data, ver) {
    const v = nextVer();
    const r = await db.prepare("UPDATE docs SET data = ?, ver = ? WHERE path = ? AND ver = ?").bind(JSON.stringify(data), v, p, ver).run();
    if (!(r.meta && r.meta.changes)) return false;
    await db.prepare("INSERT INTO colver(parent,ver) VALUES(?,?) ON CONFLICT(parent) DO UPDATE SET ver=excluded.ver").bind(parentOf(p), v).run();
    return true;
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
        d: { c: String(d.c || "").slice(0, 20), s: d.s | 0, w: d.w | 0, st: !!d.st, price: Number(d.price) || 0, fl: Number(d.fl) || 0, id: String(d.id || "").slice(0, 24), t: Number(d.t) || 0, src: ["case", "up", "ct", "bt", "tr"].includes(d.src) ? d.src : "" }
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
    if (!(cost > 0) || cost > 1e15) return { error: "Неверная цена" };
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


/* ---------------- Промокоды ----------------
 * Создаёт и видит промокоды только админ (promos/КОД). Активация идёт через сервер:
 * он проверяет срок, лимит активаций и что игрок ещё не вводил этот код. */
/* ---------------- Лимитированные кейсы ----------------
 * Админ задаёт в config/main → cases[id].limit общий тираж кейса. Счётчик проданных
 * лежит в stock/main → sold[id]; списываем атомарно (setIf), чтобы тираж не превысили. */
async function stockAction(st, uid, b) {
  b = b && typeof b === "object" ? b : {};
  const id = String(b.case || "").slice(0, 20), n = Math.max(1, Math.min(100, Number(b.n) | 0 || 1));
  const cfg = await st.get("config/main");
  const cc = cfg && cfg.data && cfg.data.cases && cfg.data.cases[id];
  const limit = cc ? Math.max(0, Math.floor(Number(cc.limit) || 0)) : 0;
  if (!limit) return { ok: true, unlimited: true };
  const setIf = st.setIf ? (p, d, v) => st.setIf(p, d, v) : async (p, d, v) => { const c = await st.get(p); if (!c || c.ver !== v) return false; await st.set(p, d); return true; };
  for (let i = 0; i < 8; i++) {
    const cur = await st.get("stock/main");
    const d = cur && cur.data && typeof cur.data === "object" ? cur.data : {};
    const soldMap = d.sold && typeof d.sold === "object" ? d.sold : {};
    const sold = Math.max(0, Number(soldMap[id]) || 0), left = limit - sold;
    if (left < n) return { error: left > 0 ? `Осталось только ${left} шт.` : "Кейс распродан", left: Math.max(0, left), limit };
    const next = Object.assign({}, d, { sold: Object.assign({}, soldMap, { [id]: sold + n }) });
    if (!cur) { await st.set("stock/main", next); return { ok: true, left: left - n, limit }; }
    if (await setIf("stock/main", next, cur.ver)) return { ok: true, left: left - n, limit };
  }
  return { error: "Много желающих — попробуйте ещё раз" };
}

async function promoActivate(st, uid, b) {
  const code = String((b && b.code) || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!code) return { error: "Введите промокод" };
  if (!/^[A-Z0-9_-]{2,32}$/.test(code)) return { error: "Такого промокода нет" };
  const cur = await st.get("promos/" + code);
  if (!cur || !cur.data) return { error: "Такого промокода нет" };
  const d = cur.data;
  if (d.off) return { error: "Промокод отключён" };
  if (d.exp && Date.now() > Number(d.exp)) return { error: "Срок действия промокода истёк" };
  const users = Array.isArray(d.users) ? d.users : [];
  if (users.includes(uid)) return { error: "Вы уже активировали этот промокод" };
  if (Number(d.max) > 0 && (Number(d.used) || 0) >= Number(d.max)) return { error: "Промокод закончился" };
  d.used = (Number(d.used) || 0) + 1; users.push(uid); d.users = users;
  await st.set("promos/" + code, d);
  return { ok: true, code, reward: { type: d.type === "case" ? "case" : "money", amount: Math.max(0, Math.round(Number(d.amount) || 0)), caseId: String(d.caseId || ""), count: Math.max(1, Math.min(100, Number(d.count) | 0 || 1)) } };
}


/* режим техработ: читаем config/main не чаще раза в 15 секунд */
let maintCache = { t: 0, on: false };
async function maintOn(st) {
  if (Date.now() - maintCache.t < 15000) return maintCache.on;
  const c = await st.get("config/main");
  maintCache = { t: Date.now(), on: !!(c && c.data && c.data.maint && c.data.maint.on) };
  return maintCache.on;
}

/* ---------------- Реферальная программа ----------------
 * У игрока есть код приглашения (refs/{uid}). Новый игрок, пришедший по ссылке, привязывается к пригласившему
 * (refby/{uid}). Когда приглашённый откроет REF_MIN кейсов, пригласивший получает REF_BONUS через свой почтовый ящик grants. */
const REF_BONUS = 1000000, REF_MIN = 20, REF_NEW_DAYS = 7;
async function grantPush(st, uid, op) {
  const cur = await st.get("grants/" + uid), d = cur && cur.data && typeof cur.data === "object" ? cur.data : {};
  const ops = Array.isArray(d.ops) ? d.ops.slice(-29) : [];
  ops.push(Object.assign({ id: Date.now().toString(36) + randomHex(3), ts: Date.now() }, op));
  await st.set("grants/" + uid, Object.assign({}, d, { ops }));
}
async function refAction(st, uid, login, b, env) {
  b = b && typeof b === "object" ? b : {};
  const bonus = Math.max(0, Number(env && env.REF_BONUS) || REF_BONUS), need = Math.max(1, Number(env && env.REF_MIN) || REF_MIN);
  if (b.action === "claim") {
    const code = String(b.code || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
    if (!code) return { error: "Нет кода" };
    if (await st.get("refby/" + uid)) return { error: "Вы уже пришли по приглашению" };
    const tg = await tgUser(b.initData, String((env && env.BOT_TOKEN) || "").trim());
    if (!tg || !tg.id) return { error: "Приглашения работают только в Telegram" };
    if (await st.get("reftg/" + tg.id)) return { error: "Этот Telegram уже приходил по приглашению" };
    const acc = await st.get("accounts/" + String(login || "").toLowerCase());
    const created = acc && acc.data && Number(acc.data.created) || 0;
    if (!created || Date.now() - created > REF_NEW_DAYS * 864e5) return { error: "Приглашение действует только для новых игроков" };
    const rc = await st.get("refcodes/" + code); const inviter = rc && rc.data && rc.data.uid;
    if (!inviter) return { error: "Приглашение не найдено" };
    if (inviter === uid) return { error: "Нельзя пригласить самого себя" };
    const cur = await st.get("refs/" + inviter), d = cur && cur.data ? cur.data : { code, list: [], earned: 0 };
    if (!Array.isArray(d.list)) d.list = [];
    if (!d.list.some(x => x.uid === uid) && d.list.length < 500) d.list.push({ uid, ts: Date.now(), paid: false });
    await st.set("refs/" + inviter, d);
    await st.set("refby/" + uid, { inviter, ts: Date.now(), tg: tg.id });
    await st.set("reftg/" + tg.id, { uid, ts: Date.now() });
    const p = await st.get("profiles/" + inviter);
    return { ok: true, inviterNick: p && p.data && p.data.nick ? String(p.data.nick).slice(0, 20) : "игрок", need, bonus };
  }
  // info: свой код, список приглашённых; заодно выплачиваем бонусы за тех, кто уже открыл нужное число кейсов
  const cur = await st.get("refs/" + uid);
  const d = cur && cur.data && typeof cur.data === "object" ? cur.data : {};
  if (!d.code) {
    let code = "";
    for (let i = 0; i < 6 && !code; i++) { const c = randomHex(4).slice(0, 7); if (!(await st.get("refcodes/" + c))) code = c; }
    if (!code) return { error: "Попробуйте ещё раз" };
    d.code = code; d.list = []; d.earned = 0;
    await st.set("refcodes/" + code, { uid });
    await st.set("refs/" + uid, d);
  }
  if (!Array.isArray(d.list)) d.list = [];
  let changed = false;
  const out = [];
  for (const x of d.list) {
    const p = await st.get("profiles/" + x.uid), pd = p && p.data || {};
    const opened = Math.max(0, Number(pd.opened) || 0);
    if (!x.paid && opened >= need) {
      x.paid = true; x.paidAt = Date.now(); d.earned = (Number(d.earned) || 0) + bonus; changed = true;
      await grantPush(st, uid, { type: "ref", amount: bonus, nick: String(pd.nick || "друг").slice(0, 20) });
    }
    out.push({ nick: String(pd.nick || "Новый игрок").slice(0, 20), id: x.uid, opened, paid: !!x.paid, ts: x.ts });
  }
  if (changed) await st.set("refs/" + uid, d);
  return { code: d.code, list: out.slice(-100).reverse(), earned: Number(d.earned) || 0, need, bonus };
}

/* ---------------- Трейды между игроками ----------------
 * Предложение обмена: предметы и монеты с обеих сторон. Сервер хранит trades/{id}
 * и следит за состоянием: pending → accepted / declined / canceled (смена только с pending). */
const cleanTradeItems = a => (Array.isArray(a) ? a.slice(0, 20) : []).map(x => x && typeof x === "object" ? {
  id: String(x.id || "").replace(/[^a-z0-9]/gi, "").slice(0, 24), c: String(x.c || "").slice(0, 20), s: x.s | 0, w: x.w | 0,
  fl: Number(x.fl) || 0, st: !!x.st, price: Math.max(0, Math.round(Number(x.price) || 0)) } : null).filter(x => x && x.id && x.c);
/* уведомления о трейдах в Telegram: бот пишет игроку, если тот хоть раз заходил через Telegram */
const fmtCoins = v => Math.round(v).toLocaleString("ru-RU").replace(/\u00a0/g, " ");
const tradeSide = (items, coins) => {
  const p = items.reduce((a, x) => a + (x.price || 0), 0), parts = [];
  if (items.length) parts.push(`${items.length} шт. на ${fmtCoins(p)} монет`);
  if (coins) parts.push(`${fmtCoins(coins)} монет`);
  return parts.join(" + ") || "ничего";
};
async function tgNotify(env, st, uid, text, path) {
  const token = String((env && env.BOT_TOKEN) || "").trim(); if (!token) return;
  try {
    const link = await st.get("tglinks/" + uid); const chat = link && link.data && link.data.tg; if (!chat) return;
    const base = String(env.APP_URL || "https://mark16042009-star.github.io/kejsovnya/").replace(/#.*$/, "");
    const body = { chat_id: chat, text, disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: "Открыть в игре", web_app: { url: base + (path || "") } }]] } };
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) { /* уведомление не обязательно — трейд всё равно создан */ }
}
async function tgLink(env, st, uid, b) {
  const token = String((env && env.BOT_TOKEN) || "").trim(); if (!token) return { ok: false };
  const user = await tgUser(b && b.initData, token);
  if (!user || !user.id) return { ok: false };
  const cur = await st.get("tglinks/" + uid);
  if (!cur || !cur.data || cur.data.tg !== user.id) await st.set("tglinks/" + uid, { tg: user.id, ts: Date.now() });
  return { ok: true };
}
async function tradeAction(st, uid, b, env) {
  b = b && typeof b === "object" ? b : {};
  const now = Date.now();
  const setIf = st.setIf ? (p, d, v) => st.setIf(p, d, v) : async (p, d, v) => { const c = await st.get(p); if (!c || c.ver !== v) return false; await st.set(p, d); return true; };
  if (b.action === "list") {
    const all = await st.list("trades", 1000);
    const mine = all.map(x => x.data).filter(t => t && (t.from === uid || t.to === uid)).sort((a, c) => (c.ts || 0) - (a.ts || 0)).slice(0, 60);
    return { trades: mine };
  }
  if (b.action === "create") {
    const to = String(b.to || "").slice(0, 80);
    if (!to || to === uid) return { error: "Выберите другого игрока" };
    const give = cleanTradeItems(b.give), get = cleanTradeItems(b.get);
    const giveCoins = Math.max(0, Math.min(1e15, Math.round(Number(b.giveCoins) || 0))), getCoins = Math.max(0, Math.min(1e15, Math.round(Number(b.getCoins) || 0)));
    if (!give.length && !get.length && !giveCoins && !getCoins) return { error: "Добавьте предметы или монеты" };
    const all = await st.list("trades", 1000);
    if (all.filter(x => x.data && x.data.from === uid && x.data.state === "pending").length >= 10) return { error: "У вас уже 10 открытых предложений" };
    let cleaned = 0; // старые завершённые трейды (старше 14 дней) убираем понемногу
    for (const x of all) if (cleaned < 10 && x.data && x.data.state !== "pending" && now - (Number(x.data.ts) || 0) > 14 * 864e5) { await st.del("trades/" + x.id); cleaned++; }
    const id = now.toString(36) + [...crypto.getRandomValues(new Uint8Array(3))].map(v => v.toString(16).padStart(2, "0")).join("");
    const t = { id, from: uid, fromNick: String(b.nick || "Игрок").slice(0, 20), to, toNick: String(b.toNick || "Игрок").slice(0, 20),
      give, get, giveCoins, getCoins, msg: String(b.msg || "").slice(0, 120), state: "pending", ts: now };
    await st.set("trades/" + id, t);
    await tgNotify(env, st, to, `🔄 ${t.fromNick} предлагает вам обмен\n\nВы отдаёте: ${tradeSide(get, getCoins)}\nВы получаете: ${tradeSide(give, giveCoins)}${t.msg ? `\nСообщение: «${t.msg}»` : ""}`, "#trade-" + id);
    return { trade: t };
  }
  const id = String(b.id || "");
  if (!/^[a-z0-9]{1,40}$/i.test(id)) return { error: "Трейд не найден" };
  const cur = await st.get("trades/" + id);
  if (!cur) return { error: "Трейд не найден" };
  const t = cur.data;
  const next = { accept: ["to", "accepted"], decline: ["to", "declined"], cancel: ["from", "canceled"] }[b.action];
  if (!next) return { error: "Неизвестное действие" };
  if (t[next[0]] !== uid) return { error: "Нет прав" };
  if (t.state !== "pending") return { error: "Трейд уже закрыт", trade: t };
  t.state = next[1]; t.done = now;
  if (!(await setIf("trades/" + id, t, cur.ver))) { const again = await st.get("trades/" + id); return { error: "Трейд уже закрыт", trade: again && again.data }; }
  if (b.action === "accept") await tgNotify(env, st, t.from, `✅ ${t.toNick} принял ваш обмен — предметы уже ждут вас в инвентаре`, "#trade-" + id);
  if (b.action === "decline") await tgNotify(env, st, t.from, `❌ ${t.toNick} отклонил ваш обмен. Вещи вернутся, когда зайдёте в игру`, "#trade-" + id);
  return { trade: t };
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
  if (s[0] === "profiles" || s[0] === "config" || s[0] === "feed" || s[0] === "battles" || s[0] === "stock") return true;
  if (s[0] === "grants") return owner || (s.length > 1 && s[1] === uid);
  if (s[0] === "promos") return owner;
  return false;
}
function canWrite(s, uid, owner) {
  if (s[0] === "data" && s[1] === "users") return s.length > 2 && s[2] === uid;
  if (s[0] === "profiles") return s.length > 1 && (owner || s[1] === uid);
  if (s[0] === "config" || s[0] === "grants" || s[0] === "promos" || s[0] === "stock") return owner;
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


/* ---------------- Проверка подписки на канал (Telegram) ----------------
 * Сайт присылает initData из Telegram. Проверяем подпись токеном бота (BOT_TOKEN),
 * затем спрашиваем у Telegram, состоит ли игрок в канале TG_CHANNEL. */
async function hmacRaw(key, msg) {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? new TextEncoder().encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}
async function tgUser(initData, token) {
  if (!initData || !token) return null;
  const params = new URLSearchParams(initData), hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheck = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmacRaw("WebAppData", token);
  const calc = [...await hmacRaw(secret, dataCheck)].map(b => b.toString(16).padStart(2, "0")).join("");
  if (calc !== hash) return null;
  if (Date.now() / 1000 - (Number(params.get("auth_date")) || 0) > 7 * 24 * 3600) return null;
  try { return JSON.parse(params.get("user") || "null"); } catch (e) { return null; }
}
async function tgSubscription(env, body) {
  const token = String(env.BOT_TOKEN || "").trim(), channel = String(env.TG_CHANNEL || "").trim();
  if (!token || !channel) return { enabled: false };
  const chat = /^-?\d+$/.test(channel) ? channel : "@" + channel.replace(/^@/, "").replace(/^https?:\/\/t\.me\//, "");
  const link = /^-?\d+$/.test(channel) ? "" : "https://t.me/" + chat.slice(1);
  const user = await tgUser(body && body.initData, token);
  if (!user || !user.id) return { enabled: true, ok: false, link, channel: chat, error: "Не удалось подтвердить вход через Telegram. Откройте игру через бота." };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getChatMember?chat_id=${encodeURIComponent(chat)}&user_id=${user.id}`);
    const j = await r.json();
    if (!j.ok) return { enabled: true, ok: true, link, channel: chat, warn: "Telegram: " + (j.description || "ошибка") + ". Проверьте, что бот — администратор канала." };
    const m = j.result || {}, st = m.status;
    const ok = st === "creator" || st === "administrator" || st === "member" || (st === "restricted" && m.is_member);
    return { enabled: true, ok, link, channel: chat };
  } catch (e) {
    return { enabled: true, ok: true, link, channel: chat, warn: "Telegram недоступен" }; // не блокируем игру из-за сбоя связи
  }
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
      return json(200, { ok: true, name: "ПиксельДроп", hint: "Сервер работает. Игра открывается с GitHub Pages." });
    }
    if (url.pathname === "/api/tgcheck" && req.method === "POST") {
      let body = {};
      try { body = JSON.parse((await req.text()).slice(0, 10000) || "{}"); } catch (e) {}
      return json(200, await tgSubscription(env, body));
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
      // публичный статус: идут ли техработы (нужен и игрокам без входа)
      if (route === "GET /api/status") {
        const c = await st.get("config/main"), m = c && c.data && c.data.maint || {};
        return json(200, { maint: !!m.on, text: String(m.text || "").slice(0, 300) });
      }
      const auth = req.headers.get("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      const sess = TOKEN_RE.test(token) ? await st.get("sessions/" + token) : null;
      if (!sess || sess.data.exp < Date.now()) return json(401, { error: "Войдите в аккаунт" });
      const uid = sess.data.uid, owner = admins.has(uid);

      if (route === "POST /api/logout") { await st.del("sessions/" + token); return json(200, { ok: true }); }
      if (route === "GET /api/me") return json(200, { id: uid, owner, name: sess.data.login });
      // выгрузка всей базы для переезда на свой сервер (только администратор)
      if (route === "GET /api/export") {
        if (!owner) return json(403, { error: "Только для администратора" });
        const docs = (await env.DB.prepare("SELECT path, parent, data, ver FROM docs").all()).results || [];
        const colver = (await env.DB.prepare("SELECT parent, ver FROM colver").all()).results || [];
        return json(200, { v: 1, at: Date.now(), docs, colver });
      }
      if (!owner && req.method !== "GET" && await maintOn(st)) return json(503, { error: "Технические работы. Загляните чуть позже." });

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
      if (route === "POST /api/trade") {
        if (tooMany(writeTries, uid, 30, 10000)) return json(200, { error: "Слишком часто" });
        return json(200, await tradeAction(st, uid, await readBody(MAX_BODY), env));
      }
      if (route === "POST /api/tglink") {
        if (tooMany(writeTries, uid, 10, 60000)) return json(200, { ok: false });
        return json(200, await tgLink(env, st, uid, await readBody(MAX_BODY)));
      }
      if (route === "POST /api/stock") {
        if (tooMany(writeTries, uid, 30, 10000)) return json(200, { error: "Слишком часто" });
        return json(200, await stockAction(st, uid, await readBody(MAX_BODY)));
      }
      if (route === "POST /api/ref") {
        if (tooMany(writeTries, uid, 20, 60000)) return json(200, { error: "Слишком часто" });
        return json(200, await refAction(st, uid, sess.data.login, await readBody(MAX_BODY), env));
      }
      if (route === "POST /api/promo") {
        if (tooMany(writeTries, uid, 10, 60000)) return json(200, { error: "Слишком много попыток, подождите минуту" });
        return json(200, await promoActivate(st, uid, await readBody(MAX_BODY)));
      }
      if (route === "POST /api/battle") {
        if (tooMany(writeTries, uid, 30, 10000)) return json(429, { error: "Слишком часто" });
        return json(200, await battleAction(st, uid, owner, await readBody(MAX_BODY)));
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
