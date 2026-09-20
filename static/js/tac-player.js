/* ==========================================================================
   tac-player.js —— 音频播放器（24 首 · 播放列表 · 旋转唱片）
   ==========================================================================

   从 extend_footer.html 的内联脚本抽出为独立文件，原因有二：
     1. 内联脚本与 PJAX 配合时不便做状态持久化与重绑定；
     2. 自动播放解锁逻辑需要跨页面生命周期管理。

   ⚠️ 关键前提：本脚本由 extend_footer.html 引入，位置在 <main> **之外**。
      配合 tac-pjax.js 的「只替换 <main>」策略 ——
      本脚本作用域内的 `audio` 实例、`cur`、`shuffle` 等状态
      **在整个会话期间不会被销毁**，跨页续播是天然的，无需保存再恢复。

      若将来把导航换回整页跳转，本文件的 sessionStorage 逻辑
      可作为兜底：刷新后能恢复曲目与进度（但会有可感知的断音）。

   自动播放说明
   --------------------------------------------------------------------------
   浏览器硬性策略：**未经用户交互的 audio.play() 必被拒绝**
   （Chrome/Safari/Firefox 一致，抛 NotAllowedError）。
   这不是代码问题，无法绕过。

   采用「首次交互即解锁」策略：
     · 页面加载后进入待命状态，监听 click / keydown / touchstart / scroll
       这四类最早能拿到的真实用户手势（捕获阶段，一次即卸）；
     · 一旦收到手势 → 立刻 play()（此时已在用户手势的调用栈内，允许发声）；
     · 解锁成功后写入 sessionStorage，同一会话内后续页面直接尝试 play()；
     · 若仍被拒绝（如自动播放被系统级禁用的机器），降级为
       "等待用户点播放键"，并在播放器底部如实提示状态。
   ========================================================================== */

(function () {
  'use strict';

  var root = document.getElementById('tac-player');
  if (!root) return;

  /* ---------- 曲目清单 ---------- */
  var dataEl = document.getElementById('tac-playlist');
  var list = [];
  try { list = JSON.parse(dataEl.textContent); } catch (e) { list = []; }
  if (!list.length) return;

  /* ==========================================================
     0. 状态与存储
     ========================================================== */
  var SS = {
    UNLOCKED: 'tac-audio-unlocked',   /* 会话内是否已解锁自动播放 */
    TRACK:    'tac-audio-track',      /* 上次播放的曲目序号 */
    TIME:     'tac-audio-time',       /* 上次播放进度（秒） */
    VOL:      'tac-audio-vol',        /* 音量 */
    SHUFFLE:  'tac-audio-shuffle'     /* 随机开关 */
  };

  function ssGet(k) {
    try { return window.sessionStorage.getItem(k); } catch (e) { return null; }
  }
  function ssSet(k, v) {
    try { window.sessionStorage.setItem(k, String(v)); } catch (e) {}
  }

  /* audio 实例：整个会话唯一，PJAX 下不会被重建 */
  var audio = new Audio();
  audio.preload = 'metadata';

  var savedVol = parseFloat(ssGet(SS.VOL));
  audio.volume = (isFinite(savedVol) && savedVol >= 0) ? savedVol : 0.55;

  var $ = function (id) { return document.getElementById(id); };
  var elPlay = $('tac-play'),  elPrev = $('tac-prev'), elNext = $('tac-next');
  var elBar  = $('tac-bar'),   elKnob = $('tac-knob'), elProg = $('tac-progress');
  var elTime = $('tac-time'),  elIdx  = $('tac-idx'),  elName = $('tac-name');
  var elArtist = $('tac-artist'), elVol = $('tac-vol'), elTog = $('tac-player-toggle');
  var elList = $('tac-list'),  elListBtn = $('tac-list-btn');
  var elListBody = $('tac-list-body'), elDisc = $('tac-disc');
  var elShuffle = $('tac-shuffle'), elMini = $('tac-mini');
  var elFoot = root.querySelector('.player-foot span');
  var items = elListBody ? elListBody.querySelectorAll('.list-item') : [];

  var cur = 0;
  var shuffle = false;
  var errRetries = 0;     /* 音频读取错误的重试计数（见 error 处理） */
  var wasPlaying = false; /* 用户是否希望播放（决定错误后是否自动续播） */

  /* 恢复音量滑块的显示值 */
  if (elVol) elVol.value = String(Math.round(audio.volume * 100));

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) return '--:--';
    return pad(Math.floor(sec / 60)) + ':' + pad(Math.floor(sec % 60));
  }

  function footMsg(text) {
    if (elFoot) elFoot.textContent = text;
  }

  /* ==========================================================
     1. 列表高亮
     ========================================================== */
  function markList(i) {
    for (var k = 0; k < items.length; k++) {
      items[k].classList.toggle('is-current', k === i);
    }
    if (items[i] && elList && !elList.hidden) {
      items[i].scrollIntoView({ block: 'nearest' });
    }
  }

  /* ==========================================================
     2. 加载曲目
     ========================================================== */
  function load(i, autoplay, resumeAt) {
    cur = (i + list.length) % list.length;
    var t = list[cur];
    audio.src = t.src;
    elIdx.textContent   = pad(cur + 1) + '/' + pad(list.length);
    elName.textContent  = t.title  || '未知音轨';
    elArtist.textContent = t.artist || '';
    if (elMini) elMini.textContent = (t.title || '') + (t.artist ? ' — ' + t.artist : '');
    elBar.style.width   = '0%';
    if (elKnob) elKnob.style.left = '0%';
    elProg.setAttribute('aria-valuenow', '0');
    elTime.textContent  = '--:-- / --:--';
    markList(cur);
    ssSet(SS.TRACK, cur);

    /* 续播点：等元数据到位后再跳，否则会被浏览器忽略（duration 尚为 NaN） */
    if (resumeAt && resumeAt > 0) {
      var once = function () {
        audio.removeEventListener('loadedmetadata', once);
        try {
          if (isFinite(audio.duration) && resumeAt < audio.duration - 1) {
            audio.currentTime = resumeAt;
          }
        } catch (e) {}
      };
      audio.addEventListener('loadedmetadata', once);
    }

    if (autoplay) play();
  }

  /* ==========================================================
     3. 播放控制
     ========================================================== */
  function play() {
    var p = audio.play();
    if (p && p.catch) {
      p.catch(function (err) {
        /* NotAllowedError = 未解锁；其他（如 NotSupportedError）另作提示 */
        root.classList.remove('is-playing');
        if (elDisc) elDisc.classList.remove('is-spinning');
        elPlay.textContent = '▶';
        if (err && err.name === 'NotAllowedError') {
          footMsg('浏览器已拦截自动播放 · 点击 ▶ 开始');
        }
      });
    }
  }

  function toggle() {
    if (audio.paused) {
      if (!audio.src) load(cur, true);
      else play();
    } else {
      audio.pause();
    }
  }

  function nextIndex() {
    if (shuffle && list.length > 1) {
      var r;
      do { r = Math.floor(Math.random() * list.length); } while (r === cur);
      return r;
    }
    return cur + 1;
  }

  elPlay.addEventListener('click', toggle);
  elPrev.addEventListener('click', function () {
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    load(cur - 1, !audio.paused);
  });
  elNext.addEventListener('click', function () { load(nextIndex(), !audio.paused); });

  if (elShuffle) {
    /* 恢复随机开关 */
    if (ssGet(SS.SHUFFLE) === '1') {
      shuffle = true;
      elShuffle.classList.add('is-on');
      elShuffle.setAttribute('aria-pressed', 'true');
    }
    elShuffle.addEventListener('click', function () {
      shuffle = !shuffle;
      elShuffle.classList.toggle('is-on', shuffle);
      elShuffle.setAttribute('aria-pressed', String(shuffle));
      ssSet(SS.SHUFFLE, shuffle ? '1' : '0');
    });
  }

  /* ==========================================================
     4. audio 事件
     ========================================================== */
  audio.addEventListener('play', function () {
    root.classList.add('is-playing');
    if (elDisc) elDisc.classList.add('is-spinning');
    elPlay.textContent = '❚❚';
    if (root.classList.contains('is-collapsed')) toggleCollapse(false);
    footMsg('正在播放 · 跨页不中断');
  });

  audio.addEventListener('pause', function () {
    root.classList.remove('is-playing');
    if (elDisc) elDisc.classList.remove('is-spinning');
    elPlay.textContent = '▶';
    /* 只在非误差暂停时提示，避免打断 */
    if (!audio.ended) footMsg('已暂停 · 点击 ▶ 继续');
  });

  audio.addEventListener('ended', function () { load(nextIndex(), true); });

  audio.addEventListener('timeupdate', function () {
    var d = audio.duration;
    if (!d || !isFinite(d)) return;
    var pct = (audio.currentTime / d) * 100;
    elBar.style.width = pct.toFixed(2) + '%';
    if (elKnob) elKnob.style.left = pct.toFixed(2) + '%';
    elProg.setAttribute('aria-valuenow', String(Math.round(pct)));
    elTime.textContent = fmt(audio.currentTime) + ' / ' + fmt(d);
  });

  /* 进度写盘：每秒最多一次（timeupdate 触发频率约 4Hz，无需那么密） */
  var lastSave = 0;
  audio.addEventListener('timeupdate', function () {
    var now = Date.now();
    if (now - lastSave < 1000) return;
    lastSave = now;
    if (audio.currentTime > 0) ssSet(SS.TIME, audio.currentTime.toFixed(1));
  });

  /* 页面即将卸载时落盘（整页跳转兜底） */
  window.addEventListener('pagehide', function () {
    if (audio.currentTime > 0) ssSet(SS.TIME, audio.currentTime.toFixed(1));
    ssSet(SS.TRACK, cur);
  });

  audio.addEventListener('loadedmetadata', function () {
    elTime.textContent = '00:00 / ' + fmt(audio.duration);
  });

  audio.addEventListener('error', function () {
    /* ----------------------------------------------------------
       错误自愈
       ----------------------------------------------------------
       实测遇到的真实故障（本地测试服务器未正确处理 Range 请求时）：
         code 2, "PIPELINE_ERROR_READ: FFmpegDemuxer: data source error"
       症状是**永久卡死** —— currentTime 冻结、时间显示"加载失败"、
       播放按钮停在 ❚❚，用户除了手动刷新没有任何恢复手段。

       这类"读取中断"在网络抖动、CDN 切节点、部分静态托管上都会出现，
       与代码无关，所以必须让播放器自己扛过去：重载同一首并从原位置续播。

       策略：最多连试 2 次，间隔 1.2s / 2.4s（退避）；
             两次都失败才如实报错，避免在真·坏文件上无限重试。
       ---------------------------------------------------------- */
    var resumeAt = audio.currentTime || 0;

    if (errRetries < 2) {
      errRetries++;
      elTime.textContent = '重连中…';
      footMsg('音频中断 · 正在重连（第 ' + errRetries + ' 次）');
      setTimeout(function () {
        /* 强制重取：清空 src 再设回，绕过可能已损坏的缓冲 */
        var src = audio.src;
        audio.src = '';
        audio.load();
        audio.src = src;
        audio.load();
        if (resumeAt > 0.5) {
          var once = function () {
            audio.removeEventListener('loadedmetadata', once);
            try { if (resumeAt < audio.duration - 1) audio.currentTime = resumeAt; } catch (e) {}
          };
          audio.addEventListener('loadedmetadata', once);
        }
        /* 只有之前处于播放态才自动续播；用户主动暂停的不打扰 */
        if (wasPlaying) play();
      }, errRetries === 1 ? 1200 : 2400);
      return;
    }

    elTime.textContent = '加载失败';
    root.classList.remove('is-playing');
    if (elDisc) elDisc.classList.remove('is-spinning');
    elPlay.textContent = '▶';
    footMsg('音轨加载失败 · 请切换下一首');
  });

  /* 记录播放意图：只有"用户想播"时才自动重连，
     否则会把用户手动暂停的曲目又推起来 */
  audio.addEventListener('play', function () { wasPlaying = true; errRetries = 0; });
  audio.addEventListener('pause', function () { if (!audio.ended) wasPlaying = false; });
  audio.addEventListener('ended', function () { wasPlaying = true; });

  /* ==========================================================
     5. 进度条拖拽 / 键盘
     ========================================================== */
  function seek(ev) {
    var d = audio.duration;
    if (!d || !isFinite(d)) return;
    var r = elProg.getBoundingClientRect();
    var x = (ev.clientX !== undefined ? ev.clientX : r.left) - r.left;
    var pct = Math.min(1, Math.max(0, x / r.width));
    audio.currentTime = pct * d;
  }

  elProg.addEventListener('click', seek);
  elProg.addEventListener('keydown', function (e) {
    var d = audio.duration;
    if (!d || !isFinite(d)) return;
    if (e.key === 'ArrowRight') { audio.currentTime = Math.min(d, audio.currentTime + 5); e.preventDefault(); }
    if (e.key === 'ArrowLeft')  { audio.currentTime = Math.max(0, audio.currentTime - 5); e.preventDefault(); }
    if (e.key === ' ' || e.key === 'Enter') { toggle(); e.preventDefault(); }
  });

  elVol.addEventListener('input', function () {
    audio.volume = (parseInt(elVol.value, 10) || 0) / 100;
    ssSet(SS.VOL, audio.volume.toFixed(2));
  });

  /* ==========================================================
     6. 播放列表交互
     ========================================================== */
  if (elListBody) {
    elListBody.addEventListener('click', function (e) {
      var li = e.target.closest ? e.target.closest('.list-item') : null;
      if (!li) return;
      var i = parseInt(li.dataset.i, 10);
      if (isNaN(i)) return;
      if (i === cur) { toggle(); return; }
      load(i, true);
    });
  }

  function toggleList(force) {
    if (!elList) return;
    var show = (typeof force === 'boolean') ? force : elList.hidden;
    elList.hidden = !show;
    if (elListBtn) {
      elListBtn.setAttribute('aria-expanded', String(show));
      elListBtn.classList.toggle('is-on', show);
    }
    if (show && items[cur]) items[cur].scrollIntoView({ block: 'nearest' });
  }
  if (elListBtn) {
    elListBtn.addEventListener('click', function () { toggleList(); });
  }

  /* ==========================================================
     7. 整机收起 / 展开
     ========================================================== */
  function toggleCollapse(collapsed) {
    var next = (typeof collapsed === 'boolean') ? collapsed : !root.classList.contains('is-collapsed');
    root.classList.toggle('is-collapsed', next);
    elTog.textContent = next ? '▲' : '▼';
    elTog.setAttribute('aria-label', next ? '展开播放器' : '收起播放器');
    if (next) toggleList(false);
  }
  elTog.addEventListener('click', function (e) {
    e.stopPropagation();
    toggleCollapse();
  });
  var elHead = $('tac-head');
  if (elHead) elHead.addEventListener('click', function () { toggleCollapse(); });

  /* 键盘空格：播放 / 暂停 */
  document.addEventListener('keydown', function (e) {
    if (e.key !== ' ' && e.code !== 'Space') return;
    var tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'button' || tag === 'a') return;
    if (e.target && e.target.isContentEditable) return;
    toggle();
    e.preventDefault();
  });

  /* ==========================================================
     8. 自动播放解锁（本轮新增，核心）
     ========================================================== */
  var unlocked = ssGet(SS.UNLOCKED) === '1';

  function armUnlock(isFirstAttempt) {
    /* 首次交互的监听器：一次性，捕获阶段抢在业务逻辑之前拿到手势 */
    var events = ['click', 'keydown', 'touchstart', 'scroll', 'pointerdown'];
    var done = false;

    function onGesture() {
      if (done) return;
      done = true;
      for (var i = 0; i < events.length; i++) {
        document.removeEventListener(events[i], onGesture, true);
        window.removeEventListener(events[i], onGesture, true);
      }
      ssSet(SS.UNLOCKED, '1');
      unlocked = true;

      /* 用户如果已经自己在操作播放器（点了播放键、切歌等），
         不要跟他抢控制权 —— 只在真正"待机"时接手。 */
      if (!audio.paused) return;
      if (audio.currentTime > 0) return;

      /* ⚠️ 必须在手势的调用栈内同步调用 play()，否则失去"用户激活"资格。
         这里刻意不做 setTimeout 延迟。 */
      play();
    }

    for (var i = 0; i < events.length; i++) {
      document.addEventListener(events[i], onGesture, true);
      window.addEventListener(events[i], onGesture, true);
    }
  }

  /* 恢复上次的曲目与进度 */
  var savedTrack = parseInt(ssGet(SS.TRACK), 10);
  if (isNaN(savedTrack) || savedTrack < 0 || savedTrack >= list.length) savedTrack = 0;
  var savedTime = parseFloat(ssGet(SS.TIME));
  if (!isFinite(savedTime) || savedTime < 0) savedTime = 0;

  load(savedTrack, false, savedTime);

  /* 会话内已解锁：直接尝试续播（同一会话中通常仍被允许） */
  if (unlocked) {
    play();
    footMsg('正在续播上次进度');
  } else {
    footMsg('点击任意处自动播放 · 跨页不中断');
    armUnlock(true);
  }
})();
