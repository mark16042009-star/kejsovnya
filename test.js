// Автотесты: подпись Telegram и правила доступа. Запуск: npm test
const assert = require("assert");
const crypto = require("crypto");
const { checkInitData, canRead, canWrite, parsePath } = require("./server.js");

const token = "123:TEST";
function sign(fields, botToken = token) {
  const p = new URLSearchParams(fields);
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  p.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));
  return p.toString();
}
const now = Math.floor(Date.now() / 1000);
const user = JSON.stringify({ id: 42, first_name: "Вася", username: "vasya" });

assert.equal(checkInitData(sign({ user, auth_date: now, query_id: "q" }), token).id, 42, "верная подпись принимается");
assert.equal(checkInitData(sign({ user, auth_date: now }, "999:OTHER"), token), null, "чужой токен отклоняется");
const tampered = sign({ user, auth_date: now }).replace("%D0%92%D0%B0%D1%81%D1%8F", "Hacker");
assert.equal(checkInitData(tampered, token), null, "подделанные данные отклоняются");
assert.equal(checkInitData(sign({ user, auth_date: now - 8 * 24 * 3600 }), token), null, "старая подпись отклоняется");

const P = s => parsePath(s, true), C = s => parsePath(s, false);
assert.ok(canRead(P("profiles/tg1"), "tg2", false), "рейтинг читают все");
assert.ok(!canWrite(P("profiles/tg1"), "tg2", false), "чужой профиль писать нельзя");
assert.ok(canWrite(P("profiles/tg2"), "tg2", false), "свой профиль писать можно");
assert.ok(!canRead(P("data/users/tg1/game"), "tg2", false), "чужие личные данные не читаются");
assert.ok(canWrite(P("data/users/tg2/game"), "tg2", false), "свои личные данные пишутся");
assert.ok(!canWrite(P("config/main"), "tg2", false) && canWrite(P("config/main"), "tg1", true), "настройки меняет только админ");
assert.ok(!canRead(P("grants/tg1"), "tg2", false) && canRead(P("grants/tg2"), "tg2", false), "почтовый ящик — только свой");
assert.ok(!canWrite(P("grants/tg2"), "tg2", false), "себе начислять нельзя");
assert.ok(!canRead(C("grants"), "tg2", false) && canRead(C("grants"), "tg1", true), "список ящиков видит только админ");
assert.equal(P("../etc/passwd"), null, "опасный путь отклоняется");
assert.equal(P("profiles"), null, "коллекция вместо документа отклоняется");
console.log("Все тесты пройдены");
