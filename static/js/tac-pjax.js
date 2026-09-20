/* ==========================================================================
   tac-pjax.js —— 站内局部替换导航（PJAX）
   ==========================================================================

   目的
   --------------------------------------------------------------------------
   本站是传统整页导航：点链接 → 整个 JS 环境销毁重建。
   这带来一个无法用其他办法解决的问题 ——

       <audio> 实例随页面一起消失，
       播放进度不可能跨页继承。

   本脚本让「主内容区局部替换」成为站内默认导航方式：
   fetch 目标页 → 只换掉 <main> 的内容 → 播放器/动态层/音频实例全部原样留存。
   → 音乐无缝续播，进度天然继承（连"保存再恢复"这一步都不需要）。

   ⚠️ 浏览器不会允许"完全未经交互的自动播放"（NotAllowedError）。
      自动播放的解锁逻辑在播放器脚本里（tac-player），本文件不负责。
      本文件只保证：一旦开始播放，跨页不会中断。

   替换边界
   --------------------------------------------------------------------------
       <body>
         <header class="header">   ← 保留（只做导航高亮局部同步）
         <main>                    ← ✅ 唯一替换目标
         <footer class="footer">   ← 保留
         播放器 / 动态层 / 各脚本   ← 保留 → 因此音频实例持久
       </body>

   ⚠️ 用 <main> 而非 body 替换：主题的 header / footer / 播放器都在 main 之外，
      换 body 会把它们一起重建，音频实例当场销毁 —— 那就白做了。

   降级策略（任何一条不满足即退回整页跳转，绝不把用户卡死在半路）
   --------------------------------------------------------------------------
     1. 非 http/https（file:、mailto:、javascript: 等）
     2. 跨域（host 不同）
     3. 带 target / download / data-no-pjax
     4. 修饰键点击（Ctrl/Cmd/Shift/Alt）或非左键
     5. fetch 失败、非 2xx、返回内容里找不到 <main>
     6. 浏览器不支持 history.pushState / fetch / DOMParser

   ⚠️ 曾经还有第 6 条「body 类名不一致则降级（跨栏目）」——**已删除**。
      实测发现它把核心场景挡掉了：首页 body="list"、文章页
      body="post-single"，两者必然不等，于是「首页 → 简报」每次
      都走整页跳转，PJAX 形同虚设。
      正确做法是把 body 的类名跟着一起换（类名承载的正是布局差异），
      而不是拒绝导航。详见 swap() 与 eligible() 的注释。
   ========================================================================== */

(function () {
  'use strict';

  var DEBUG = false;
  function log() {
    if (DEBUG && window.console) console.log.apply(console, ['[pjax]'].concat([].slice.call(arguments)));
  }

  /* ---------- 能力检测：不支持就完全不接管，保持原生导航 ---------- */
  if (!window.fetch || !window.history || !window.history.pushState || !window.DOMParser) {
    log('缺少 fetch / pushState / DOMParser，跳过接管');
    return;
  }

  var REPLACE_SEL = 'main';
  var HEAD_TITLE_SEL = 'title';
  /* 局部替换时同步刷新的 <head> 元素（只挑真正影响渲染的） */
  var HEAD_SYNC = [
    'meta[name="description"]',
    'link[rel="canonical"]',
    'meta[property="og:title"]',
    'meta[property="og:description"]',
    'meta[property="og:url"]'
  ];

  var busy = false;

  /* ==========================================================
     0. 就绪事件：告诉其他模块"内容换好了，请重绑定"
     ========================================================== */
  function announce(detail) {
    try {
      document.dispatchEvent(new CustomEvent('tac:pjax-done', { detail: detail || {} }));
    } catch (e) {
      /* 老浏览器兜底：用 CustomEvent 构造器失败时退回 createEvent */
      try {
        var ev = document.createEvent('CustomEvent');
        ev.initCustomEvent('tac:pjax-done', true, true, detail || {});
        document.dispatchEvent(ev);
      } catch (e2) {}
    }
  }
  function announceStart() {
    document.documentElement.classList.add('is-pjaxing');
  }
  function announceEnd() {
    document.documentElement.classList.remove('is-pjaxing');
  }

  /* ==========================================================
     1. 链接资格判定
     ========================================================== */

  /* ----------------------------------------------------------
     ⚠️ 为什么**不**用 body class 做「跨栏目降级」
     ----------------------------------------------------------
     初版这里有个判断：body className 不一致就降级为整页跳转，
     理由是「不同栏目布局差异大，换了内容不换 body 类会错乱」。

     实测发现这个策略是错的 —— 它把最主要的场景给挡掉了：
     首页 body="list"、文章页 body="post-single"，两者必然不等，
     于是「首页点进简报」这个核心操作**每次都走整页跳转**，
     PJAX 形同虚设，音乐照样中断。

     正确的做法不是拒绝导航，而是**把 body 的类名一起换掉** ——
     body class 承载的正是布局差异，它本来就该跟着内容一起更新。
     换掉之后，list / post-single / home 各自的样式规则会自然生效。

     真正需要拒绝的只有一种情况：目标页没有 <main>（结构不符），
     那才是无法安全替换的。
     ---------------------------------------------------------- */

  function eligible(a) {
    if (!a || !a.href) return false;
    if (a.hasAttribute('download')) return false;
    if (a.hasAttribute('data-no-pjax')) return false;
    if (a.target && a.target !== '_self') return false;

    var url;
    try { url = new URL(a.href, location.href); } catch (e) { return false; }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.host !== location.host) return false;

    /* 纯锚点同页跳转交给浏览器（保留平滑滚动） */
    if (url.pathname === location.pathname && url.search === location.search && url.hash) {
      return false;
    }
    /* 完全同一个 URL（含 hash 差异）不做 PJAX */
    if (url.href === location.href) return false;

    return true;
  }

  /* ==========================================================
     2. 滚动位置记忆（后退回到原位置）
     ========================================================== */
  var scrollStore = {};

  function keyOf(url) {
    var u = new URL(url, location.href);
    return u.pathname + u.search;
  }

  function remember() {
    scrollStore[keyOf(location.href)] = {
      x: window.scrollX || window.pageXOffset || 0,
      y: window.scrollY || window.pageYOffset || 0
    };
  }

  /* ==========================================================
     3. 导航高亮同步
     ========================================================== */
  function syncMenu(url) {
    var menu = document.getElementById('menu');
    if (!menu) return;
    var path = new URL(url, location.href).pathname;
    var links = menu.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var ap;
      try { ap = new URL(a.href, location.href).pathname; } catch (e) { continue; }
      var span = a.querySelector('span');
      if (!span) continue;
      var isHome = (ap === '/' || /\/$/.test(ap) && ap.split('/').filter(Boolean).length === 0);
      var active = isHome
        ? (path === ap)
        : (path === ap || path.indexOf(ap) === 0);
      if (active) span.classList.add('active');
      else span.classList.remove('active');
    }
  }

  /* ==========================================================
     4. 同步 <head> 里的少量元素
     ========================================================== */
  function syncHead(doc) {
    var t = doc.querySelector(HEAD_TITLE_SEL);
    if (t && t.textContent) document.title = t.textContent;

    for (var i = 0; i < HEAD_SYNC.length; i++) {
      var sel = HEAD_SYNC[i];
      var incoming = doc.querySelector(sel);
      var current = document.querySelector(sel);
      if (!incoming) continue;
      if (current) {
        current.setAttribute('content', incoming.getAttribute('content') || '');
        if (incoming.hasAttribute('href')) {
          current.setAttribute('href', incoming.getAttribute('href'));
        }
      } else {
        /* 当前页没有就补一个（极少见） */
        try { document.head.appendChild(incoming.cloneNode(true)); } catch (e) {}
      }
    }
  }

  /* ==========================================================
     5. 执行替换
     ========================================================== */

  /* ----------------------------------------------------------
     5.0 重执行 <script>
     ----------------------------------------------------------
     ⚠️ 这是 PJAX 最经典的坑，必读：

     用 innerHTML 插入的 <script> 标签**不会被执行**（HTML 规范规定，
     经 innerHTML / insertAdjacentHTML 注入的脚本处于"惰性"状态）。
     本站在 <main> 内确实有脚本 —— 评论区是 Giscus 注入的：

         <script src="https://giscus.app/client.js" data-repo=...></script>

     不做处理的话，PJAX 切到文章页后**评论框会静默消失**，
     且控制台无任何报错（脚本只是没跑）。

     处理办法：把惰性脚本替换成新创建的等效脚本（新建的会执行）。
     · 外部脚本：复制所有属性（src / data-* / crossorigin 等）
     · 内联脚本：复制 textContent
     · ⚠️ 不搬运 async / defer：我们要的是"现在立刻执行"，
          搬运这两个属性会让重新执行时机变得不可预期。
     ========================================================== */
  function reviveScripts(container) {
    var dead = container.querySelectorAll('script');
    if (!dead.length) return;

    Array.prototype.forEach.call(dead, function (old) {
      var s = document.createElement('script');

      /* 复制全部属性 */
      for (var i = 0; i < old.attributes.length; i++) {
        var at = old.attributes[i];
        var name = at.name;
        if (name === 'async' || name === 'defer') continue;
        try { s.setAttribute(name, at.value); } catch (e) {}
      }

      if (!old.src) s.textContent = old.textContent;
      /* ⚠️ 必须替换而不是 append：留着旧的惰性脚本毫无意义，
            还可能与新脚本重复注册监听（Giscus 会重复挂 iframe）。 */
      old.parentNode.replaceChild(s, old);
    });

    log('重执行脚本', dead.length, '个');
  }

  function swap(doc, url, opts) {
    var incoming = doc.querySelector(REPLACE_SEL);
    var current = document.querySelector(REPLACE_SEL);
    if (!incoming || !current) return false;

    /* 换掉内容。用 innerHTML 而非 replaceWith(节点)：
       ⚠️ replaceWith 传节点会把 <main> 元素本身换掉，
          而主题有 CSS 依赖 main 上的类（如 .main）。
          这里只换内部，保留 <main> 元素及其属性。 */
    current.className = incoming.className || current.className;
    current.innerHTML = incoming.innerHTML;

    /* ⚠️ 必须在 innerHTML 之后立刻调用 —— 评论区的 Giscus 脚本
       否则会静默不执行（详见函数注释）。 */
    reviveScripts(current);

    /* ----------------------------------------------------------
       同步 <body> 的类名
       ----------------------------------------------------------
       ⚠️ 这一步是必须的，不是"防御性代码"：
       list / home 这些类名承载着布局差异（栏宽、侧边栏、卡片样式），
       只换 <main> 而不换 body 类，会出现「正文被套进了首页布局里」。

       ⚠️ 实测各页面的 body class（务必注意文章页是**空**的）：
             首页   → class="list"
             文章页 → 无 class
             归档页 → class="list"
             标签页 → class="list"

       所以**不能**写 `if (nextBodyClass) body.className = nextBodyClass` ——
       目标页 class 为空时那个 if 会把赋值整个跳过，导致首页的 "list"
       残留到文章页上，命中 .list 相关样式规则（隐患）。
       必须无条件赋值（空字符串也要赋），才能正确清掉旧类。
       ---------------------------------------------------------- */
    var nextBodyClass = (doc.body && doc.body.className) || '';
    document.body.className = nextBodyClass;

    /* ⚠️ body 上还有 id="top"（用于"回到顶部"锚点）与访问键等属性。
       className 赋值不影响它们，但这里显式确认一下，
       防止将来有人改成 setAttribute('class') 时误伤。 */

    syncHead(doc);
    syncMenu(url);

    return true;
  }

  /* ==========================================================
     6. 主流程
     ========================================================== */
  function go(url, opts) {
    opts = opts || {};
    if (busy) return;

    var target;
    try { target = new URL(url, location.href); } catch (e) { location.href = url; return; }

    busy = true;
    announceStart();

    /* 前进/后退时不记忆当前位置（浏览器已存好），普通点击时记 */
    if (!opts.pop) remember();

    fetch(target.href, {
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'TACPJAX' }
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var ct = res.headers.get('content-type') || '';
        if (ct && ct.indexOf('text/html') === -1) throw new Error('非 HTML 响应');
        return res.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var incomingMain = doc.querySelector(REPLACE_SEL);
        if (!incomingMain) throw new Error('目标页缺少 ' + REPLACE_SEL);

        if (!swap(doc, target.href, opts)) throw new Error('替换失败');

        /* 历史与滚动 */
        if (!opts.pop) {
          history.pushState({ tacpjax: true, url: target.href }, '', target.href);
        }

        var saved = opts.pop ? scrollStore[keyOf(target.href)] : null;

        /* 先滚到顶再按需恢复。用 requestAnimationFrame 等一帧让布局稳定，
           ⚠️ 不能直接同步滚动：此时新内容尚未完成布局，scrollTo 会被吞掉。 */
        requestAnimationFrame(function () {
          if (saved) {
            window.scrollTo(saved.x || 0, saved.y || 0);
          } else if (!opts.keepScroll) {
            window.scrollTo(0, 0);
          }
          announceEnd();
          busy = false;
          announce({ url: target.href, pop: !!opts.pop });
          log('已切换到', target.href);
        });
      })
      .catch(function (err) {
        log('降级整页跳转：', err && err.message);
        announceEnd();
        busy = false;
        /* 原生跳转。用 assign 而非 href= ，语义一致且不新增历史项。 */
        location.assign(target.href);
      });
  }

  /* ==========================================================
     7. 事件绑定
     ========================================================== */

  /* 7.1 链接点击拦截（事件委托，覆盖动态插入的内容） */
  document.addEventListener('click', function (e) {
    /* 只处理无修饰键的左键单击 */
    if (e.defaultPrevented) return;
    if (e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    /* 用 composedPath 穿透 shadow DOM；退化时用 closest */
    var a = null;
    if (e.target && e.target.closest) {
      a = e.target.closest('a');
    }
    if (!a) return;

    if (!eligible(a)) return;

    /* 弹窗内容（如外链确认）自行处理时让出 */
    e.preventDefault();
    go(a.href);
  }, false);

  /* 7.2 前进 / 后退 */
  window.addEventListener('popstate', function (e) {
    var url = e.state && e.state.url ? e.state.url : location.href;
    /* 同 URL 的 hash 变化由浏览器自行处理 */
    go(url, { pop: true });
  });

  /* 7.3 首屏状态打标：让浏览器把当前页也纳入 PJAX 历史模型，
         这样从第二页点后退能正确回到第一页而非直接退出站点。 */
  try {
    history.replaceState({ tacpjax: true, url: location.href }, '', location.href);
  } catch (e) {}

  /* 7.4 预取：鼠标悬停 120ms 后预取，点击时几乎瞬开
         ⚠️ 用 <link rel=prefetch> 让浏览器自己管缓存，别自己 fetch 一遍，
            否则等于请求两次。 */
  var hoverTimer = null;
  var lastPrefetch = '';
  document.addEventListener('mouseover', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!a || !eligible(a)) return;
    if (a.href === lastPrefetch) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(function () {
      lastPrefetch = a.href;
      var l = document.createElement('link');
      l.rel = 'prefetch';
      l.href = a.href;
      l.as = 'document';
      document.head.appendChild(l);
      setTimeout(function () {
        if (l.parentNode) l.parentNode.removeChild(l);
      }, 8000);
    }, 120);
  }, false);
  document.addEventListener('mouseout', function () { clearTimeout(hoverTimer); }, false);

  /* 7.5 暴露给其他模块（调试与手动触发用） */
  window.TACPJAX = {
    go: go,
    isEnabled: true,
    version: '1.0'
  };

  log('PJAX 已就绪');
})();
