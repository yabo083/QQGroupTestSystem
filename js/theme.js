/**
 * 主题控制：自动（跟随系统）/ 浅色 / 深色
 *
 * 在 <head> 中同步加载（非 async/defer），保证 <html> 上的 data-theme 在任何
 * 元素进入布局前就已确定，避免首屏闪烁。样式表里 :root 的浅色令牌是默认值，
 * @media (prefers-color-scheme: dark) 覆盖自动模式，[data-theme] 覆盖手动模式。
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'exam-theme';
    var MODES = ['auto', 'light', 'dark'];
    var MODE_ICON = { auto: '#i-monitor', light: '#i-sun', dark: '#i-moon' };
    var MODE_LABEL = { auto: '跟随系统', light: '浅色', dark: '深色' };
    var THEME_COLOR = { light: '#f5f6f8', dark: '#0e1013' };

    function readMode() {
        try {
            var saved = localStorage.getItem(STORAGE_KEY);
            return MODES.indexOf(saved) >= 0 ? saved : 'auto';
        } catch (e) {
            return 'auto';
        }
    }

    function writeMode(mode) {
        try {
            if (mode === 'auto') localStorage.removeItem(STORAGE_KEY);
            else localStorage.setItem(STORAGE_KEY, mode);
        } catch (e) {
            /* 隐私模式等场景下不可写，忽略即可 */
        }
    }

    var mode = readMode();

    /**
     * 显式主题时用一个不含 media 的 theme-color 覆盖头部的两个媒体查询版本；
     * 自动模式则移除它，把控制权交还给那两个 meta。
     */
    function syncThemeColor() {
        var managed = document.querySelector('meta[name="theme-color"][data-managed]');
        if (managed) managed.parentNode.removeChild(managed);
        if (mode === 'auto') return;
        var meta = document.createElement('meta');
        meta.setAttribute('name', 'theme-color');
        meta.setAttribute('content', THEME_COLOR[mode]);
        meta.setAttribute('data-managed', '');
        document.head.appendChild(meta);
    }

    function nextMode() {
        return MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    }

    function apply() {
        var root = document.documentElement;
        if (mode === 'auto') root.removeAttribute('data-theme');
        else root.setAttribute('data-theme', mode);
        syncThemeColor();

        var button = document.getElementById('theme-toggle');
        if (!button) return;
        button.querySelector('use').setAttribute('href', MODE_ICON[mode]);
        var label = '主题：' + MODE_LABEL[mode] + '，点击切换到' + MODE_LABEL[nextMode()];
        button.setAttribute('title', label);
        button.setAttribute('aria-label', label);
    }

    function mount() {
        if (document.getElementById('theme-toggle')) return;
        var button = document.createElement('button');
        button.id = 'theme-toggle';
        button.type = 'button';
        button.className = 'theme-toggle';
        button.innerHTML = '<svg class="icon" aria-hidden="true"><use href="' + MODE_ICON[mode] + '"/></svg>';
        button.addEventListener('click', function () {
            mode = nextMode();
            writeMode(mode);
            apply();
        });
        document.body.appendChild(button);
        apply();
    }

    apply();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
})();
