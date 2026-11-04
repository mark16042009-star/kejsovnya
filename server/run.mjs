// Сервер игры на своём VPS: тот же код, что в Cloudflare Worker (../worker/worker.js),
// а вместо базы D1 — файл SQLite. Нужен Node.js 22.5+ (встроенный node:sqlite), сторонних пакетов нет.
//   node server/run.mjs            — запуск (настройки из /etc/pixeldrop/api.env или .env рядом)
//   node server/run.mjs import F   — загрузить выгрузку базы из Cloudflare (файл JSON)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = path.dirname(fileURLToPath(import.meta.url));
for (const f of ["/etc/pixeldrop/api.env", path.join(here, "..", ".env")]) {
  try {
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch (e) {}
}
const DB_FILE = process.env.DB_FILE || "/var/lib/pixeldrop/db.sqlite";
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
db.exec("CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, parent TEXT NOT NULL, data TEXT NOT NULL, ver INTEGER NOT NULL)");
db.exec("CREATE INDEX IF NOT EXISTS docs_parent ON docs(parent)");
db.exec("CREATE TABLE IF NOT EXISTS colver (parent TEXT PRIMARY KEY, ver INTEGER NOT NULL)");

// ---------- импорт выгрузки из Cloudflare ----------
if (process.argv[2] === "import") {
  const file = process.argv[3];
  const dump = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!dump || !Array.isArray(dump.docs)) { console.error("Это не выгрузка базы ПиксельДропа"); process.exit(1); }
  const put = db.prepare("INSERT OR REPLACE INTO docs (path, parent, data, ver) VALUES (?, ?, ?, ?)");
  const putc = db.prepare("INSERT OR REPLACE INTO colver (parent, ver) VALUES (?, ?)");
  db.exec("BEGIN");
  for (const d of dump.docs) put.run(String(d.path), String(d.parent), typeof d.data === "string" ? d.data : JSON.stringify(d.data), Number(d.ver) || 1);
  for (const c of dump.colver || []) putc.run(String(c.parent), Number(c.ver) || 1);
  db.exec("COMMIT");
  const n = (q) => db.prepare(q).get().n;
  console.log(`Загружено документов: ${dump.docs.length}. Аккаунтов: ${n("SELECT count(*) n FROM docs WHERE parent='accounts'")}, профилей: ${n("SELECT count(*) n FROM docs WHERE parent='profiles'")}.`);
  process.exit(0);
}

// ---------- эмуляция D1 поверх SQLite ----------
class Stmt {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...a) { return new Stmt(this.sql, a); }
  async first() { return db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: db.prepare(this.sql).all(...this.args) }; }
  async run() { const r = db.prepare(this.sql).run(...this.args); return { meta: { changes: Number(r.changes) } }; }
}
const D1 = {
  prepare: sql => new Stmt(sql),
  batch: async stmts => { db.exec("BEGIN"); try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } }
};
const worker = (await import(pathToFileURL(path.join(here, "..", "worker", "worker.js")).href)).default;
const env = Object.assign({}, process.env, { DB: D1 });
const PORT = Number(process.env.PORT || 8787), HOST = process.env.HOST || "127.0.0.1";

http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    // настоящий IP игрока (за Caddy) — для ограничения попыток входа
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    if (ip) headers.set("CF-Connecting-IP", ip);
    const request = new Request("http://" + (req.headers.host || "localhost") + req.url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
    const r = await worker.fetch(request, env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.writeHead(500, { "Content-Type": "application/json" }); res.end('{"error":"Ошибка сервера"}');
  }
}).listen(PORT, HOST, () => console.log(`ПиксельДроп API: http://${HOST}:${PORT}  база: ${DB_FILE}`));
