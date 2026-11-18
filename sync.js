// ============================================================
// 云同步（GitHub 仓库当存储）
// ------------------------------------------------------------
// 思路：本地优先。每次保存先写本地 localStorage，页面立刻有反应；
//      再在后台把整份数据合并后写回仓库，别的设备打开时拉下来合并。
// 冲突：同一条记录谁改得晚谁赢（按 updatedAt 比较）。
// 删除：记一条"墓碑"（id + 删除时间），防止另一台设备把删掉的又同步回来。
// ============================================================

(function () {
  'use strict';

  var CFG = window.NOTES_SYNC || {};
  var TOMB_KEY = 'notes.deleted.v1';
  var BRANCH = 'main';
  var TOMB_KEEP_DAYS = 180;

  var enabled = !!(CFG.owner && CFG.repo && CFG.token);
  var timer = null;
  var busy = false;
  var lastPushed = '';          // 上次成功写入的内容，内容没变就不产生新提交
  var hooks = { get: null, set: null, status: null };

  // ---------- 编码小工具（中文要按 UTF-8 编，不能直接用 btoa） ----------
  function utf8ToBase64(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function base64ToUtf8(b64) {
    var bin = atob(String(b64).replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // ---------- 墓碑（删除标记） ----------
  function loadTombs() {
    try {
      var raw = localStorage.getItem(TOMB_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function saveTombs(list) {
    try {
      localStorage.setItem(TOMB_KEY, JSON.stringify(list));
    } catch (e) { /* 存不下就算了，不影响主流程 */ }
  }

  function pruneTombs(list) {
    var cutoff = new Date(Date.now() - TOMB_KEEP_DAYS * 86400000).toISOString();
    return list.filter(function (t) { return t && t.deletedAt >= cutoff; });
  }

  function markDeleted(id) {
    if (!enabled || !id) return;
    var list = loadTombs().filter(function (t) { return t.id !== id; });
    list.push({ id: id, deletedAt: new Date().toISOString() });
    saveTombs(pruneTombs(list));
    schedule();
  }

  // ---------- 状态回调 ----------
  function say(text, isError) {
    if (typeof hooks.status === 'function') hooks.status(text, !!isError);
  }

  function nowText() {
    var d = new Date();
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getMonth() + 1 + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // ---------- GitHub 读写 ----------
  function apiUrl() {
    return 'https://api.github.com/repos/' + CFG.owner + '/' + CFG.repo +
      '/contents/' + encodeURI((CFG.path || 'records.json'));
  }

  function headers() {
    return {
      'Authorization': 'Bearer ' + CFG.token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async function pullRemote() {
    var r = await fetch(apiUrl() + '?ref=' + BRANCH + '&_=' + Date.now(), {
      headers: headers(),
      cache: 'no-store',
    });
    if (r.status === 404) return { records: [], tombstones: [], sha: null };
    if (r.status === 401) throw new Error('令牌无效或已过期（401）');
    if (r.status === 403) throw new Error('令牌权限不足（403）');
    if (!r.ok) throw new Error('读取失败 HTTP ' + r.status);

    var json = await r.json();
    var text = base64ToUtf8(json.content || '');
    var data = { records: [], tombstones: [] };
    try {
      var parsed = JSON.parse(text);
      if (parsed && Array.isArray(parsed.records)) data.records = parsed.records;
      if (parsed && Array.isArray(parsed.tombstones)) data.tombstones = parsed.tombstones;
    } catch (e) { /* 文件还是空的或者被手动改坏了，当作空数据 */ }
    return { records: data.records, tombstones: data.tombstones, sha: json.sha };
  }

  function merge(localRecords, localTombs, remote) {
    // 墓碑取并集，同一个 id 保留更晚的删除时间
    var tombMap = {};
    (remote.tombstones || []).concat(localTombs || []).forEach(function (t) {
      if (!t || !t.id || !t.deletedAt) return;
      if (!tombMap[t.id] || t.deletedAt > tombMap[t.id]) tombMap[t.id] = t.deletedAt;
    });

    var byId = {};
    (remote.records || []).forEach(function (r) {
      if (r && r.id) byId[r.id] = r;
    });

    (localRecords || []).forEach(function (r) {
      if (!r || !r.id) return;
      var old = byId[r.id];
      if (!old || (r.updatedAt || '') > (old.updatedAt || '')) byId[r.id] = r;
    });

    var out = [];
    Object.keys(byId).forEach(function (id) {
      var r = byId[id];
      if (tombMap[id] && tombMap[id] > (r.updatedAt || '')) return; // 已经删掉的
      out.push(r);
    });

    out.sort(function (a, b) {
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });

    var tombs = [];
    Object.keys(tombMap).forEach(function (id) { tombs.push({ id: id, deletedAt: tombMap[id] }); });

    return { records: out, tombstones: pruneTombs(tombs) };
  }

  async function pushRemote(payload, sha) {
    var text = JSON.stringify({ records: payload.records, tombstones: payload.tombstones }, null, 2);
    if (text === lastPushed) return; // 内容没变化，不产生空提交

    var body = {
      message: '记录同步 ' + nowText(),
      content: utf8ToBase64(text),
      branch: BRANCH,
    };
    if (sha) body.sha = sha;

    var r = await fetch(apiUrl(), {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify(body),
    });

    if (r.status === 409) throw new Error('有别的设备刚好在写，稍后再试');
    if (r.status === 401) throw new Error('令牌无效或已过期（401）');
    if (r.status === 403) throw new Error('令牌权限不足（403）');
    if (!r.ok) throw new Error('写入失败 HTTP ' + r.status);

    lastPushed = text;
  }

  // ---------- 一次完整同步 ----------
  async function sync() {
    if (!enabled) return;
    if (!hooks.get || !hooks.set) return;
    if (busy) return;

    if (!navigator.onLine) {
      say('离线中，等联网后自动同步', false);
      return;
    }

    busy = true;
    say('同步中…', false);

    try {
      var remote = await pullRemote();
      var merged = merge(hooks.get(), loadTombs(), remote);

      saveTombs(merged.tombstones);
      hooks.set(merged.records);          // 交给 main.js：写本地 + 重绘

      await pushRemote(merged, remote.sha);
      say('已同步 · ' + nowText(), false);
    } catch (e) {
      say('同步失败：' + (e && e.message ? e.message : '未知错误'), true);
    } finally {
      busy = false;
    }
  }

  // 防抖：连续多次改动只同步一次
  function schedule(delayMs) {
    if (!enabled) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      sync();
    }, typeof delayMs === 'number' ? delayMs : 4000);
  }

  function init(opts) {
    hooks.get = opts.getRecords;
    hooks.set = opts.setRecords;
    hooks.status = opts.onStatus;

    if (!enabled) {
      say('未开启云同步：只存在这台设备上', false);
      return;
    }

    window.addEventListener('online', function () { schedule(1000); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) schedule(1000);
    });

    schedule(600);                       // 启动后先拉一次
    setInterval(function () {            // 页面开着时每 5 分钟对齐一次
      if (!document.hidden) schedule(0);
    }, 5 * 60 * 1000);
  }

  window.NotesSync = {
    enabled: enabled,
    init: init,
    schedule: schedule,
    markDeleted: markDeleted,
    syncNow: sync,
  };
})();
