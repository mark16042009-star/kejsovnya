// Настройки сайта на GitHub Pages.
// api — адрес вашего Cloudflare Worker'а с /api на конце.
// Пока адрес не вписан (или Worker недоступен), игра работает локально в браузере.
window.APP_CONFIG = {
  api: "https://hidden-union-e818.mark16042009.workers.dev/api",
  auth: "token",
  pollDoc: 60000,   // настройки и начисления админа — раз в минуту
  pollCol: 30000,   // рейтинг — раз в 30 секунд
  pollFeed: 6000,   // лента дропов — раз в 6 секунд (пока вкладка открыта)
  bot: "CasovnyaSimulatorBot", // имя бота без @
  tgApp: ""         // короткое имя приложения из BotFather (/newapp), если ссылки t.me/бот?startapp не открываются
};
