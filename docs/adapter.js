/*
 * Прослойка между игрой и вашим сервером.
 * Игра написана под хранилище claude.ai (window.claude.use("db"/"user")).
 * Здесь то же самое API реализовано через REST-запросы к server.js,
 * а пользователь определяется через Telegram Mini App (initData).
 * На claude.ai этот файл ничего не трогает.
 */
(function () {
  "use strict";
  if (window.claude && typeof window.claude.use === "function") return;

  var tg = window.Telegram && window.Telegram.WebApp;
  var initData = (tg && tg.initData) || "";
  var CFG = window.APP_CONFIG || {};
  var API = CFG.api || "/api";
  // auth: "cookie" — свой сервер (server.js), "token" — Cloudflare Worker на другом адресе
  var AUTH = CFG.auth || "cookie";
  var TOKEN_KEY = "kejsovnya-token";
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; } }
  function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) {} }

  // ---- Оформление внутри Telegram ----
  if (tg) {
    try {
      tg.ready();
      tg.expand();
      if (tg.setHeaderColor) tg.setHeaderColor("#141414");
      if (tg.setBackgroundColor) tg.setBackgroundColor("#141414");
      if (tg.setBottomBarColor) tg.setBottomBarColor("#121212");
      if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
    } catch (e) {}
  }

  // ---- Запросы к серверу ----
  function call(method, url, body) {
    return fetch(API + url, {
      method: method,
      headers: Object.assign({ "Content-Type": "application/json", "X-Tg-Init-Data": initData },
        AUTH === "token" && getToken() ? { "Authorization": "Bearer " + getToken() } : {}),
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      if (r.status === 401 || r.status === 403 || r.status === 400 || r.status === 413) throw { code: "invalid_argument", message: "HTTP " + r.status };
      if (r.status === 429) throw { code: "resource_exhausted", message: "Слишком много запросов" };
      if (!r.ok) throw { code: "unavailable", message: "HTTP " + r.status };
      return r.json();
    }, function () { throw { code: "unavailable", message: "Сервер недоступен" }; });
  }

  var mePromise = null;
  function me() {
    if (!mePromise) mePromise = (AUTH === "token" && !getToken() && !initData) ? Promise.resolve(null)
      : call("GET", "/me").catch(function (e) { if (AUTH === "token" && e && e.code === "invalid_argument") setToken(""); return null; });
    return mePromise;
  }

  // Опрос вместо живой подписки: документы раз в 3 с, коллекции раз в 5 с,
  // плюс сразу после собственной записи.
  var POLL_DOC = CFG.pollDoc || 3000, POLL_COL = CFG.pollCol || 5000;
  var pollers = new Set();
  // пока вкладка свёрнута, не опрашиваем сервер; при возвращении — сразу обновляем
  document.addEventListener("visibilitychange", function () { if (!document.hidden) pollers.forEach(function (p) { p(); }); });
  function bump() { setTimeout(function () { pollers.forEach(function (p) { p(); }); }, 300); }

  function frozen(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function docSnap(path, d) {
    var data = d && d.exists ? frozen(d.data) : undefined;
    return { id: path.split("/").pop(), exists: !!(d && d.exists), data: function () { return data; }, metadata: { fromCache: false, hasPendingWrites: false } };
  }

  function subscribe(load, interval, onData, onError) {
    var stop = false, timer = 0, ver = null, busy = false;
    function tick() {
      if (stop || busy) return;
      if (document.hidden) { clearTimeout(timer); timer = setTimeout(tick, interval); return; }
      busy = true; clearTimeout(timer);
      load().then(function (res) {
        busy = false;
        if (stop) return;
        if (res.ver !== ver) { ver = res.ver; onData(res); }
        timer = setTimeout(tick, interval);
      }, function (e) {
        busy = false;
        if (stop) return;
        if (e && e.code === "invalid_argument") { stop = true; pollers.delete(tick); if (onError) onError(e); return; }
        timer = setTimeout(tick, interval * 2);
      });
    }
    pollers.add(tick);
    tick();
    return function () { stop = true; clearTimeout(timer); pollers.delete(tick); };
  }

  function docRef(path) {
    var q = "/doc?path=" + encodeURIComponent(path);
    return {
      id: path.split("/").pop(),
      path: path,
      get: function () { return call("GET", q).then(function (d) { return docSnap(path, d); }); },
      set: function (data) { return call("PUT", "/doc", { path: path, data: data }).then(function () { bump(); }); },
      update: function (data) { return call("PATCH", "/doc", { path: path, data: data }).then(function () { bump(); }); },
      delete: function () { return call("DELETE", q).then(function () { bump(); }); },
      acquire: function () { return Promise.resolve({ acquired: true }); },
      onSnapshot: function (next, error) {
        return subscribe(function () {
          return call("GET", q).then(function (d) { return { ver: d.exists ? String(d.ver) : "none", d: d }; });
        }, POLL_DOC, function (res) { next(docSnap(path, res.d)); }, error);
      },
      collection: function (sub) { return colRef(path + "/" + sub); }
    };
  }

  function colRef(path, lim) {
    var limit = lim || 1000;
    var lastVer = null, lastSnap = null;
    function load(useVer) {
      var q = "/col?path=" + encodeURIComponent(path) + "&limit=" + limit + (useVer && lastVer ? "&ver=" + encodeURIComponent(lastVer) : "");
      return call("GET", q).then(function (r) {
        if (r.same && lastSnap) return { ver: String(r.ver), snap: lastSnap };
        var docs = (r.docs || []).map(function (x) { return docSnap(path + "/" + x.id, { exists: true, data: x.data }); });
        lastVer = String(r.ver);
        lastSnap = { docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return []; }, metadata: { fromCache: false, hasPendingWrites: false } };
        return { ver: lastVer, snap: lastSnap };
      });
    }
    var q = {
      path: path,
      doc: function (id) { return docRef(path + "/" + (id || Math.random().toString(36).slice(2, 12))); },
      add: function (data) { var d = q.doc(); return d.set(data).then(function () { return d; }); },
      limit: function (n) { return colRef(path, n); },
      orderBy: function () { return q; },
      where: function () { return q; },
      get: function () { return load(false).then(function (r) { return r.snap; }); },
      onSnapshot: function (next, error) { return subscribe(function () { return load(true); }, POLL_COL, function (r) { next(r.snap); }, error); }
    };
    return q;
  }

  var db = { doc: docRef, collection: function (p) { return colRef(p); } };
  var user = {
    id: function () { return me().then(function (m) { return m ? m.id : null; }); },
    isOwner: function () { return me().then(function (m) { return !!(m && m.owner); }); },
    canEdit: function () { return me().then(function (m) { return !!(m && m.owner); }); },
    can: function () { return null; },
    me: function () { return me().then(function (m) { return { id: m && m.id, name: (m && m.name) || "" }; }); },
    profiles: function () { return Promise.resolve({}); }
  };

  window.claude = {
    use: function (name) {
      return me().then(function (m) {
        if (!m) return null;                 // не вошёл в аккаунт: игра работает локально в этом браузере
        if (name === "db") return db;
        if (name === "user") return user;
        return null;
      });
    }
  };

  /* ---------------- Вход по логину и паролю (обычный сайт) ---------------- */
  if (initData) return; // в Telegram вход автоматический
  var LOCAL_KEY = "kejsovnya-rub-v1";
  window.APP_CONFIG = Object.assign({}, window.APP_CONFIG, {
    localNote: "Вы играете без аккаунта: прогресс хранится только в этом браузере. Войдите или зарегистрируйтесь, чтобы сохранить его и попасть в рейтинг.",
    topNote: "Рейтинг видят все, а попадают в него игроки с аккаунтом. Войдите или зарегистрируйтесь — текущий прогресс перенесётся."
  });

  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (html) e.innerHTML = html;
    return e;
  }

  function openAuth(mode) {
    var old = document.getElementById("auth-ov"); if (old) old.remove();
    var ov = el("div", { id: "auth-ov", class: "overlay show", role: "dialog", "aria-modal": "true", "aria-labelledby": "auth-title" });
    ov.innerHTML =
      '<form class="modal auth" id="auth-form" novalidate>' +
        '<div class="tabs auth-tabs" role="tablist">' +
          '<button type="button" role="tab" data-m="login">Вход</button>' +
          '<button type="button" role="tab" data-m="register">Регистрация</button>' +
        '</div>' +
        '<h2 id="auth-title"></h2>' +
        '<p class="hint" id="auth-sub"></p>' +
        '<label class="auth-f" for="auth-login">Логин<input id="auth-login" name="login" autocomplete="username" maxlength="20" required></label>' +
        '<label class="auth-f" for="auth-pass">Пароль<input id="auth-pass" name="password" type="password" maxlength="200" required></label>' +
        '<label class="auth-f" id="auth-pass2-row" for="auth-pass2">Пароль ещё раз<input id="auth-pass2" type="password" maxlength="200" autocomplete="new-password"></label>' +
        '<p class="hint err" id="auth-err" role="alert"></p>' +
        '<div class="modal-actions"><button type="button" class="btn" id="auth-cancel">Отмена</button><button type="submit" class="btn primary" id="auth-go"></button></div>' +
      '</form>';
    document.body.appendChild(ov);
    var f = ov.querySelector("form"), err = ov.querySelector("#auth-err");
    function setMode(m) {
      mode = m;
      ov.querySelectorAll("[data-m]").forEach(function (b) { b.classList.toggle("on", b.dataset.m === m); b.setAttribute("aria-selected", b.dataset.m === m); });
      ov.querySelector("#auth-title").textContent = m === "login" ? "Вход в аккаунт" : "Новый аккаунт";
      ov.querySelector("#auth-sub").textContent = m === "login"
        ? "Прогресс подтянется из аккаунта на любом устройстве."
        : "Ваш текущий прогресс из этого браузера перенесётся в аккаунт.";
      ov.querySelector("#auth-go").textContent = m === "login" ? "Войти" : "Создать аккаунт";
      ov.querySelector("#auth-pass").setAttribute("autocomplete", m === "login" ? "current-password" : "new-password");
      ov.querySelector("#auth-pass2-row").hidden = m === "login";
      err.textContent = "";
    }
    ov.querySelectorAll("[data-m]").forEach(function (b) { b.addEventListener("click", function () { setMode(b.dataset.m); }); });
    function close() { ov.remove(); }
    ov.querySelector("#auth-cancel").addEventListener("click", close);
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    ov.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var login = f.login.value.trim(), pass = f.password.value;
      if (!/^[A-Za-z0-9_]{3,20}$/.test(login)) { err.textContent = "Логин: от 3 до 20 символов — латинские буквы, цифры и _"; return; }
      if (pass.length < 6) { err.textContent = "Пароль должен быть не короче 6 символов"; return; }
      if (mode === "register" && pass !== ov.querySelector("#auth-pass2").value) { err.textContent = "Пароли не совпадают"; return; }
      var go = ov.querySelector("#auth-go"); go.disabled = true; err.textContent = "";
      fetch(API + "/" + mode, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: AUTH === "token" ? "omit" : "same-origin", body: JSON.stringify({ login: login, password: pass }) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (r) {
          if (!r.ok) { go.disabled = false; err.textContent = (r.j && r.j.error) || "Не получилось, попробуйте ещё раз"; return; }
          if (AUTH === "token") setToken(r.j && r.j.token);
          if (mode === "login") { try { localStorage.removeItem(LOCAL_KEY); } catch (x) {} } // при входе берём прогресс из аккаунта
          location.reload();
        }, function () { go.disabled = false; err.textContent = "Нет связи с сервером"; });
    });
    setMode(mode || "login");
    setTimeout(function () { f.login.focus(); }, 30);
  }

  function logout() {
    fetch(API + "/logout", { method: "POST", headers: AUTH === "token" && getToken() ? { "Authorization": "Bearer " + getToken() } : {} }).catch(function () {}).finally(function () {
      setToken("");
      try { localStorage.removeItem(LOCAL_KEY); } catch (x) {}
      try { history.replaceState(null, "", location.pathname + "#cases"); } catch (x) {}
      location.reload();
    });
  }

  function mountAuthUI() {
    var css = el("style", {}, "");
    css.textContent =
      ".auth{max-width:400px;gap:12px}.auth-tabs{width:100%;display:grid;grid-template-columns:1fr 1fr}" +
      ".auth-f{display:grid;gap:6px;font-size:13px;color:var(--muted);font-weight:700}" +
      ".auth-f input{background:var(--panel2);border:1px solid var(--line);color:var(--text);padding:11px 12px;border-radius:10px;font:inherit;font-size:16px}" +
      ".auth-f[hidden]{display:none}#auth-err:empty{display:none}" +
      ".auth-btn{padding:7px 14px}.acc-line{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:6px}" +
      ".acc-line button{background:none;border:0;padding:0;color:var(--accent);text-decoration:underline;font:inherit;cursor:pointer}";
    document.head.appendChild(css);
    var right = document.querySelector(".right"), foot = document.querySelector("footer");
    me().then(function (m) {
      if (!m) {
        var b = el("button", { class: "btn primary auth-btn", type: "button", id: "auth-open" });
        b.textContent = "Войти";
        b.addEventListener("click", function () { openAuth("login"); });
        if (right) right.insertBefore(b, right.firstChild);
        if (foot) {
          var line = el("p", { class: "acc-line" });
          line.innerHTML = '<span>Вы играете без аккаунта.</span><button type="button" data-a="register">Зарегистрироваться</button><button type="button" data-a="login">Войти</button>';
          line.querySelectorAll("[data-a]").forEach(function (x) { x.addEventListener("click", function () { openAuth(x.dataset.a); }); });
          foot.appendChild(line);
        }
      } else if (foot) {
        var line2 = el("p", { class: "acc-line" });
        line2.innerHTML = '<span></span><button type="button">Выйти</button>';
        line2.querySelector("span").textContent = "Вы вошли как " + (m.name || "игрок") + ".";
        line2.querySelector("button").addEventListener("click", logout);
        foot.appendChild(line2);
      }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountAuthUI); else mountAuthUI();
})();
