/* ============================================================
   下拉菜单交互（2026-10-27）
   ------------------------------------------------------------
   桌面端靠 CSS :hover / :focus-within 展开，不需要 JS。
   本文件只处理两件事：

   1. 移动端（<=768px）点击父项展开子菜单，而不是跳转
      —— 窄屏没有 hover，纯 CSS 方案点不到子项。
   2. 点击页面其他地方 / 按 Esc 收起所有已展开的菜单

   ⚠️ 只绑到 .has-submenu 的 <a>，不影响普通菜单项。
   ============================================================ */
(function () {
  'use strict';

  var MQ = window.matchMedia('(max-width: 768px)');

  function closeAll(except) {
    var open = document.querySelectorAll('.has-submenu.is-open');
    for (var i = 0; i < open.length; i++) {
      if (open[i] !== except) open[i].classList.remove('is-open');
    }
  }

  function init() {
    var links = document.querySelectorAll('#menu .has-submenu > a');

    for (var i = 0; i < links.length; i++) {
      links[i].addEventListener('click', function (e) {
        // 桌面端交给 CSS，不拦截
        if (!MQ.matches) return;

        var li = this.parentElement;
        var sub = li.querySelector(':scope > ul.submenu');
        if (!sub) return;

        // 移动端：点父项先展开，再点才跳转
        if (!li.classList.contains('is-open')) {
          e.preventDefault();
          closeAll(li);
          li.classList.add('is-open');
        }
      });
    }

    // 点空白处收起
    document.addEventListener('click', function (e) {
      if (!MQ.matches) return;
      if (!e.target.closest('#menu')) closeAll(null);
    });

    // Esc 收起
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeAll(null);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
