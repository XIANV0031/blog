/* ============================================================
   战术工装主题 —— 动态层脚本 v5
   ------------------------------------------------------------
   职责：
     1. 注入动态背景 DOM（雷达网格 / 扫掠光带 / 雷达环 / 十字标线）
     2. 鼠标轨迹光晕跟随（lerp 插值双层视差）
     3. 正文元素的滚动渐显（IntersectionObserver）
     4. 图片 hover 时同步 figure 宽度（供不支持 :has() 的旧浏览器兜底）

   ⚠️ 设计约束（改本文件前必读）
   · **必须优雅降级**：JS 未加载 / 报错时，页面必须完全可用。
     动态背景缺了只是少层氛围；渐显元素**不能**保持 opacity:0
     （那会白屏）。所以 .tac-reveal 类由 JS 自己挂，CSS 里的
     初始隐藏态只在 JS 存在时才生效。
   · **不要用 requestAnimationFrame 常驻跑无意义循环**：
     鼠标不动时应该停下 rAF（本文件用 needsTick 标志控制），
     否则笔记本电池与弱 GPU（本机 GT 1030）会被白白吃掉。
   · **触屏设备直接跳过鼠标轨迹**：没有 hover 概念，
     且移动端 pointermove 会随触摸频繁触发，纯属浪费。
   ============================================================ */

(function () {
  'use strict';

  /* ---------- 公共：能力探测 ---------- */
  var hasHover = window.matchMedia && window.matchMedia('(hover: hover)').matches;
  var isCoarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  var isPrint = window.matchMedia && window.matchMedia('print').matches;

  /* 尊重用户系统的「减少动态效果」设置时，只关掉跟随类跟踪动效，
     但**不关**站点的装饰性动效（延续 v4 的分级响应策略）。
     鼠标轨迹属于"跟随鼠标的持续位移"，是最容易引发不适的一类，
     故单独对它做降级。 */
  var reduceMotion = window.matchMedia &&
                     window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ==========================================================
     1. 动态背景注入
     ========================================================== */
  function buildBackground() {
    if (isPrint) return;
    // 已经有就不重复建（防止某些主题重复执行 footer hook）
    if (document.querySelector('.tac-bg')) return;

    var layer = document.createElement('div');
    layer.className = 'tac-bg';
    layer.setAttribute('aria-hidden', 'true');

    var grid = document.createElement('div');
    grid.className = 'tac-bg-grid';

    var sweep = document.createElement('div');
    sweep.className = 'tac-bg-sweep';

    var ring = document.createElement('div');
    ring.className = 'tac-bg-ring';

    var crossTL = document.createElement('div');
    crossTL.className = 'tac-bg-cross is-tl';

    var crossBR = document.createElement('div');
    crossBR.className = 'tac-bg-cross is-br';

    layer.appendChild(grid);
    layer.appendChild(sweep);
    layer.appendChild(ring);
    layer.appendChild(crossTL);
    layer.appendChild(crossBR);

    // 插到 body 最前面，确保在所有内容之下
    document.body.insertBefore(layer, document.body.firstChild);
  }

  /* ==========================================================
     2. 鼠标轨迹：双层光晕 + lerp 插值
     ========================================================== */
  function buildTrace() {
    // 触屏 / 打印 / 用户要求减少动效 → 不建轨迹层
    if (isPrint || isCoarse || !hasHover || reduceMotion) return;

    var trace = document.createElement('div');
    trace.className = 'tac-trace';
    trace.setAttribute('aria-hidden', 'true');

    var core = document.createElement('div');
    core.className = 'tac-trace-core';
    core.setAttribute('aria-hidden', 'true');

    document.body.appendChild(trace);
    document.body.appendChild(core);

    // 目标位置（鼠标真实位置）与当前渲染位置
    var tx = window.innerWidth / 2,  ty = window.innerHeight / 2;
    var px = tx, py = ty;                       // 光晕（慢）
    var cx = tx, cy = ty;                       // 内核（快）

    // 插值系数：内核跟得紧，光晕拖尾明显 → 形成视差层次
    var LERP_SLOW = 0.075;
    var LERP_FAST = 0.28;

    var running = false;
    var idleFrames = 0;

    function tick() {
      px += (tx - px) * LERP_SLOW;
      py += (ty - py) * LERP_SLOW;
      cx += (tx - cx) * LERP_FAST;
      cy += (ty - cy) * LERP_FAST;

      // 用 translate3d 走合成层，避免触发 layout/paint
      trace.style.transform = 'translate3d(' + px.toFixed(2) + 'px,' + py.toFixed(2) + 'px,0)';
      core.style.transform  = 'translate3d(' + cx.toFixed(2) + 'px,' + cy.toFixed(2) + 'px,0)';

      // 收敛判定：两者都足够接近目标时停掉 rAF，省电
      var dSlow = Math.abs(tx - px) + Math.abs(ty - py);
      var dFast = Math.abs(tx - cx) + Math.abs(ty - cy);

      if (dSlow < 0.35 && dFast < 0.35) {
        idleFrames++;
        // 连续 12 帧都已收敛 → 认为静止，停止循环
        // ⚠️ 不能一帧就停：否则会留下极小的位置残差，看着像"没跟到位"
        if (idleFrames > 12) {
          running = false;
          return;
        }
      } else {
        idleFrames = 0;
      }
      requestAnimationFrame(tick);
    }

    function wake() {
      if (running) return;
      running = true;
      idleFrames = 0;
      requestAnimationFrame(tick);
    }

    window.addEventListener('pointermove', function (e) {
      // 忽略从触屏合成的 pointer 事件
      if (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
      tx = e.clientX;
      ty = e.clientY;

      // 首次出现才显形（避免加载后光晕停在视口中心）
      if (!trace.classList.contains('is-live')) {
        // 直接从鼠标位置起步，不要从中心"飞"过来
        px = cx = tx;
        py = cy = ty;
        trace.classList.add('is-live');
        core.classList.add('is-live');
      }
      wake();
    }, { passive: true });

    // 鼠标移出窗口：光晕淡出
    document.addEventListener('mouseleave', function () {
      trace.classList.remove('is-live');
      core.classList.remove('is-live');
    });
    document.addEventListener('mouseenter', function () {
      if (tx || ty) {
        trace.classList.add('is-live');
        core.classList.add('is-live');
      }
    });

    // 按下 / 抬起：给光晕加一层"触感"反馈
    document.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse') document.body.classList.add('tac-pointer-down');
    }, { passive: true });
    document.addEventListener('pointerup', function () {
      document.body.classList.remove('tac-pointer-down');
    }, { passive: true });

    // 视口尺寸变化时，把目标夹回可视范围，避免光晕留在屏幕外
    window.addEventListener('resize', function () {
      tx = Math.min(tx, window.innerWidth);
      ty = Math.min(ty, window.innerHeight);
      wake();
    }, { passive: true });
  }

  /* ==========================================================
     3. 滚动渐显
     ========================================================== */
  function buildReveal() {
    if (isPrint) return;
    // 老浏览器没有 IntersectionObserver → 直接不动，元素保持可见
    if (!('IntersectionObserver' in window)) return;

    // 只对正文里的块级内容做渐显。⚠️ 不要对整篇容器做，
    // 否则长文一打开就是一大片空白。
    var sel = [
      '.post-content > h2',
      '.post-content > h3',
      '.post-content > figure',
      '.post-content > p',
      '.post-content > table',
      '.post-content > ul',
      '.post-content > ol',
      '.post-content > blockquote'
    ].join(',');

    var nodes = Array.prototype.slice.call(document.querySelectorAll(sel));
    if (!nodes.length) return;

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add('is-in');
          io.unobserve(en.target);          // 出现一次就够了，别反复播
        }
      });
    }, {
      // 元素顶部进入视口下沿 8% 时触发；提前一点，滚动手感更顺
      rootMargin: '0px 0px -8% 0px',
      threshold: 0.01
    });

    // ⚠️ 先挂 .tac-reveal（此时才开始隐藏），再 observe。
    //    顺序反了会出现「先闪一下可见、再被隐藏、再淡入」的抖动。
    nodes.forEach(function (n) {
      // 已经处于视口内的（首屏可见内容）不做动画，避免首屏闪烁
      var r = n.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.92) return;

      n.classList.add('tac-reveal');
      io.observe(n);
    });
  }

  /* ==========================================================
     4. figure 宽度兜底（不支持 :has() 的旧浏览器）
     ----------------------------------------------------------
     现代浏览器的方案见 CSS：figure 用 --fig-w 变量收窄，
     img 填满 figure，图注天然同宽且 hover 同步放大。

     旧浏览器（Chrome <105 / Firefox <121 / Safari <15.4）没有 :has()，
     整段规则不生效，退化表现是「图片缩到 62% 但图注仍是满宽」。
     这里用 JS 直接设内联样式补上。
     ========================================================== */
  function buildFigureSync() {
    // 支持 :has() 就不用管，CSS 已完整处理
    if (window.CSS && CSS.supports && CSS.supports('selector(:has(*))')) return;

    var figs = document.querySelectorAll('.post-content figure.post-figure');
    Array.prototype.forEach.call(figs, function (fig) {
      var img = fig.querySelector('img');
      if (!img) return;

      var isWide = img.classList.contains('wide-banner');
      var base = isWide ? 82 : 62;
      var hove = isWide ? 100 : 92;

      function apply(pct) {
        fig.style.width = pct + '%';
        fig.style.maxWidth = '100%';
        fig.style.marginLeft = 'auto';
        fig.style.marginRight = 'auto';
        fig.style.transition = 'width 0.52s cubic-bezier(0.22, 1, 0.36, 1)';
        // img 填满 figure，避免二次收缩
        img.style.width = '100%';
        img.style.maxWidth = '100%';
      }

      apply(base);
      img.addEventListener('mouseenter', function () { apply(hove); });
      img.addEventListener('mouseleave', function () { apply(base); });
    });
  }

  /* ==========================================================
     启动
     ========================================================== */
  function boot() {
    try { buildBackground(); } catch (e) {}
    try { buildTrace(); } catch (e) {}
    try { buildReveal(); } catch (e) {}
    try { buildFigureSync(); } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
