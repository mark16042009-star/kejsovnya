// Резервная копия базы: node server/backup.mjs база.sqlite копия.sqlite
import { DatabaseSync } from "node:sqlite";
const [src, dst] = process.argv.slice(2);
new DatabaseSync(src).exec("VACUUM INTO '" + dst.replace(/'/g, "''") + "'");
console.log("Копия сохранена: " + dst);
