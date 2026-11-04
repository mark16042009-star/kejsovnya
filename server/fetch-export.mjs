// Скачивает всю базу из старого сервера (Cloudflare Worker) по логину администратора.
//   OLD_API=https://…/api ADM_LOGIN=… ADM_PASS=… node server/fetch-export.mjs файл.json
import fs from "node:fs";
const api = String(process.env.OLD_API || "").replace(/\/$/, ""), out = process.argv[2];
const r1 = await fetch(api + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ login: process.env.ADM_LOGIN, password: process.env.ADM_PASS }) });
const j1 = await r1.json().catch(() => ({}));
if (!j1.token) { console.error("Не удалось войти: " + (j1.error || r1.status)); process.exit(1); }
const r2 = await fetch(api + "/export", { headers: { Authorization: "Bearer " + j1.token } });
const j2 = await r2.json().catch(() => ({}));
if (!Array.isArray(j2.docs)) { console.error("Выгрузка не получилась: " + (j2.error || r2.status) + ". Обновите Worker в Cloudflare до последней версии."); process.exit(1); }
fs.writeFileSync(out, JSON.stringify(j2));
await fetch(api + "/logout", { method: "POST", headers: { Authorization: "Bearer " + j1.token } }).catch(() => {});
console.log(`Скачано документов: ${j2.docs.length}`);
