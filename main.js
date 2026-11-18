// 我的记录本 —— 全部使用原生 JS，不依赖任何框架或第三方库
//
// 代码结构（后面加功能照着这里的位置加）：
//   1. 存储层：读写 localStorage、数据规范化
//   2. 标签：常用标签、编辑中的标签、标签分类配色
//   3. 评分：五颗星的渲染与取值
//   4. 表单：新建 / 编辑同一条记录
//   5. 列表：渲染、搜索、按标签筛选、删除、编辑入口
//   6. 回顾：随机翻旧记录、按周/月/更早筛选、按月分组
//   7. 备份：导出 / 导入 JSON
//   8. 离线可用（PWA）：注册 sw.js、安装按钮
//   9. 云同步接入：把本地数据交给 sync.js，由它和 GitHub 仓库对齐
//   10. 启动

(function () {
  'use strict';

  // ================= 1. 存储层 =================
  var STORAGE_KEY = 'notes.records.v1';
  var MAX_TAGS = 8;

  var state = {
    records: [],      // [{ id, title, note, tags, rating, quote, source, createdAt, updatedAt }]
    editingTags: [],  // 表单里正在编辑的标签
    draftRating: 0,   // 表单里选中的星级
    editingId: null,  // 正在编辑的记录 id；null 表示新建
    keyword: '',      // 搜索关键词
    activeTag: null,  // 当前筛选的标签
    rangeFilter: null, // 时间筛选：'week' / 'month' / 'older' / null
    monthFilter: null, // 按月份筛选：'YYYY-MM' / null
    reviewPickId: null, // 回顾卡片当前显示的那条记录 id
    modalPickId: null,  // 弹层里正在显示的那条记录 id
  };

  function loadRecords() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isValidRecord).map(normalizeRecord);
    } catch (e) {
      console.warn('读取本地记录失败：', e);
      return [];
    }
  }

  function isValidRecord(item) {
    return item && typeof item === 'object' && typeof item.title === 'string' && item.title.trim();
  }

  function normalizeRecord(item) {
    var rating = Number(item.rating);
    return {
      id: item.id || makeId(),
      title: String(item.title).trim(),
      note: typeof item.note === 'string' ? item.note : '',
      tags: Array.isArray(item.tags)
        ? item.tags.filter(function (t) { return typeof t === 'string' && t; }).slice(0, MAX_TAGS)
        : [],
      rating: rating >= 1 && rating <= 5 ? Math.round(rating) : 0,
      quote: typeof item.quote === 'string' ? item.quote : '',
      source: typeof item.source === 'string' ? item.source : '',
      createdAt: item.createdAt || new Date().toISOString(),
      updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
    };
  }

  function saveRecords() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.records));
      return true;
    } catch (e) {
      console.warn('写入本地记录失败：', e);
      showMsg('form-msg', '保存失败：浏览器存储空间可能已满', true);
      return false;
    }
  }

  function makeId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ================= 2. 标签 =================
  // 常用标签：类型 / 情绪 / 用途三组，点一下就加进去
  var QUICK_TAG_GROUPS = [
    { label: '类型', kind: 'type', tags: ['剧', '歌', '文章'] },
    { label: '情绪', kind: 'mood', tags: ['震撼', '治愈', '烧脑', '压抑', '好笑', '上头'] },
    { label: '用途', kind: 'use', tags: ['想再看一遍', '想推荐', '当素材'] },
  ];

  // 标签 -> 分类，用来给标签上不同颜色
  var TAG_KIND = {};
  QUICK_TAG_GROUPS.forEach(function (group) {
    group.tags.forEach(function (tag) { TAG_KIND[tag] = group.kind; });
  });

  function tagClass(tag) {
    var kind = TAG_KIND[tag];
    return kind ? 'tag-mini tag-' + kind : 'tag-mini';
  }

  function renderQuickTags() {
    var box = document.getElementById('quick-tags');
    if (!box) return;
    box.innerHTML = '';

    QUICK_TAG_GROUPS.forEach(function (group) {
      var wrap = document.createElement('div');
      wrap.className = 'quick-group';

      var label = document.createElement('span');
      label.className = 'quick-group-label';
      label.textContent = group.label;
      wrap.appendChild(label);

      var list = document.createElement('div');
      list.className = 'quick-list';

      group.tags.forEach(function (tag) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'quick-btn';
        btn.textContent = tag;
        btn.dataset.tag = tag;
        btn.addEventListener('click', function () { toggleEditingTag(tag); });
        list.appendChild(btn);
      });

      wrap.appendChild(list);
      box.appendChild(wrap);
    });
  }

  function toggleEditingTag(tag) {
    var idx = state.editingTags.indexOf(tag);
    if (idx >= 0) {
      state.editingTags.splice(idx, 1);
    } else {
      if (state.editingTags.length >= MAX_TAGS) {
        showMsg('form-msg', '标签最多 ' + MAX_TAGS + ' 个', true);
        return;
      }
      state.editingTags.push(tag);
    }
    renderTagEditor();
  }

  function addEditingTag(raw) {
    var tag = String(raw).replace(/[,，]/g, '').trim();
    if (!tag) return;
    if (state.editingTags.indexOf(tag) >= 0) return;
    if (state.editingTags.length >= MAX_TAGS) {
      showMsg('form-msg', '标签最多 ' + MAX_TAGS + ' 个', true);
      return;
    }
    state.editingTags.push(tag);
    renderTagEditor();
  }

  function renderTagEditor() {
    var editor = document.getElementById('tag-editor');
    var input = document.getElementById('f-tag');
    if (!editor || !input) return;

    Array.prototype.slice.call(editor.querySelectorAll('.chip')).forEach(function (el) {
      el.remove();
    });

    state.editingTags.forEach(function (tag) {
      var chip = document.createElement('span');
      chip.className = 'chip';
      chip.appendChild(document.createTextNode(tag));

      var x = document.createElement('button');
      x.type = 'button';
      x.setAttribute('aria-label', '移除标签 ' + tag);
      x.textContent = '×';
      x.addEventListener('click', function () {
        state.editingTags = state.editingTags.filter(function (t) { return t !== tag; });
        renderTagEditor();
      });

      chip.appendChild(x);
      editor.insertBefore(chip, input);
    });

    Array.prototype.slice.call(document.querySelectorAll('.quick-btn')).forEach(function (btn) {
      btn.classList.toggle('is-on', state.editingTags.indexOf(btn.dataset.tag) >= 0);
    });
  }

  // ================= 3. 评分 =================
  var STAR_PATH = 'M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5-4.7-4.6 6.5-.9z';

  function starSvg() {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');

    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', STAR_PATH);
    path.setAttribute('class', 'star-path');
    svg.appendChild(path);
    return svg;
  }

  function renderRating() {
    var box = document.getElementById('rating');
    if (!box) return;
    box.innerHTML = '';

    for (var i = 1; i <= 5; i++) {
      (function (value) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'star-btn' + (value <= state.draftRating ? ' is-on' : '');
        btn.setAttribute('aria-label', value + ' 星');
        btn.setAttribute('aria-pressed', value <= state.draftRating ? 'true' : 'false');
        btn.appendChild(starSvg());
        btn.addEventListener('click', function () {
          // 再点一次同一颗，归零
          state.draftRating = state.draftRating === value ? 0 : value;
          renderRating();
        });
        box.appendChild(btn);
      })(i);
    }
  }

  // ================= 4. 表单：新建 / 编辑 =================
  function initForm() {
    var form = document.getElementById('record-form');
    var tagInput = document.getElementById('f-tag');
    var clearBtn = document.getElementById('clear-btn');
    var cancelBtn = document.getElementById('cancel-edit');
    if (!form || !tagInput) return;

    // 标签输入：回车 / 逗号提交
    tagInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
        e.preventDefault();
        addEditingTag(tagInput.value);
        tagInput.value = '';
      } else if (e.key === 'Backspace' && tagInput.value === '' && state.editingTags.length) {
        state.editingTags.pop();
        renderTagEditor();
      }
    });

    tagInput.addEventListener('input', function () {
      if (/[,，]/.test(tagInput.value)) {
        tagInput.value.split(/[,，]/).forEach(addEditingTag);
        tagInput.value = '';
      }
    });

    tagInput.addEventListener('blur', function () {
      if (tagInput.value.trim()) {
        addEditingTag(tagInput.value);
        tagInput.value = '';
      }
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();

      var titleEl = document.getElementById('f-title');
      var noteEl = document.getElementById('f-note');
      var quoteEl = document.getElementById('f-quote');
      var sourceEl = document.getElementById('f-source');
      var title = titleEl.value.trim();

      if (!title) {
        showMsg('form-msg', '标题不能为空', true);
        titleEl.focus();
        return;
      }

      if (tagInput.value.trim()) {
        addEditingTag(tagInput.value);
        tagInput.value = '';
      }

      var sourceRaw = sourceEl.value.trim();
      var source = safeUrl(sourceRaw);
      if (sourceRaw && !source) {
        showMsg('form-msg', '来源链接只能填 http / https 地址', true);
        sourceEl.focus();
        return;
      }

      var wasEditing = Boolean(state.editingId);

      var payload = {
        title: title,
        note: noteEl.value.trim(),
        tags: state.editingTags.slice(),
        rating: state.draftRating,
        quote: quoteEl.value.trim(),
        source: source,
        updatedAt: new Date().toISOString(),
      };

      var targetId;

      if (state.editingId) {
        // —— 编辑模式：更新已有记录，位置不变
        var idx = state.records.findIndex(function (r) { return r.id === state.editingId; });
        if (idx < 0) {
          showMsg('form-msg', '这条记录已经不在了', true);
          exitEditMode();
          renderAll();
          return;
        }
        Object.keys(payload).forEach(function (k) { state.records[idx][k] = payload[k]; });
        targetId = state.editingId;
      } else {
        // —— 新建：放到列表最前
        targetId = makeId();
        state.records.unshift(Object.assign({
          id: targetId,
          createdAt: payload.updatedAt,
        }, payload));
      }

      saveRecords();
      if (window.NotesSync) NotesSync.schedule();
      exitEditMode();
      renderAll();
      flashRecord(targetId);
      showMsg('form-msg', wasEditing ? '已保存修改' : '已保存', false, 2200);

      if (window.innerWidth < 860) {
        document.getElementById('f-title').blur();
      }
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        exitEditMode(); // 不管是新建还是编辑，都退回干净状态
        showMsg('form-msg', '', false);
        document.getElementById('f-title').focus();
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        exitEditMode();
        showMsg('form-msg', '已取消编辑', false, 2000);
      });
    }
  }

  /** 进入编辑模式：把这条记录填回表单 */
  function enterEditMode(rec) {
    state.editingId = rec.id;
    state.editingTags = rec.tags.slice();
    state.draftRating = rec.rating || 0;

    document.getElementById('f-title').value = rec.title;
    document.getElementById('f-note').value = rec.note;
    document.getElementById('f-quote').value = rec.quote || '';
    document.getElementById('f-source').value = rec.source || '';

    var more = document.querySelector('.more');
    if (more) more.open = Boolean(rec.quote || rec.source);

    document.getElementById('form-title').textContent = '改这条';
    document.getElementById('submit-btn').textContent = '保存修改';
    var cancelBtn = document.getElementById('cancel-edit');
    if (cancelBtn) cancelBtn.hidden = false;

    renderTagEditor();
    renderRating();
    showMsg('form-msg', '', false);

    var panel = document.querySelector('.panel-form');
    if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('f-title').focus({ preventScroll: true });
  }

  /** 退出编辑模式，表单回到新建状态 */
  function exitEditMode() {
    state.editingId = null;
    resetForm();
  }

  function resetForm() {
    var form = document.getElementById('record-form');
    if (form) form.reset();

    state.editingTags = [];
    state.draftRating = 0;

    var more = document.querySelector('.more');
    if (more) more.open = false;

    document.getElementById('form-title').textContent = '记一条';
    document.getElementById('submit-btn').textContent = '保存记录';
    var cancelBtn = document.getElementById('cancel-edit');
    if (cancelBtn) cancelBtn.hidden = true;

    renderTagEditor();
    renderRating();
  }

  function showMsg(id, text, isError, autoHideMs) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('is-error', Boolean(isError));
    if (autoHideMs) {
      window.setTimeout(function () {
        if (el.textContent === text) el.textContent = '';
      }, autoHideMs);
    }
  }

  /** 只接受 http / https；没写协议时补 https:// */
  function safeUrl(raw) {
    var text = String(raw || '').trim();
    if (!text) return '';
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) {
      text = 'https://' + text.replace(/^\/+/, '');
    }
    try {
      var u = new URL(text);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      return u.href;
    } catch (e) {
      return '';
    }
  }

  function hostLabel(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (e) {
      return '来源';
    }
  }

  // ================= 5. 列表 =================
  function initList() {
    var search = document.getElementById('search');
    if (search) {
      search.addEventListener('input', function () {
        state.keyword = search.value.trim().toLowerCase();
        renderList();
      });
    }

    var fab = document.getElementById('fab');
    if (fab) {
      fab.addEventListener('click', function () {
        if (state.editingId) exitEditMode();
        var panel = document.querySelector('.panel-form');
        if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        var title = document.getElementById('f-title');
        if (title) title.focus({ preventScroll: true });
      });
    }
  }

  function allTags() {
    var counts = new Map();
    state.records.forEach(function (r) {
      r.tags.forEach(function (t) { counts.set(t, (counts.get(t) || 0) + 1); });
    });
    return Array.from(counts.entries()).sort(function (a, b) {
      return b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN');
    });
  }

  function filteredRecords() {
    return state.records.filter(function (r) {
      if (state.activeTag && r.tags.indexOf(state.activeTag) < 0) return false;
      if (state.monthFilter && monthKeyOf(r.createdAt) !== state.monthFilter) return false;
      if (state.rangeFilter && !inRangeOf(r.createdAt, state.rangeFilter)) return false;
      if (!state.keyword) return true;
      var hay = [r.title, r.note, r.quote, hostLabel(r.source) || '', r.tags.join(' ')].join(' ').toLowerCase();
      return hay.indexOf(state.keyword) >= 0;
    });
  }

  function renderAll() {
    renderStat();
    renderTagFilter();
    renderReview();
    renderReviewRanges();
    renderReviewMonths();
    renderList();
    window.requestAnimationFrame(updateNoteClamps);
    window.setTimeout(updateNoteClamps, 150);
  }

  function renderStat() {
    var stat = document.getElementById('stat');
    if (!stat) return;

    var stars = state.records.filter(function (r) { return r.rating > 0; }).length;
    var thisWeek = countInRange('week');

    stat.innerHTML = '';
    var row = document.createElement('span');
    row.className = 'stat-badges';

    addStatChip(row, state.records.length + ' 条');
    addStatChip(row, allTags().length + ' 个标签');
    if (stars) addStatChip(row, stars + ' 条打过星');
    addStatChip(row, '本周 +' + thisWeek, thisWeek > 0);

    stat.appendChild(row);
  }

  function addStatChip(parent, text, accent) {
    var chip = document.createElement('span');
    chip.className = 'stat-chip' + (accent ? ' is-accent' : '');
    chip.textContent = text;
    parent.appendChild(chip);
  }

  function renderTagFilter() {
    var box = document.getElementById('tag-filter');
    if (!box) return;
    box.innerHTML = '';

    var tags = allTags();
    if (!tags.length) return;

    var all = document.createElement('button');
    all.type = 'button';
    all.className = 'filter-chip' + (state.activeTag ? '' : ' is-on');
    all.textContent = '全部 ' + state.records.length;
    all.addEventListener('click', function () {
      state.activeTag = null;
      renderAll();
    });
    box.appendChild(all);

    tags.forEach(function (pair) {
      var tag = pair[0];
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'filter-chip' + (state.activeTag === tag ? ' is-on' : '');
      chip.textContent = tag + ' ' + pair[1];
      chip.addEventListener('click', function () {
        state.activeTag = state.activeTag === tag ? null : tag;
        renderAll();
      });
      box.appendChild(chip);
    });
  }

  function renderList() {
    var list = document.getElementById('record-list');
    var empty = document.getElementById('empty');
    var count = document.getElementById('list-count');
    if (!list || !empty) return;

    var items = filteredRecords();

    if (count) {
      var scope = '';
      if (state.monthFilter) scope = ' · ' + monthLabelOf(state.monthFilter);
      else if (state.rangeFilter) scope = ' · ' + RANGE_LABELS[state.rangeFilter];
      count.textContent = (state.records.length ? items.length + ' / ' + state.records.length + ' 条' : '0 条') + scope;
    }

    list.innerHTML = '';

    if (!items.length) {
      empty.hidden = false;
      var emptyTitle = empty.querySelector('.empty-title');
      var emptyText = empty.querySelector('.empty-text');
      if (state.records.length) {
        if (emptyTitle) emptyTitle.textContent = '没有匹配的记录';
        if (emptyText) emptyText.textContent = '换个关键词试试，或者点上面的「全部」看所有记录。';
      } else {
        if (emptyTitle) emptyTitle.textContent = '还没有记录';
        if (emptyText) emptyText.textContent = '写下第一条：最近一部让你想记住的剧、一首歌，或者一篇文章。';
      }
      return;
    }

    empty.hidden = true;
    items.forEach(function (rec) { list.appendChild(buildRecordCard(rec)); });
  }

  function buildRecordCard(rec) {
    var card = document.createElement('article');
    card.className = 'record';
    card.dataset.id = rec.id;

    // —— 头部：标题 + 日期/星级 + 操作
    var top = document.createElement('div');
    top.className = 'record-top';

    var main = document.createElement('div');
    main.className = 'record-main';

    var title = document.createElement('h3');
    title.className = 'record-title';
    title.textContent = rec.title;
    main.appendChild(title);

    var meta = document.createElement('div');
    meta.className = 'record-meta';

    var time = document.createElement('time');
    time.dateTime = rec.createdAt;
    time.textContent = formatDate(rec.createdAt);
    meta.appendChild(time);

    if (rec.rating > 0) {
      var stars = document.createElement('span');
      stars.className = 'record-stars';
      stars.setAttribute('aria-label', '评分 ' + rec.rating + ' 星');
      for (var i = 0; i < rec.rating; i++) stars.appendChild(starSvg());
      meta.appendChild(stars);
    }

    if (rec.updatedAt && rec.updatedAt !== rec.createdAt) {
      var edited = document.createElement('span');
      edited.textContent = '改过';
      meta.appendChild(edited);
    }

    main.appendChild(meta);
    top.appendChild(main);

    var actions = document.createElement('div');
    actions.className = 'record-actions';

    var edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'record-act';
    edit.textContent = '编辑';
    edit.addEventListener('click', function () { enterEditMode(rec); });
    actions.appendChild(edit);

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'record-act act-del';
    del.textContent = '删除';
    del.addEventListener('click', function () {
      if (window.confirm('删除「' + rec.title + '」？删了就找不回来了。')) {
        state.records = state.records.filter(function (r) { return r.id !== rec.id; });
        if (state.editingId === rec.id) exitEditMode();
        saveRecords();
        if (window.NotesSync) NotesSync.markDeleted(rec.id);
        renderAll();
      }
    });
    actions.appendChild(del);

    top.appendChild(actions);
    card.appendChild(top);

    // —— 感受（超过 3 行就收起，给个「展开」）
    if (rec.note) {
      var noteWrap = document.createElement('div');
      noteWrap.className = 'record-note-wrap';

      var note = document.createElement('p');
      note.className = 'record-note';
      note.textContent = rec.note;
      noteWrap.appendChild(note);

      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'note-toggle';
      toggle.textContent = '展开全文';
      toggle.addEventListener('click', function () {
        var open = note.classList.toggle('is-open');
        toggle.textContent = open ? '收起' : '展开全文';
      });
      noteWrap.appendChild(toggle);

      card.appendChild(noteWrap);
    }

    // —— 金句
    if (rec.quote) {
      var quote = document.createElement('blockquote');
      quote.className = 'record-quote';
      quote.textContent = rec.quote;
      card.appendChild(quote);
    }

    // —— 来源
    if (rec.source) {
      var link = document.createElement('a');
      link.className = 'record-source';
      link.href = rec.source;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';

      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '12');
      svg.setAttribute('height', '12');
      svg.setAttribute('aria-hidden', 'true');
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', 'M14 4h6v6M20 4l-8.5 8.5M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '1.8');
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke-linecap', 'round');
      svg.appendChild(p);
      link.appendChild(svg);

      var label = document.createElement('span');
      label.textContent = hostLabel(rec.source);
      link.appendChild(label);

      card.appendChild(link);
    }

    // —— 标签
    if (rec.tags.length) {
      var tagRow = document.createElement('div');
      tagRow.className = 'record-tags';
      rec.tags.forEach(function (tag) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = tagClass(tag);
        btn.textContent = tag;
        btn.addEventListener('click', function () {
          state.activeTag = tag;
          renderAll();
        });
        tagRow.appendChild(btn);
      });
      card.appendChild(tagRow);
    }

    return card;
  }

  /** 新建 / 修改后，让对应卡片闪一下，方便眼睛找到 */
  function flashRecord(id) {
    var el = document.querySelector('.record[data-id="' + id + '"]');
    if (!el) return;
    el.classList.add('is-flash');
    window.setTimeout(function () { el.classList.remove('is-flash'); }, 1200);
  }

  function formatDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());

    if (d.toDateString() === now.toDateString()) return '今天 ' + hm;

    var startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var dayDiff = Math.round((startOfToday - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
    if (dayDiff === 1) return '昨天 ' + hm;
    if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // ================= 6. 回顾 =================
  // 6.1 随机翻一条旧记录（7 天以前的优先，不够就从全部里抽）
  // 6.2 时间筛选：本周 / 本月 / 更早
  // 6.3 按月分组，点一下只看那个月

  var RANGE_LABELS = { week: '本周', month: '本月', older: '更早' };

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function monthKeyOf(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }

  function monthLabelOf(key) {
    var parts = String(key).split('-');
    return parts[0] + '年' + Number(parts[1]) + '月';
  }

  function daysSince(iso) {
    var t = new Date(iso).getTime();
    if (isNaN(t)) return 0;
    return Math.max(0, Math.floor((Date.now() - t) / 86400000));
  }

  function startOfThisWeek() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    var day = d.getDay();                 // 0 = 周日
    d.setDate(d.getDate() - (day === 0 ? 6 : day - 1)); // 退回到本周一
    return d.getTime();
  }

  function startOfThisMonth() {
    var d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  }

  function inRangeOf(iso, kind) {
    var t = new Date(iso).getTime();
    if (isNaN(t)) return false;
    if (kind === 'week') return t >= startOfThisWeek();
    if (kind === 'month') return t >= startOfThisMonth();
    if (kind === 'older') return t < startOfThisMonth();
    return true;
  }

  function countInRange(kind) {
    return state.records.filter(function (r) { return inRangeOf(r.createdAt, kind); }).length;
  }

  function pickReview(forceNew) {
    var pool = state.records.filter(function (r) { return daysSince(r.createdAt) >= 7; });
    if (!pool.length) pool = state.records.slice();
    if (!pool.length) return null;

    var current = null;
    if (state.reviewPickId) {
      current = state.records.filter(function (r) { return r.id === state.reviewPickId; })[0] || null;
    }
    // 已经选中的那条还在，就别每次都随机跳（否则打字搜索时卡片会乱跳）
    if (current && !forceNew) return current;

    var others = pool.filter(function (r) { return !current || r.id !== current.id; });
    if (!others.length) others = pool;
    return others[Math.floor(Math.random() * others.length)];
  }

  function renderReview() {
    var box = document.getElementById('review-card');
    if (!box) return;

    var reroll = document.getElementById('reroll-btn');
    if (reroll) reroll.disabled = !state.records.length;

    box.innerHTML = '';

    if (!state.records.length) {
      var none = document.createElement('p');
      none.className = 'review-empty';
      none.textContent = '还没有记录。记上几条之后，这里会时不时翻一条旧的给你看。';
      box.appendChild(none);
      return;
    }

    var rec = pickReview(false);
    if (!rec) return;
    state.reviewPickId = rec.id;

    var hint = document.createElement('p');
    hint.className = 'review-hint';
    var ago = daysSince(rec.createdAt);
    hint.textContent = '从 ' + state.records.length + ' 条里翻到这一条 · ' +
      (ago === 0 ? '今天刚记的' : ago + ' 天前记的');
    box.appendChild(hint);
    box.appendChild(buildRecordCard(rec));
  }

  function renderReviewRanges() {
    var box = document.getElementById('review-range');
    if (!box) return;
    box.innerHTML = '';

    ['week', 'month', 'older'].forEach(function (kind) {
      var n = countInRange(kind);
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'filter-chip' + (state.rangeFilter === kind ? ' is-on' : '');
      chip.textContent = RANGE_LABELS[kind] + ' ' + n;
      chip.disabled = n === 0 && state.rangeFilter !== kind;
      chip.addEventListener('click', function () {
        state.rangeFilter = state.rangeFilter === kind ? null : kind;
        state.monthFilter = null;
        renderAll();
        scrollToRecords();
      });
      box.appendChild(chip);
    });

    var clear = document.getElementById('clear-range');
    if (clear) clear.hidden = !(state.rangeFilter || state.monthFilter);
  }

  function renderReviewMonths() {
    var box = document.getElementById('review-months');
    if (!box) return;
    box.innerHTML = '';
    if (!state.records.length) return;

    var counts = {};
    state.records.forEach(function (r) {
      var key = monthKeyOf(r.createdAt);
      if (!key) return;
      counts[key] = (counts[key] || 0) + 1;
    });

    Object.keys(counts).sort().reverse().forEach(function (key) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'month-chip' + (state.monthFilter === key ? ' is-on' : '');

      var label = document.createElement('span');
      label.textContent = monthLabelOf(key);
      chip.appendChild(label);

      var num = document.createElement('span');
      num.className = 'm-count';
      num.textContent = counts[key] + ' 条';
      chip.appendChild(num);

      chip.addEventListener('click', function () {
        state.monthFilter = state.monthFilter === key ? null : key;
        state.rangeFilter = null;
        renderAll();
        scrollToRecords();
      });
      box.appendChild(chip);
    });
  }

  function scrollToRecords() {
    var section = document.querySelector('.panel-list');
    scrollToElement(section);
  }

  // 滚到某个元素：先试原生 scrollIntoView，不行就用坐标算（部分浏览器不支持 smooth）
  function scrollToElement(el, center) {
    if (!el) return;
    var rect = el.getBoundingClientRect();
    var top = center
      ? window.scrollY + rect.top - Math.max(0, (window.innerHeight - rect.height) / 2)
      : window.scrollY + rect.top - 12;
    top = Math.max(0, top);

    try {
      window.scrollTo({ top: top, behavior: 'smooth' });
    } catch (e) {
      window.scrollTo(0, top);
    }
    // 兜底：平滑滚动被禁用的浏览器，直接硬跳
    window.setTimeout(function () {
      if (Math.abs(window.scrollY - top) > 80) window.scrollTo(0, top);
    }, 400);
  }

  // 6.4 随手翻：顶部入口 + 弹层
  function pickAnyForModal() {
    var pool = state.records.filter(function (r) { return daysSince(r.createdAt) >= 7; });
    if (!pool.length) pool = state.records;
    var others = pool.filter(function (r) { return r.id !== state.modalPickId; });
    if (!others.length) others = pool;
    return others.length ? others[Math.floor(Math.random() * others.length)] : null;
  }

  function renderModalCard() {
    var body = document.getElementById('rm-body');
    var hint = document.getElementById('rm-hint');
    if (!body) return;

    body.innerHTML = '';

    if (!state.records.length) {
      state.modalPickId = null;
      if (hint) hint.textContent = '';
      var none = document.createElement('p');
      none.className = 'review-empty';
      none.textContent = '还没有记录。先记上几条，这里才有得翻。';
      body.appendChild(none);
      return;
    }

    var rec = pickAnyForModal();
    if (!rec) return;
    state.modalPickId = rec.id;

    var ago = daysSince(rec.createdAt);
    if (hint) {
      hint.textContent = (ago === 0 ? '今天刚记的' : ago + ' 天前记的') + ' · 共 ' + state.records.length + ' 条';
    }
    body.appendChild(buildRecordCard(rec));
    window.requestAnimationFrame(updateNoteClamps);
  }

  function openReviewModal() {
    var modal = document.getElementById('review-modal');
    var reroll = document.getElementById('rm-reroll');
    var goto = document.getElementById('rm-open');
    if (!modal) return;

    modal.hidden = false;
    document.body.classList.add('modal-open');

    if (reroll) reroll.disabled = !state.records.length;
    if (goto) goto.disabled = !state.records.length;

    renderModalCard();
  }

  function closeReviewModal() {
    var modal = document.getElementById('review-modal');
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove('modal-open');
  }

  function gotoModalRecord() {
    var id = state.modalPickId;
    closeReviewModal();
    if (!id) return;

    // 清掉搜索与筛选，保证这一条一定在列表里看得见
    state.monthFilter = null;
    state.rangeFilter = null;
    state.activeTag = null;
    state.keyword = '';
    var search = document.getElementById('search');
    if (search) search.value = '';
    renderAll();

    var el = document.querySelector('.record[data-id="' + id + '"]');
    if (el) {
      scrollToElement(el, true);
      flashRecord(id);
    }
  }

  // 只有真被截断的卡片才显示「展开全文」
  function updateNoteClamps() {
    var notes = document.querySelectorAll('.record-note:not(.is-open)');
    for (var i = 0; i < notes.length; i++) {
      var note = notes[i];
      var wrap = note.parentNode;
      if (!wrap || !wrap.querySelector) continue;
      var toggle = wrap.querySelector('.note-toggle');
      if (!toggle) continue;
      var clamped = note.scrollHeight > note.clientHeight + 2;
      if (clamped) toggle.classList.add('is-on');
      else toggle.classList.remove('is-on');
    }
  }

  function initReview() {
    var reroll = document.getElementById('reroll-btn');
    if (reroll) {
      reroll.addEventListener('click', function () {
        state.reviewPickId = null;
        var rec = pickReview(true);
        if (rec) state.reviewPickId = rec.id;
        renderReview();
        window.requestAnimationFrame(updateNoteClamps);
      });
    }

    var clear = document.getElementById('clear-range');
    if (clear) {
      clear.addEventListener('click', function () {
        state.rangeFilter = null;
        state.monthFilter = null;
        renderAll();
      });
    }

    // 顶部「随手翻一条旧的」
    var jump = document.getElementById('review-jump');
    if (jump) jump.addEventListener('click', openReviewModal);

    var modalClose = document.getElementById('rm-close');
    if (modalClose) modalClose.addEventListener('click', closeReviewModal);

    var backdrop = document.getElementById('rm-backdrop');
    if (backdrop) backdrop.addEventListener('click', closeReviewModal);

    var modalReroll = document.getElementById('rm-reroll');
    if (modalReroll) modalReroll.addEventListener('click', renderModalCard);

    var modalOpen = document.getElementById('rm-open');
    if (modalOpen) modalOpen.addEventListener('click', gotoModalRecord);

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var modal = document.getElementById('review-modal');
      if (modal && !modal.hidden) closeReviewModal();
    });
  }

  // ================= 7. 备份 =================
  function initBackup() {
    var exportBtn = document.getElementById('export-btn');
    var importBtn = document.getElementById('import-btn');
    var fileInput = document.getElementById('import-file');
    if (!exportBtn || !importBtn || !fileInput) return;

    exportBtn.addEventListener('click', function () {
      if (!state.records.length) {
        showMsg('backup-msg', '还没有记录可以导出', true, 2000);
        return;
      }

      var payload = {
        app: 'my-notes',
        version: 2,
        exportedAt: new Date().toISOString(),
        records: state.records,
      };

      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = '记录备份-' + toDateStamp() + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

      showMsg('backup-msg', '已导出 ' + state.records.length + ' 条记录', false, 3000);
    });

    importBtn.addEventListener('click', function () { fileInput.click(); });

    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;

      var reader = new FileReader();
      reader.onload = function () {
        try {
          var data = JSON.parse(String(reader.result));
          var incoming = Array.isArray(data) ? data : (data && Array.isArray(data.records) ? data.records : null);
          if (!incoming) throw new Error('文件格式不对');

          var added = 0;
          var skipped = 0;

          incoming.forEach(function (item) {
            if (!isValidRecord(item)) { skipped++; return; }
            var rec = normalizeRecord(item);
            if (state.records.some(function (r) { return r.id === rec.id; })) { skipped++; return; }
            state.records.push(rec);
            added++;
          });

          state.records.sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });

          saveRecords();
          renderAll();
          if (window.NotesSync) NotesSync.schedule();
          showMsg('backup-msg', '导入完成：新增 ' + added + ' 条，跳过 ' + skipped + ' 条', false, 4000);
        } catch (e) {
          showMsg('backup-msg', '导入失败：不是本工具导出的备份文件', true, 4000);
        } finally {
          fileInput.value = '';
        }
      };
      reader.onerror = function () {
        showMsg('backup-msg', '文件读取失败，换一个试试', true, 4000);
        fileInput.value = '';
      };
      reader.readAsText(file);
    });
  }

  function toDateStamp() {
    var d = new Date();
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
  }

  // ================= 8. 离线可用（PWA） =================
  var deferredInstall = null;

  function initOffline() {
    // 本地开发（localhost / 127.0.0.1）不注册离线缓存：
    // 否则改了代码浏览器还拿旧脚本，看着像"改了没生效"
    var host = location.hostname;
    var isLocalDev = host === 'localhost' || host === '127.0.0.1';

    if ('serviceWorker' in navigator) {
      if (isLocalDev) {
        navigator.serviceWorker.getRegistrations().then(function (list) {
          list.forEach(function (reg) { reg.unregister(); });
        }).catch(function () {});
      } else {
        window.addEventListener('load', function () {
          navigator.serviceWorker.register('./sw.js').catch(function (err) {
            console.warn('离线缓存注册失败：', err);
          });
        });
      }
    }

    // 浏览器支持「安装应用」时，才把按钮放出来
    var btn = document.getElementById('install-btn');
    if (!btn) return;

    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredInstall = e;
      btn.hidden = false;
    });

    btn.addEventListener('click', function () {
      if (!deferredInstall) {
        showMsg('backup-msg', '请用浏览器菜单里的「安装应用 / 添加到主屏幕」', false, 3000);
        return;
      }
      deferredInstall.prompt();
      deferredInstall.userChoice.then(function (choice) {
        deferredInstall = null;
        btn.hidden = true;
        if (choice && choice.outcome === 'accepted') {
          showMsg('backup-msg', '已安装，之后可以离线打开', false, 3000);
        }
      });
    });
  }

  // ================= 9. 云同步接入 =================
  function setSyncStatus(text, isError) {
    var el = document.getElementById('sync-status');
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = text;
    el.style.color = isError ? '#a4382a' : '';
  }

  function initSync() {
    var note = document.getElementById('footer-note');
    if (!note) note = null;

    if (!window.NotesSync) return;

    if (window.NotesSync.enabled) {
      if (note) note.textContent = '记录会同步到你自己的 GitHub 私有仓库，不经过第三方服务。';
    } else if (note) {
      note.textContent = '全部数据只存在本机浏览器，不会上传到任何地方。';
    }

    NotesSync.init({
      getRecords: function () { return state.records; },
      setRecords: function (list) {
        state.records = list;
        saveRecords();
        renderAll();
      },
      onStatus: setSyncStatus,
    });
  }

  // ================= 10. 启动 =================
  function boot() {
    state.records = loadRecords();
    renderQuickTags();
    renderTagEditor();
    renderRating();
    initForm();
    initList();
    initReview();
    initBackup();
    initOffline();
    initSync();
    renderAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
