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
  var API = (window.APP_CONFIG && window.APP_CONFIG.api) || "/api";

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
      headers: { "Content-Type": "application/json", "X-Tg-Init-Data": initData },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      if (r.status === 401 || r.status === 403 || r.status === 400 || r.status === 413) throw { code: "invalid_argument", message: "HTTP " + r.status };
      if (r.status === 429) throw { code: "resource_exhausted", message: "Слишком много запросов" };
      if (!r.ok) throw { code: "unavailable", message: "HTTP " + r.status };
      return r.json();
    }, function () { throw { code: "unavailable", message: "Сервер недоступен" }; });
  }

  var mePromise = null;
  function me() { return mePromise || (mePromise = call("GET", "/me").catch(function () { return null; })); }

  // Опрос вместо живой подписки: документы раз в 3 с, коллекции раз в 5 с,
  // плюс сразу после собственной записи.
  var POLL_DOC = 3000, POLL_COL = 5000;
  var pollers = new Set();
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
    function load() {
      return call("GET", "/col?path=" + encodeURIComponent(path) + "&limit=" + limit).then(function (r) {
        var docs = r.docs.map(function (x) { return docSnap(path + "/" + x.id, { exists: true, data: x.data }); });
        return { ver: String(r.ver), snap: { docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return []; }, metadata: { fromCache: false, hasPendingWrites: false } } };
      });
    }
    var q = {
      path: path,
      doc: function (id) { return docRef(path + "/" + (id || Math.random().toString(36).slice(2, 12))); },
      add: function (data) { var d = q.doc(); return d.set(data).then(function () { return d; }); },
      limit: function (n) { return colRef(path, n); },
      orderBy: function () { return q; },
      where: function () { return q; },
      get: function () { return load().then(function (r) { return r.snap; }); },
      onSnapshot: function (next, error) { return subscribe(load, POLL_COL, function (r) { next(r.snap); }, error); }
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
        if (!m) return null;                 // не в Telegram и не в режиме разработки: игра работает локально
        if (name === "db") return db;
        if (name === "user") return user;
        return null;
      });
    }
  };
})();
