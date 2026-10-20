// ==UserScript==
// @name         猫眼扫描工具
// @namespace    https://example.com/
// @version      8.6
// @description  蓝白 iOS 风格猫眼扫描、智能15条历史记录、扫描框记忆、蓝白小猫悬浮球、设置、固定主界面、字体调整、自动高亮页面二维码、扫描时间标记（修复跨域与小二维码识别；修正位置记忆、字体输入、请求超时与链接安全；性能优化）
// @author       MOYU
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      *
// @require      https://cdn.jsdelivr.net/npm/jsqr/dist/jsQR.js
// @require      https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js
// @noframes
// @run-at       document-idle
// ==/UserScript==

/* eslint-env greasemonkey */
/* global jsQR, html2canvas, GM_xmlhttpRequest */

(function () {
'use strict';

// 只在顶层窗口运行，避免 iframe 内重复创建 UI
if (window.top !== window.self) return;

if (window.__webQrScannerLoaded79) return;
window.__webQrScannerLoaded79 = true;

// =========================================================
// 存储
// =========================================================

const KEY = {
    panel: 'webqr_panel_state_77',
    folded: 'webqr_folded_ratio_77',
    scanBox: 'webqr_scan_box_77',
    fixedPanel: 'webqr_fixed_panel_77',
    fontSize: 'webqr_font_size_77',
    history: 'webqr_scan_history_79'
};

const MAX_HISTORY = 15;

// =========================================================
// 配置（蓝白 iOS 主题）
// =========================================================

const C = {
    primary: '#007AFF',
    primaryDark: '#0055CC',
    gradientStart: '#E8F2FF',
    gradientEnd: '#C7E0FF',
    border: 'rgba(0,0,0,0.08)',
    text: '#1C1C1E',
    lightText: '#8E8E93',
    superLightText: '#AEAEB2',
    bg: 'rgba(255,255,255,0.85)',
    cardBg: 'rgba(240,244,248,0.9)',
    shadow: '0 8px 32px rgba(0,0,0,0.08)',
    fontSans: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif',
    fontMono: 'SF Mono, "SFMono-Regular", "JetBrains Mono", Consolas, monospace'
};

// ---- 性能优化调整 ----
const MAX_IMAGE_SIZE = 1200;        // 提高至 1200，保留更多细节
const MAX_IMAGE_SIZE_LARGE = 2000;  // 二次尝试时允许更大尺寸
const MULTI_DEPTH = 2;              // 多区域扫描深度（手动框选，更彻底）
const AUTO_MULTI_DEPTH = 1;         // 自动扫描只扫四象限，8 张图同时扫时不至于太慢
const LARGE_QR_RATIO = 0.22;
const MAX_CONCURRENT_IMAGES = 2;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 30;
const DEFAULT_FONT_SIZE = 13;
const MAX_AUTO_SCAN_IMAGES = 8;
const MAX_SCREENSHOT_PIXELS = 8000000;
const GM_REQUEST_TIMEOUT = 15000;   // GM 跨域图片请求超时
const SCREENSHOT_TIMEOUT = 20000;   // html2canvas 截图总超时
// ----------------------

// 允许点击打开的协议（拦截 javascript:/data: 等危险协议）
const SAFE_LINK_PROTOCOLS = ['http:', 'https:', 'magnet:', 'thunder:', 'ed2k:'];

const LINK_REGEX =
    /(https?:\/\/pan\.baidu\.com\/s\/[a-zA-Z0-9_-]+)(?:\?pwd=([a-zA-Z0-9]{4}))?/gi;

const PWD_REGEX =
    /(?:提取码|密码|pwd|访问码)\s*[:：]?\s*([a-zA-Z0-9]{4})/i;

// =========================================================
// 全局
// =========================================================

let host = null;
let shadow = null;
let panel = null;
let foldedBtn = null;
let resultArea = null;
let historyPanel = null;
let scanSession = null;

let historyOpen = false;
let lastScanSignature = '';
let lastScanTime = 0;
let lastAppliedFontSize = null;

// 一次只允许一个识别流程，避免连点按钮时并行跑多份截图/识别
let scanInProgress = false;

let loadingOverlayEl = null;
let settingsPanelEl = null;
let settingsBtnEl = null;
let historyBtnEl = null;
let foldMainBtnEl = null;
let fixedFloatEl = null;
let fontSizeInputEl = null;
let resetScanBoxEl = null;
let resetPanelEl = null;
let scanBtnEl = null;
let panelResizeEl = null;
let autoScanBtnEl = null;

let highlightedImages = new Set();

let scanResultTime = 0;
let resultTimeInterval = null;

// =========================================================
// 存储辅助
// =========================================================

// GM_getValue 每次都是同步的 IPC 调用；resize / visualViewport.scroll 会连续触发，
// 因此这里只在首次读取时落盘，之后全部走内存缓存。
const storeCache = new Map();

function get(key, fallback) {
    let value;

    if (storeCache.has(key)) {
        value = storeCache.get(key);
    } else {
        value = GM_getValue(key, null);
        storeCache.set(key, value);
    }

    // removeValue() 会写入 null，这里统一回退到默认值，
    // 否则 Number(null) === 0 会把字体/位置等状态读成 0。
    if (value === null || value === undefined) return fallback;

    return value;
}

function set(key, value) {
    storeCache.set(key, value);
    GM_setValue(key, value);
}

function removeValue(key) {
    storeCache.set(key, null);
    GM_setValue(key, null);
}

// =========================================================
// 依赖检查
// =========================================================

function loadJsQR(done) {
    if (typeof window.jsQR === 'function') {
        done();
    } else {
        alert('二维码识别库加载失败，请检查网络或脚本管理器设置');
    }
}

function loadHtml2Canvas(done) {
    if (typeof window.html2canvas === 'function') {
        done(null);
    } else {
        done(new Error('html2canvas 加载失败'));
    }
}

// =========================================================
// 百度网盘链接提取
// =========================================================

function extractLinks(text) {
    if (!text) return [];

    const result = [];
    LINK_REGEX.lastIndex = 0;

    let match;

    while ((match = LINK_REGEX.exec(text)) !== null) {
        let pwd = match[2] || '';

        if (!pwd) {
            const index = match.index || 0;

            const nearby = text.slice(
                Math.max(0, index - 200),
                Math.min(
                    text.length,
                    index + match[0].length + 200
                )
            );

            const pwdMatch = nearby.match(PWD_REGEX);

            if (pwdMatch) {
                pwd = pwdMatch[1];
            }
        }

        result.push(
            pwd
                ? `${match[1]}?pwd=${pwd}`
                : match[1]
        );
    }

    return result;
}

function extractResultLinks(data) {
    const links = extractLinks(data);

    if (links.length) {
        return links;
    }

    if (
        typeof data === 'string' &&
        data.trim()
    ) {
        return [data.trim()];
    }

    return [];
}

// =========================================================
// 链接安全
// =========================================================

function toSafeHref(value) {
    const text = String(value || '').trim();

    if (!text) return '';

    try {
        const url = new URL(text, window.location.href);

        return SAFE_LINK_PROTOCOLS.indexOf(url.protocol) >= 0 ? text : '';
    } catch (_) {
        return '';
    }
}

function createLinkElement(value, className) {
    const text = String(value || '').trim();

    const anchor = document.createElement('a');
    anchor.className = className;
    anchor.textContent = text;

    const href = toSafeHref(text);

    if (href) {
        anchor.href = href;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
    } else {
        // 非网页链接（如 javascript:）只展示和复制，避免被点击执行
        anchor.title = '该内容不是可打开的链接，可复制后使用';
    }

    return anchor;
}

// =========================================================
// Shadow DOM Host
// =========================================================

function ensureHost() {
    // host 只是被页面脚本移出 DOM 时，重新挂回即可，
    // 不能重建，否则 shadow 里的面板实例会全部丢失。
    if (host && shadow) {
        if (!host.isConnected) {
            document.documentElement.appendChild(host);
        }
        return;
    }

    host = document.createElement('div');
    host.id = '__webqr_host_79';

    Object.assign(host.style, {
        position: 'fixed',
        left: '0',
        top: '0',
        width: '0',
        height: '0',
        margin: '0',
        padding: '0',
        border: '0',
        background: 'transparent',
        pointerEvents: 'none',
        zIndex: '2147483647',
        overflow: 'visible',
        transform: 'none',
        zoom: '1',
        contain: 'none',
        isolation: 'isolate'
    });

    shadow = host.attachShadow({
        mode: 'open'
    });

    const style = document.createElement('style');

    style.textContent = `
        :host {
            all: initial !important;
            position: static !important;
            display: block !important;
        }

        *, *::before, *::after {
            box-sizing: border-box;
        }

        button, a, input {
            font: inherit;
        }

        #panel {
            position: fixed !important;
            left: auto;
            top: auto;
            width: 280px;
            height: 220px;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            margin: 0 !important;

            background: ${C.bg};

            backdrop-filter: blur(30px) saturate(180%);
            -webkit-backdrop-filter: blur(30px) saturate(180%);

            border: 1px solid ${C.border};
            border-radius: 24px;

            box-shadow:
                ${C.shadow},
                0 2px 8px rgba(0,0,0,0.04);

            color: ${C.text};
            font-family: ${C.fontSans};
            font-size: 13px;

            pointer-events: auto !important;

            transform: none !important;
            zoom: 1 !important;

            isolation: isolate;
        }

        #panel[hidden] {
            display: none !important;
        }

        #panel::after {
            content: '';
            position: absolute;
            inset: 0;

            background-image:
                url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.015'/%3E%3C/svg%3E");

            pointer-events: none;
            z-index: 1;
        }

        #panel::before {
            content: '';
            position: absolute;
            inset: -20%;

            background:
                radial-gradient(
                    circle at 20% 20%,
                    rgba(0,122,255,0.05),
                    transparent 60%
                ),

                radial-gradient(
                    circle at 80% 80%,
                    rgba(0,122,255,0.03),
                    transparent 60%
                );

            pointer-events: none;
            z-index: 0;
        }

        #title {
            height: 54px;
            flex-shrink: 0;

            display: flex;
            align-items: center;
            justify-content: space-between;

            padding: 0 20px;

            background: transparent;

            border-bottom:
                0.5px solid rgba(0,0,0,0.05);

            cursor: move;
            user-select: none;

            position: relative;
            z-index: 2;
        }

        .title-left {
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .title-icon {
            display: flex;
            align-items: center;
            justify-content: center;

            width: 30px;
            height: 30px;

            border-radius: 10px;

            background:
                rgba(0,122,255,0.08);

            box-shadow:
                0 0 10px rgba(0,122,255,0.08);
        }

        .title-text {
            font-weight: 600;
            font-size: 1.15em;
            letter-spacing: -0.01em;
            color: ${C.text};
        }

        #actions {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .circle {
            width: 36px;
            height: 36px;

            padding: 0;
            margin: 0;

            border: 0;
            border-radius: 50%;

            background:
                rgba(0,0,0,0.03);

            color: ${C.lightText};

            display: flex;
            align-items: center;
            justify-content: center;

            cursor: pointer;
            line-height: 1;

            transition:
                background 0.2s ease,
                color 0.2s ease,
                box-shadow 0.2s ease,
                transform 0.12s ease;

            box-shadow:
                inset
                0 0 0
                0.5px
                rgba(0,0,0,0.05);
        }

        .circle:hover {
            background:
                rgba(0,0,0,0.06);

            color: ${C.primary};

            box-shadow:
                inset
                0 0 0
                0.5px
                rgba(0,122,255,0.2);
        }

        .circle:active {
            transform: scale(0.92);
        }

        .circle:focus-visible,
        .copy-btn:focus-visible,
        .history-copy:focus-visible,
        #clearHistoryBtn:focus-visible,
        .settings-btn:focus-visible,
        #scanBtn:focus-visible,
        #autoScanBtn:focus-visible,
        .scan-action:focus-visible {
            outline:
                2px solid
                rgba(0,122,255,0.35);

            outline-offset: 2px;
        }

        #historyBtn {
            font-size: 1.3em;
        }

        #settingsBtn {
            font-size: 1.38em;
        }

        #foldMainBtn {
            font-size: 1.15em;
        }

        #content {
            flex: 1;
            min-height: 0;

            display: flex;
            flex-direction: column;

            gap: 16px;
            padding: 20px;

            overflow: hidden;

            position: relative;
            z-index: 2;
        }

        #scanBtn, #autoScanBtn {
            flex-shrink: 0;

            padding: 12px 18px;

            border: 0;
            border-radius: 14px;

            background: ${C.primary};

            color: #fff;

            cursor: pointer;

            font-weight: 600;
            font-size: 1em;
            letter-spacing: 0.02em;

            box-shadow: 0 2px 8px rgba(0,122,255,0.2);

            transition:
                background 0.2s ease,
                box-shadow 0.2s ease,
                transform 0.12s ease;

            font-family: ${C.fontSans};
        }

        #autoScanBtn {
            margin-top: 10px;
            background: rgba(0,122,255,0.1);
            color: ${C.primary};
            border: 0.5px solid rgba(0,122,255,0.2);
            box-shadow: none;
        }

        #scanBtn:hover, #autoScanBtn:hover {
            background: ${C.primaryDark};
            box-shadow: 0 4px 12px rgba(0,122,255,0.3);
        }

        #autoScanBtn:hover {
            background: rgba(0,122,255,0.2);
            box-shadow: 0 2px 6px rgba(0,122,255,0.2);
        }

        #scanBtn:active, #autoScanBtn:active {
            transform: scale(0.98);
            box-shadow: 0 1px 4px rgba(0,122,255,0.2);
        }

        #results {
            flex: 1;
            min-height: 0;

            overflow-y: auto;

            overscroll-behavior: contain;
            -webkit-overflow-scrolling: touch;

            display: flex;
            flex-direction: column;

            gap: 12px;
            padding-right: 2px;
        }

        .result-title {
            padding: 12px 16px;

            border-radius: 14px;

            background: rgba(0,0,0,0.03);

            color: ${C.lightText};

            font-weight: 500;
            font-size: 0.92em;

            letter-spacing: 0.04em;

            border: none;

            display: flex;
            align-items: center;
            gap: 8px;
        }

        #resultTime {
            color: ${C.superLightText};
            font-size: 0.85em;
            font-weight: 400;
        }

        .result {
            padding: 14px 16px;

            border-radius: 14px;

            background: ${C.cardBg};

            border: 0.5px solid rgba(0,0,0,0.03);

            box-shadow: 0 1px 3px rgba(0,0,0,0.02);

            transition:
                background 0.2s ease,
                box-shadow 0.2s ease;
        }

        .result:hover {
            background: #fff;

            box-shadow: 0 4px 10px rgba(0,0,0,0.05);
        }

        .result-num {
            margin-bottom: 8px;

            color: ${C.superLightText};

            font-size: 0.77em;
            font-weight: 500;

            letter-spacing: 0.04em;

            font-family: ${C.fontMono};
        }

        .result-row {
            display: flex;
            align-items: center;

            gap: 10px;
        }

        .result-link {
            flex: 1;
            min-width: 0;

            color: ${C.primaryDark};

            text-decoration: none;

            word-break: break-all;

            line-height: 1.4;

            font-family: ${C.fontMono};

            font-size: 0.92em;
            font-weight: 500;

            transition: color 0.2s ease;
        }

        .result-link:hover {
            color: ${C.primary};
            text-decoration: underline;
        }

        .copy-btn {
            flex-shrink: 0;

            padding: 6px 12px;

            border: 0;
            border-radius: 8px;

            background: rgba(0,122,255,0.08);

            color: ${C.primary};

            cursor: pointer;

            font-size: 0.85em;
            font-weight: 600;
            letter-spacing: 0.02em;

            transition: background 0.2s ease, transform 0.12s ease;

            font-family: ${C.fontSans};
        }

        .copy-btn:hover {
            background: rgba(0,122,255,0.18);
        }

        .copy-btn:active {
            transform: scale(0.96);
        }

        .error {
            padding: 14px 16px;

            border-radius: 14px;

            background: rgba(255,59,48,0.05);

            border: 0.5px solid rgba(255,59,48,0.2);

            color: #FF3B30;

            line-height: 1.5;
            font-size: 0.92em;

            white-space: pre-line;
        }

        #settingsPanel {
            position: absolute !important;

            top: 60px;
            right: 16px;

            width: 220px;

            max-height: calc(100% - 76px);

            overflow-y: auto;

            padding: 18px;

            background: rgba(255,255,255,0.9);

            backdrop-filter: blur(30px) saturate(180%);
            -webkit-backdrop-filter: blur(30px) saturate(180%);

            border: 0.5px solid rgba(0,0,0,0.06);

            border-radius: 20px;

            box-shadow: 0 12px 40px rgba(0,0,0,0.1);

            z-index: 1000;

            display: none;

            color: ${C.text};

            font-size: 1em;

            font-family: ${C.fontSans};
        }

        #settingsPanel.show {
            display: block;
        }

        .settings-title {
            margin-bottom: 18px;

            font-weight: 600;
            font-size: 1em;

            letter-spacing: 0.02em;

            color: ${C.lightText};
        }

        .settings-switch-row {
            display: flex;
            align-items: center;
            justify-content: space-between;

            gap: 12px;

            padding: 8px 0 18px;
        }

        .settings-switch-label {
            color: ${C.lightText};

            font-size: 0.92em;

            user-select: none;
        }

        .switch {
            position: relative;

            width: 46px;
            height: 26px;

            flex-shrink: 0;

            padding: 0;
            border: 0;

            border-radius: 999px;

            cursor: pointer;

            background: rgba(0,0,0,0.1);

            transition: background 0.2s ease;

            box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.05);
        }

        .switch.off {
            background: rgba(0,0,0,0.1);
        }

        .switch.on {
            background: ${C.primary};

            box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.05), 0 2px 6px rgba(0,122,255,0.3);
        }

        .switch-knob {
            position: absolute;

            top: 3px;
            left: 3px;

            width: 20px;
            height: 20px;

            border-radius: 50%;

            background: #fff;

            box-shadow: 0 2px 4px rgba(0,0,0,0.2);

            transition: transform 0.2s ease;
        }

        .switch.on .switch-knob {
            transform: translateX(20px);
        }

        .switch:focus-visible {
            outline: 2px solid ${C.primary};
            outline-offset: 2px;
        }

        .font-setting {
            padding: 8px 0 18px;
        }

        .font-setting-head {
            display: flex;
            align-items: center;
            justify-content: space-between;

            gap: 12px;

            color: ${C.lightText};
        }

        .font-input-wrap {
            display: flex;

            align-items: center;

            gap: 6px;

            color: ${C.superLightText};

            font-size: 0.85em;
        }

        .font-input {
            width: 58px;
            height: 30px;

            padding: 4px 8px;

            border: 0.5px solid rgba(0,0,0,0.1);

            border-radius: 8px;

            background: #fff;

            color: ${C.text};

            text-align: center;

            outline: none;

            font-family: ${C.fontMono};

            font-size: 0.92em;

            transition: border-color 0.2s ease, box-shadow 0.2s ease;
        }

        .font-input:focus {
            border-color: ${C.primary};

            box-shadow: 0 0 0 2px rgba(0,122,255,0.15);
        }

        .settings-btn {
            width: 100%;

            padding: 9px 14px;

            margin-top: 8px;

            border: 0.5px solid rgba(0,0,0,0.06);

            border-radius: 10px;

            background: rgba(0,0,0,0.02);

            color: ${C.lightText};

            cursor: pointer;

            text-align: left;

            font-size: 0.85em;

            letter-spacing: 0.02em;

            transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease, transform 0.12s ease;
        }

        .settings-btn:hover {
            background: rgba(0,0,0,0.04);

            border-color: rgba(0,122,255,0.2);

            color: ${C.text};
        }

        .settings-btn:active {
            transform: scale(0.98);
        }

        .settings-actions {
            display: flex;

            gap: 8px;

            margin-top: 10px;
        }

        .settings-actions .settings-btn {
            flex: 1;

            width: auto;

            margin-top: 0;

            padding: 8px 10px;

            font-size: 0.77em;

            text-align: center;

            white-space: nowrap;

            overflow: hidden;

            text-overflow: ellipsis;

            border-radius: 10px;
        }

        .settings-actions .settings-btn:hover {
            background: rgba(0,122,255,0.06);

            border-color: rgba(0,122,255,0.3);

            color: ${C.primary};
        }

        #historyPanel {
            position: absolute !important;

            top: 60px;
            right: 16px;

            width: min(320px, calc(100% - 24px));

            max-height: calc(100% - 76px);

            overflow: hidden;

            padding: 14px;

            background: rgba(255,255,255,0.94);

            backdrop-filter: blur(30px) saturate(180%);
            -webkit-backdrop-filter: blur(30px) saturate(180%);

            border: 0.5px solid rgba(0,0,0,0.06);

            border-radius: 20px;

            box-shadow: 0 12px 40px rgba(0,0,0,0.1);

            z-index: 1100;

            display: none;

            color: ${C.text};

            font-size: 1em;

            font-family: ${C.fontSans};
        }

        #historyPanel.show {
            display: flex;

            flex-direction: column;
        }

        .history-head {
            display: flex;

            align-items: center;

            justify-content: space-between;

            gap: 10px;

            padding: 2px 2px 10px;

            flex-shrink: 0;
        }

        .history-title {
            color: ${C.text};

            font-weight: 600;

            font-size: 1em;

            letter-spacing: 0.02em;
        }

        .history-count {
            color: ${C.superLightText};

            font-size: 0.78em;

            font-family: ${C.fontMono};
        }

        #historyList {
            min-height: 0;

            overflow-y: auto;

            overscroll-behavior: contain;

            -webkit-overflow-scrolling: touch;

            display: flex;

            flex-direction: column;

            gap: 8px;

            padding-right: 2px;
        }

        .history-empty {
            padding: 18px 10px;

            border-radius: 12px;

            background: rgba(0,0,0,0.025);

            color: ${C.lightText};

            text-align: center;

            line-height: 1.5;

            font-size: 0.86em;
        }

        .history-item {
            padding: 10px 11px;

            border-radius: 13px;

            background: rgba(240,244,248,0.78);

            border: 0.5px solid rgba(0,0,0,0.035);

            box-shadow: 0 1px 3px rgba(0,0,0,0.02);

            transition: background 0.2s ease, box-shadow 0.2s ease;
        }

        .history-item:hover {
            background: #fff;

            box-shadow: 0 4px 10px rgba(0,0,0,0.05);
        }

        .history-meta {
            display: flex;

            align-items: center;

            justify-content: space-between;

            gap: 8px;

            margin-bottom: 6px;

            color: ${C.superLightText};

            font-size: 0.72em;

            font-family: ${C.fontMono};
        }

        .history-link-row {
            display: flex;

            align-items: flex-start;

            gap: 8px;
        }

        .history-link {
            flex: 1;

            min-width: 0;

            display: -webkit-box;

            -webkit-box-orient: vertical;

            -webkit-line-clamp: 3;

            overflow: hidden;

            color: ${C.primaryDark};

            text-decoration: none;

            word-break: break-all;

            line-height: 1.38;

            font-family: ${C.fontMono};

            font-size: 0.83em;

            font-weight: 500;
        }

        .history-link:hover {
            color: ${C.primary};

            text-decoration: underline;
        }

        .history-copy {
            flex-shrink: 0;

            padding: 5px 9px;

            border: 0;

            border-radius: 8px;

            background: rgba(0,122,255,0.08);

            color: ${C.primary};

            cursor: pointer;

            font-size: 0.77em;

            font-weight: 600;

            font-family: ${C.fontSans};

            transition: background 0.2s ease, transform 0.12s ease;
        }

        .history-copy:hover {
            background: rgba(0,122,255,0.16);
        }

        .history-copy:active {
            transform: scale(0.96);
        }

        .history-footer {
            display: flex;

            justify-content: flex-end;

            padding-top: 10px;

            flex-shrink: 0;
        }

        #clearHistoryBtn {
            padding: 7px 11px;

            border: 0.5px solid rgba(0,0,0,0.06);

            border-radius: 9px;

            background: rgba(0,0,0,0.025);

            color: ${C.lightText};

            cursor: pointer;

            font-size: 0.77em;

            font-family: ${C.fontSans};

            transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease;
        }

        #clearHistoryBtn:hover {
            background: rgba(255,59,48,0.07);

            color: #FF3B30;

            border-color: rgba(255,59,48,0.18);
        }

        #foldedBtn {
            position: fixed !important;

            left: auto !important;

            width: 54px;

            height: 54px;

            padding: 0;

            margin: 0 !important;

            display: flex;

            align-items: center;

            justify-content: center;

            background: rgba(255,255,255,0.85);

            backdrop-filter: blur(12px);

            -webkit-backdrop-filter: blur(12px);

            border: 0.5px solid rgba(0,0,0,0.08);

            border-radius: 50%;

            box-shadow: 0 7px 24px rgba(0,0,0,0.1), 0 0 16px rgba(0,122,255,0.05);

            cursor: pointer;

            pointer-events: auto !important;

            user-select: none;

            transform: none !important;

            zoom: 1 !important;

            z-index: 2147483647 !important;

            overflow: hidden;

            transition: right 0.25s ease, transform 0.2s ease;
        }

        #foldedBtn:hover {
            right: 0 !important;

            transform: scale(1.08) !important;

            box-shadow: 0 9px 26px rgba(0,0,0,0.15), 0 0 24px rgba(0,122,255,0.15);
        }

        #foldedBtn:active {
            transform: scale(1.02) !important;
        }

        #foldedBtn svg {
            width: 44px;

            height: 44px;

            display: block;

            pointer-events: none;
        }

        #panelResize {
            position: absolute !important;

            right: 0;

            bottom: 0;

            width: 20px;

            height: 20px;

            cursor: nwse-resize;

            background: linear-gradient(135deg, transparent 50%, rgba(0,122,255,0.3) 50%);

            border-bottom-right-radius: 24px;

            z-index: 3;
        }

        #scanOverlay {
            position: fixed !important;

            left: 0 !important;

            top: 0 !important;

            right: 0 !important;

            bottom: 0 !important;

            width: 100vw !important;

            height: 100vh !important;

            z-index: 2147483646 !important;

            background: transparent;

            cursor: crosshair;

            pointer-events: auto !important;

            transform: none !important;

            zoom: 1 !important;
        }

        #selection {
            position: absolute !important;

            left: 30%;

            top: 42.5%;

            width: 20%;

            height: 15%;

            min-width: 60px;

            min-height: 60px;

            overflow: visible;

            border: 2px dashed ${C.primary};

            background: rgba(0,122,255,0.05);

            box-shadow: 0 0 20px rgba(0,122,255,0.2), inset 0 0 20px rgba(0,122,255,0.02);

            cursor: move;

            transform: none !important;

            zoom: 1 !important;

            border-radius: 16px;
        }

        .handle {
            position: absolute;

            width: 14px;

            height: 14px;

            border-radius: 50%;

            background: ${C.primary};

            box-shadow: 0 0 6px rgba(0,122,255,0.5);
        }

        #scanActions {
            position: absolute;

            left: 50%;

            top: calc(100% + 16px);

            transform: translateX(-50%);

            display: flex;

            gap: 12px;

            white-space: nowrap;
        }

        .scan-action {
            padding: 10px 22px;

            border: 0;

            border-radius: 12px;

            cursor: pointer;

            font-weight: 600;

            font-size: 1em;

            letter-spacing: 0.02em;

            font-family: ${C.fontSans};

            box-shadow: 0 2px 8px rgba(0,0,0,0.1);

            transition: background 0.2s ease, box-shadow 0.2s ease, transform 0.12s ease;
        }

        .scan-action:active {
            transform: scale(0.97);
        }

        #confirmBtn {
            background: ${C.primary};

            color: #fff;

            box-shadow: 0 2px 8px rgba(0,122,255,0.3);
        }

        #confirmBtn:hover {
            background: ${C.primaryDark};

            box-shadow: 0 4px 12px rgba(0,122,255,0.4);
        }

        #cancelBtn {
            background: rgba(0,0,0,0.05);

            color: ${C.text};

            box-shadow: 0 2px 8px rgba(0,0,0,0.05);
        }

        #cancelBtn:hover {
            background: rgba(0,0,0,0.08);
        }

        #settingsPanel,
        #historyList,
        #results {
            scrollbar-width: thin;

            scrollbar-color: rgba(0,122,255,0.3) rgba(0,0,0,0.02);
        }

        #settingsPanel::-webkit-scrollbar,
        #historyList::-webkit-scrollbar,
        #results::-webkit-scrollbar {
            width: 6px;

            height: 6px;
        }

        #settingsPanel::-webkit-scrollbar-track,
        #historyList::-webkit-scrollbar-track,
        #results::-webkit-scrollbar-track {
            background: rgba(0,0,0,0.02);

            border-radius: 10px;
        }

        #settingsPanel::-webkit-scrollbar-thumb,
        #historyList::-webkit-scrollbar-thumb,
        #results::-webkit-scrollbar-thumb {
            background: rgba(0,122,255,0.3);

            border-radius: 10px;
        }

        #settingsPanel::-webkit-scrollbar-thumb:hover,
        #historyList::-webkit-scrollbar-thumb:hover,
        #results::-webkit-scrollbar-thumb:hover {
            background: rgba(0,122,255,0.5);
        }

        #loadingOverlay {
            position: fixed !important;

            left: 0 !important;

            top: 0 !important;

            width: 100vw !important;

            height: 100vh !important;

            z-index: 2147483647 !important;

            display: flex;

            align-items: center;

            justify-content: center;

            background: transparent;

            pointer-events: auto !important;

            transform: none !important;

            zoom: 1 !important;
        }

        #loadingOverlay[hidden] {
            display: none !important;
        }

        .loading-spinner {
            width: 50px;

            height: 50px;

            border: 4px solid rgba(0,0,0,0.1);

            border-top-color: ${C.primary};

            border-radius: 50%;

            animation: qr-spin 0.9s linear infinite;

            box-shadow: 0 0 20px rgba(0,122,255,0.2);
        }

        @keyframes qr-spin {
            to {
                transform: rotate(360deg);
            }
        }
    `;

    shadow.appendChild(style);

    document.documentElement.appendChild(host);
}

// =========================================================
// UI 定位与字体
// =========================================================

function applyPanelPosition() {
    if (!panel) return;

    const saved = get(KEY.panel, null);

    const right = saved ? Math.max(0, Number(saved.right) || 0) : 40;
    const savedRatio = saved ? Number(saved.topRatio) : NaN;
    const ratio = Number.isFinite(savedRatio)
        ? Math.max(0, Math.min(1, savedRatio))
        : 0.5;

    const maxWidth = Math.max(200, window.innerWidth - 16);
    const maxHeight = Math.max(160, window.innerHeight - 16);

    if (saved && saved.width) {
        panel.style.width =
            Math.min(maxWidth, Math.max(200, Number(saved.width) || 280)) + 'px';
    }

    if (saved && saved.height) {
        panel.style.height =
            Math.min(maxHeight, Math.max(160, Number(saved.height) || 220)) + 'px';
    }

    const availableHeight = Math.max(0, window.innerHeight - panel.offsetHeight);
    const maxRight = Math.max(0, window.innerWidth - panel.offsetWidth);

    panel.style.left = 'auto';
    panel.style.bottom = 'auto';
    panel.style.right = Math.min(right, maxRight) + 'px';
    panel.style.top = Math.round(availableHeight * ratio) + 'px';
}

function savePanelPosition() {
    if (!panel) return;

    const rect = panel.getBoundingClientRect();
    const availableHeight = Math.max(1, window.innerHeight - rect.height);

    set(KEY.panel, {
        right: Math.max(0, window.innerWidth - rect.right),
        topRatio: Math.max(0, Math.min(1, rect.top / availableHeight)),
        width: panel.offsetWidth,
        height: panel.offsetHeight
    });
}

function applyFoldedPosition() {
    if (!foldedBtn) return;

    const savedRatio = Number(get(KEY.folded, 0.5));
    const ratio = Number.isFinite(savedRatio)
        ? Math.max(0, Math.min(1, savedRatio))
        : 0.5;

    const availableHeight = Math.max(0, window.innerHeight - foldedBtn.offsetHeight);

    foldedBtn.style.top = Math.round(availableHeight * ratio) + 'px';
    foldedBtn.style.bottom = 'auto';
    foldedBtn.style.right = '-18px';
}

function clampFontSize(value) {
    const size = Number(value);

    if (!Number.isFinite(size)) {
        return DEFAULT_FONT_SIZE;
    }

    return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(size)));
}

function getFontSize() {
    return clampFontSize(get(KEY.fontSize, DEFAULT_FONT_SIZE));
}

function setFontSize(value) {
    const size = clampFontSize(value);

    set(KEY.fontSize, size);

    if (panel) {
        panel.style.fontSize = size + 'px';
    }

    lastAppliedFontSize = size;

    if (fontSizeInputEl && shadow.activeElement !== fontSizeInputEl) {
        fontSizeInputEl.value = String(size);
    }

    return size;
}

function applyUIFontSize() {
    if (!panel) return;

    const size = getFontSize();

    if (size === lastAppliedFontSize) {
        return;
    }

    panel.style.fontSize = size + 'px';
    lastAppliedFontSize = size;

    if (fontSizeInputEl && shadow.activeElement !== fontSizeInputEl) {
        fontSizeInputEl.value = String(size);
    }
}

function isPanelFixed() {
    return !!get(KEY.fixedPanel, false);
}

function updateFixedSwitch() {
    if (!fixedFloatEl) return;

    const enabled = isPanelFixed();

    fixedFloatEl.classList.toggle('on', enabled);
    fixedFloatEl.classList.toggle('off', !enabled);
    fixedFloatEl.setAttribute('aria-pressed', String(enabled));
}

// =========================================================
// UI 创建
// =========================================================

function createUI() {
    ensureHost();

    if (panel) return;

    panel = document.createElement('div');
    panel.id = 'panel';

    panel.innerHTML = `
        <div id="title">
            <div class="title-left">
                <div class="title-icon">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="${C.primary}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/>
                        <circle cx="12" cy="12" r="3"/>
                    </svg>
                </div>
                <div class="title-text">猫眼扫描</div>
            </div>
            <div id="actions">
                <button class="circle" id="historyBtn" title="历史记录" aria-label="历史记录">◷</button>
                <button class="circle" id="settingsBtn" title="设置" aria-label="设置">⚙</button>
                <button class="circle" id="foldMainBtn" title="折叠" aria-label="折叠">▶</button>
            </div>
        </div>

        <div id="settingsPanel">
            <div class="settings-title">设置</div>
            <div class="settings-switch-row">
                <span class="settings-switch-label">固定悬浮窗</span>
                <button type="button" id="fixedFloat" class="switch off" aria-label="固定悬浮窗" aria-pressed="false">
                    <span class="switch-knob"></span>
                </button>
            </div>
            <div class="font-setting">
                <div class="font-setting-head">
                    <span>字体调整</span>
                    <div class="font-input-wrap">
                        <input id="fontSizeInput" class="font-input" type="number" min="10" max="30" step="1" value="13">
                        <span>px</span>
                    </div>
                </div>
            </div>
            <div class="settings-actions">
                <button class="settings-btn" id="resetScanBox" title="恢复默认扫描框">↻ 恢复扫描框</button>
                <button class="settings-btn" id="resetPanel" title="恢复悬浮窗位置">↻ 恢复位置</button>
            </div>
        </div>

        <div id="historyPanel">
            <div class="history-head">
                <div class="history-title">历史记录</div>
                <div class="history-count" id="historyCount">0 / 15</div>
            </div>
            <div id="historyList"></div>
            <div class="history-footer">
                <button id="clearHistoryBtn" type="button">清空历史</button>
            </div>
        </div>

        <div id="content">
            <button id="scanBtn">📷 扫描网页二维码</button>
            <button id="autoScanBtn">🔍 自动扫描页面</button>
            <div id="results"></div>
        </div>

        <div id="panelResize"></div>
    `;

    shadow.appendChild(panel);

    resultArea = shadow.getElementById('results');
    historyPanel = shadow.getElementById('historyPanel');

    foldedBtn = document.createElement('div');
    foldedBtn.id = 'foldedBtn';
    foldedBtn.title = '展开猫眼扫描';
    foldedBtn.setAttribute('aria-label', '展开猫眼扫描');

    foldedBtn.innerHTML = `
        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-label="蓝白小猫">
            <defs>
                <linearGradient id="catBlue79" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stop-color="#8fe6ff"/>
                    <stop offset="100%" stop-color="#269ddd"/>
                </linearGradient>
                <linearGradient id="catWhite79" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#ffffff"/>
                    <stop offset="100%" stop-color="#e9f8ff"/>
                </linearGradient>
            </defs>
            <path d="M18 35 L15 10 Q15 5 20 8 L37 21 Z" fill="url(#catBlue79)"/>
            <path d="M63 21 L80 8 Q85 5 85 10 L82 35 Z" fill="url(#catBlue79)"/>
            <path d="M20 16 L32 24 L22 28 Z" fill="#ffc7d6"/>
            <path d="M68 24 L80 16 L78 28 Z" fill="#ffc7d6"/>
            <path d="M16 38 Q16 16 50 15 Q84 16 84 38 Q84 76 50 86 Q16 76 16 38 Z" fill="url(#catWhite79)" stroke="#289fdd" stroke-width="3"/>
            <path d="M26 23 Q50 13 74 23 Q69 37 50 40 Q31 37 26 23 Z" fill="url(#catBlue79)"/>
            <ellipse cx="34" cy="47" rx="9" ry="11" fill="#173d64"/>
            <ellipse cx="66" cy="47" rx="9" ry="11" fill="#173d64"/>
            <ellipse cx="31.5" cy="43" rx="3" ry="4" fill="#fff"/>
            <ellipse cx="63.5" cy="43" rx="3" ry="4" fill="#fff"/>
            <ellipse cx="25" cy="59" rx="10" ry="5" fill="#ff9eb5" opacity=".7"/>
            <ellipse cx="75" cy="59" rx="10" ry="5" fill="#ff9eb5" opacity=".7"/>
            <path d="M46 56 Q50 52 54 56 Q50 61 46 56 Z" fill="#e889a0"/>
            <path d="M50 60 Q45 66 41 63 M50 60 Q55 66 59 63" fill="none" stroke="#54728d" stroke-width="2.2" stroke-linecap="round"/>
            <path d="M28 70 Q50 84 72 70 Q70 88 50 91 Q30 88 28 70 Z" fill="#fff" opacity=".96"/>
        </svg>
    `;

    shadow.appendChild(foldedBtn);

    const loadingOverlay = document.createElement('div');
    loadingOverlay.id = 'loadingOverlay';
    loadingOverlay.hidden = true;
    loadingOverlay.innerHTML = '<div class="loading-spinner"></div>';
    shadow.appendChild(loadingOverlay);

    loadingOverlayEl = loadingOverlay;
    settingsPanelEl = shadow.getElementById('settingsPanel');
    settingsBtnEl = shadow.getElementById('settingsBtn');
    historyBtnEl = shadow.getElementById('historyBtn');
    foldMainBtnEl = shadow.getElementById('foldMainBtn');
    fixedFloatEl = shadow.getElementById('fixedFloat');
    fontSizeInputEl = shadow.getElementById('fontSizeInput');
    resetScanBoxEl = shadow.getElementById('resetScanBox');
    resetPanelEl = shadow.getElementById('resetPanel');
    scanBtnEl = shadow.getElementById('scanBtn');
    panelResizeEl = shadow.getElementById('panelResize');
    autoScanBtnEl = shadow.getElementById('autoScanBtn');

    panel.hidden = true;
    foldedBtn.style.display = 'flex';
    foldedBtn.style.right = '-18px';

    bindPanelDrag();
    bindPanelResize();
    bindFolded();
    bindSettings();
    bindScan();

    applyPanelPosition();
    applyFoldedPosition();
    applyUIFontSize();
    updateFixedSwitch();
}

function showLoading() {
    if (loadingOverlayEl) {
        loadingOverlayEl.hidden = false;
    }
}

function hideLoading() {
    if (loadingOverlayEl) {
        loadingOverlayEl.hidden = true;
    }
}

// =========================================================
// 面板拖动
// =========================================================

function bindPanelDrag() {
    const title = shadow.getElementById('title');

    let active = false;
    let offsetX = 0;
    let offsetY = 0;
    let rafId = null;
    let pendingPos = null;

    function scheduleUpdate() {
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
            if (pendingPos) {
                panel.style.left = pendingPos.left + 'px';
                panel.style.top = pendingPos.top + 'px';
                pendingPos = null;
            }
            rafId = null;
        });
    }

    function onMouseMove(event) {
        if (!active) return;

        pendingPos = {
            left: Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, event.clientX - offsetX)),
            top: Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, event.clientY - offsetY))
        };
        scheduleUpdate();
    }

    function onMouseUp() {
        if (!active) return;

        active = false;

        if (pendingPos) {
            panel.style.left = pendingPos.left + 'px';
            panel.style.top = pendingPos.top + 'px';
            pendingPos = null;
        }
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }

        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);

        savePanelPosition();
    }

    title.addEventListener('mousedown', event => {
        if (event.target.closest('button')) return;
        if (isPanelFixed()) return;

        const rect = panel.getBoundingClientRect();
        active = true;
        offsetX = event.clientX - rect.left;
        offsetY = event.clientY - rect.top;

        panel.style.left = rect.left + 'px';
        panel.style.top = rect.top + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);

        event.preventDefault();
    });
}

function bindPanelResize() {
    const resize = panelResizeEl;

    let active = false;
    let startX = 0;
    let startY = 0;
    let startWidth = 0;
    let startHeight = 0;
    let rafId = null;
    let pendingSize = null;

    function scheduleUpdate() {
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
            if (pendingSize) {
                panel.style.width = pendingSize.width + 'px';
                panel.style.height = pendingSize.height + 'px';
                pendingSize = null;
            }
            rafId = null;
        });
    }

    function onMouseMove(event) {
        if (!active) return;

        pendingSize = {
            width: Math.max(200, startWidth + event.clientX - startX),
            height: Math.max(160, startHeight + event.clientY - startY)
        };
        scheduleUpdate();
    }

    function onMouseUp() {
        if (!active) return;

        active = false;

        if (pendingSize) {
            panel.style.width = pendingSize.width + 'px';
            panel.style.height = pendingSize.height + 'px';
            pendingSize = null;
        }
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }

        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);

        savePanelPosition();
    }

    resize.addEventListener('mousedown', event => {
        if (isPanelFixed()) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        const rect = panel.getBoundingClientRect();
        active = true;
        startX = event.clientX;
        startY = event.clientY;
        startWidth = rect.width;
        startHeight = rect.height;

        panel.style.left = rect.left + 'px';
        panel.style.top = rect.top + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);

        event.preventDefault();
        event.stopPropagation();
    });
}

function bindFolded() {
    let dragging = false;
    let moved = false;
    let startY = 0;
    let startTop = 0;
    let lastRatio = null;

    function onMouseMove(event) {
        if (!dragging) return;

        const deltaY = event.clientY - startY;
        if (Math.abs(deltaY) > 3) {
            moved = true;
        }

        const maxTop = Math.max(0, window.innerHeight - foldedBtn.offsetHeight);
        const top = Math.max(0, Math.min(maxTop, startTop + deltaY));

        foldedBtn.style.top = top + 'px';
        lastRatio = maxTop ? top / maxTop : 0.5;
    }

    function onMouseUp() {
        if (!dragging) return;

        if (lastRatio !== null) {
            set(KEY.folded, lastRatio);
            lastRatio = null;
        }

        dragging = false;

        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
    }

    foldedBtn.addEventListener('mousedown', event => {
        dragging = true;
        moved = false;
        startY = event.clientY;
        startTop = foldedBtn.getBoundingClientRect().top;

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);

        event.preventDefault();
        event.stopPropagation();
    });

    foldedBtn.addEventListener('click', () => {
        if (moved) {
            moved = false;
            return;
        }
        panel.hidden = false;
        foldedBtn.style.display = 'none';
        applyPanelPosition();
        applyUIFontSize();
    });

    foldMainBtnEl.addEventListener('click', () => {
        savePanelPosition();
        settingsPanelEl.classList.remove('show');
        if (historyPanel) {
            historyOpen = false;
            historyPanel.classList.remove('show');
        }
        panel.hidden = true;
        foldedBtn.style.display = 'flex';
        applyFoldedPosition();
    });
}

function bindSettings() {
    const settingsBtn = settingsBtnEl;
    const settingsPanel = settingsPanelEl;
    const fixedSwitch = fixedFloatEl;
    const fontInput = fontSizeInputEl;

    updateFixedSwitch();
    applyUIFontSize();

    function commitFontSize() {
        const size = setFontSize(fontInput.value);
        fontInput.value = String(size);
    }

    fixedSwitch.addEventListener('click', event => {
        event.stopPropagation();
        const enabled = !isPanelFixed();
        set(KEY.fixedPanel, enabled);
        if (enabled) {
            savePanelPosition();
        }
        updateFixedSwitch();
    });

    settingsBtn.addEventListener('click', event => {
        event.stopPropagation();
        if (historyPanel) {
            historyOpen = false;
            historyPanel.classList.remove('show');
        }
        settingsPanel.classList.toggle('show');
    });

    // 输入过程中不再强行改写数值（否则输入 “15” 会被夹成 “10”），
    // 只在确认输入后统一夹取到 10 ~ 30 并保存。
    fontInput.addEventListener('change', commitFontSize);

    fontInput.addEventListener('blur', () => {
        commitFontSize();
        applyUIFontSize();
    });

    fontInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            commitFontSize();
            fontInput.blur();
        }
    });

    resetScanBoxEl.addEventListener('click', () => {
        removeValue(KEY.scanBox);
        settingsPanel.classList.remove('show');
    });

    resetPanelEl.addEventListener('click', () => {
        removeValue(KEY.panel);
        applyPanelPosition();
        settingsPanel.classList.remove('show');
    });

    bindHistory();

    panel.addEventListener('mousedown', event => {
        const insideSettings = !!event.target.closest('#settingsPanel');
        const insideSettingsBtn = !!event.target.closest('#settingsBtn');
        const insideHistory = !!event.target.closest('#historyPanel');
        const insideHistoryBtn = !!event.target.closest('#historyBtn');

        if (!insideSettings && !insideSettingsBtn) {
            settingsPanel.classList.remove('show');
        }

        if (!insideHistory && !insideHistoryBtn) {
            historyOpen = false;
            historyPanel.classList.remove('show');
        }
    });
}

// =========================================================
// 历史记录
// =========================================================

function normalizeHistory(items) {
    if (!Array.isArray(items)) return [];

    return items
        .filter(item => item && typeof item.link === 'string')
        .map(item => {
            const link = item.link.trim();
            const timestamp = Number(item.timestamp);
            return {
                link,
                timestamp: Number.isFinite(timestamp) ? timestamp : Date.now()
            };
        })
        .filter(item => item.link)
        .slice(0, MAX_HISTORY);
}

function getHistory() {
    return normalizeHistory(get(KEY.history, []));
}

function saveHistory(history) {
    set(KEY.history, normalizeHistory(history));
}

function formatHistoryDate(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '未知时间';

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function addHistoryLinks(links) {
    const uniqueLinks = [...new Set((links || []).map(link => String(link || '').trim()).filter(Boolean))];
    if (!uniqueLinks.length) return;

    let history = getHistory();
    const timestamp = Date.now();

    uniqueLinks.reverse().forEach(link => {
        history = history.filter(item => item.link !== link);
        history.unshift({ link, timestamp });
    });

    saveHistory(history);
    renderHistory();
}

function getScanSignature(links) {
    return [...new Set((links || []).map(link => String(link || '').trim()).filter(Boolean))].sort().join('\n');
}

function renderHistory() {
    if (!historyPanel) return;

    const list = shadow.getElementById('historyList');
    const count = shadow.getElementById('historyCount');
    if (!list || !count) return;

    const history = getHistory();
    count.textContent = `${history.length} / ${MAX_HISTORY}`;

    const fragment = document.createDocumentFragment();

    if (!history.length) {
        const empty = document.createElement('div');
        empty.className = 'history-empty';
        empty.textContent = '暂无扫描历史';
        fragment.appendChild(empty);
    } else {
        history.forEach((item, index) => {
            const box = document.createElement('div');
            box.className = 'history-item';

            const meta = document.createElement('div');
            meta.className = 'history-meta';

            const indexText = document.createElement('span');
            indexText.textContent = `记录 ${index + 1}`;

            const timeText = document.createElement('span');
            timeText.textContent = formatHistoryDate(item.timestamp);

            meta.append(indexText, timeText);

            const row = document.createElement('div');
            row.className = 'history-link-row';

            const link = createLinkElement(item.link, 'history-link');
            link.title = `${item.link}\n扫描时间：${formatHistoryDate(item.timestamp)}`;

            const copy = document.createElement('button');
            copy.className = 'history-copy';
            copy.type = 'button';
            copy.textContent = '复制';
            copy.addEventListener('click', event => {
                event.stopPropagation();
                copyLink(item.link, copy);
            });

            row.append(link, copy);
            box.append(meta, row);
            fragment.appendChild(box);
        });
    }

    list.innerHTML = '';
    list.appendChild(fragment);
}

function bindHistory() {
    const historyBtn = historyBtnEl;
    const settingsPanel = settingsPanelEl;
    const clearHistoryBtn = shadow.getElementById('clearHistoryBtn');

    historyBtn.addEventListener('click', event => {
        event.stopPropagation();
        settingsPanel.classList.remove('show');
        historyOpen = !historyOpen;
        historyPanel.classList.toggle('show', historyOpen);
        if (historyOpen) renderHistory();
    });

    clearHistoryBtn.addEventListener('click', event => {
        event.stopPropagation();
        const history = getHistory();
        if (!history.length) return;
        if (!window.confirm('确定要清空全部扫描历史吗？')) return;
        saveHistory([]);
        renderHistory();
    });

    renderHistory();
}

// =========================================================
// 扫描按钮
// =========================================================

function bindScan() {
    scanBtnEl.addEventListener('click', () => {
        loadJsQR(startScan);
    });

    autoScanBtnEl.addEventListener('click', () => {
        loadJsQR(autoScanPage);
    });
}

// =========================================================
// 扫描框存储
// =========================================================

function saveScanBox(selection) {
    const rect = selection.getBoundingClientRect();
    set(KEY.scanBox, {
        left: rect.left / window.innerWidth,
        top: rect.top / window.innerHeight,
        width: rect.width / window.innerWidth,
        height: rect.height / window.innerHeight
    });
}

function restoreScanBox(selection) {
    const saved = get(KEY.scanBox, null);
    if (!saved) return;

    const maxWidth = Math.max(60, Math.min(window.innerWidth * 0.9, 2000));
    const maxHeight = Math.max(60, Math.min(window.innerHeight * 0.9, 2000));

    const width = Math.min(
        maxWidth,
        Math.max(60, window.innerWidth * Number(saved.width || 0.2))
    );
    const height = Math.min(
        maxHeight,
        Math.max(60, window.innerHeight * Number(saved.height || 0.15))
    );

    let left = window.innerWidth * Number(saved.left || 0.3);
    let top = window.innerHeight * Number(saved.top || 0.425);

    left = Math.max(0, Math.min(window.innerWidth - width, left));
    top = Math.max(0, Math.min(window.innerHeight - height, top));

    selection.style.left = left + 'px';
    selection.style.top = top + 'px';
    selection.style.width = width + 'px';
    selection.style.height = height + 'px';
}

// =========================================================
// 开始扫描（手动框选）
// =========================================================

function startScan() {
    lastScanSignature = '';
    lastScanTime = 0;

    try {
        shadow.querySelectorAll('#scanOverlay').forEach(el => el.remove());
    } catch (_) {}

    if (scanSession) {
        try {
            scanSession.cleanup();
        } catch (_) {}
    }

    scanSession = null;
    ensureHost();

    try {
        const overlay = document.createElement('div');
        overlay.id = 'scanOverlay';

        const selection = document.createElement('div');
        selection.id = 'selection';
        restoreScanBox(selection);

        const handles = [
            ['nw', 'nwse-resize', 'left:-7px;top:-7px'],
            ['n', 'ns-resize', 'left:50%;top:-7px;transform:translateX(-50%)'],
            ['ne', 'nesw-resize', 'right:-7px;top:-7px'],
            ['e', 'ew-resize', 'right:-7px;top:50%;transform:translateY(-50%)'],
            ['se', 'nwse-resize', 'right:-7px;bottom:-7px'],
            ['s', 'ns-resize', 'left:50%;bottom:-7px;transform:translateX(-50%)'],
            ['sw', 'nesw-resize', 'left:-7px;bottom:-7px'],
            ['w', 'ew-resize', 'left:-7px;top:50%;transform:translateY(-50%)']
        ];

        handles.forEach(([direction, cursor, position]) => {
            const handle = document.createElement('div');
            handle.className = 'handle';
            handle.dataset.dir = direction;
            handle.style.cssText = `cursor:${cursor};${position}`;
            selection.appendChild(handle);
        });

        const actions = document.createElement('div');
        actions.id = 'scanActions';
        actions.innerHTML = `
            <button class="scan-action" id="confirmBtn">✔ 识别二维码</button>
            <button class="scan-action" id="cancelBtn">取消</button>
        `;
        selection.appendChild(actions);
        overlay.appendChild(selection);
        shadow.appendChild(overlay);

        let dragging = false;
        let resizeDirection = null;
        let offsetX = 0;
        let offsetY = 0;
        let startX = 0;
        let startY = 0;
        let startLeft = 0;
        let startTop = 0;
        let startWidth = 0;
        let startHeight = 0;
        let actionRaf = null;

        // 扫描框靠近屏幕边缘时，把操作按钮翻到框上方 / 夹回屏幕内，
        // 避免按钮被视口裁掉而无法点击。
        function positionActions() {
            const rect = selection.getBoundingClientRect();
            const actionHeight = actions.offsetHeight || 40;

            const canShowBelow = rect.bottom + 16 + actionHeight <= window.innerHeight;
            const canShowAbove = rect.top - 16 - actionHeight >= 0;

            if (!canShowBelow && canShowAbove) {
                actions.style.top = 'auto';
                actions.style.bottom = 'calc(100% + 16px)';
            } else {
                actions.style.top = 'calc(100% + 16px)';
                actions.style.bottom = 'auto';
            }

            actions.style.left = '50%';
            actions.style.transform = 'translateX(-50%)';

            const actionRect = actions.getBoundingClientRect();
            let shift = 0;

            if (actionRect.left < 8) {
                shift = 8 - actionRect.left;
            } else if (actionRect.right > window.innerWidth - 8) {
                shift = window.innerWidth - 8 - actionRect.right;
            }

            const offset = Math.round(shift);

            actions.style.transform = offset >= 0
                ? `translateX(calc(-50% + ${offset}px))`
                : `translateX(calc(-50% - ${Math.abs(offset)}px))`;
        }

        function scheduleActionsPosition() {
            if (actionRaf) return;
            actionRaf = requestAnimationFrame(() => {
                actionRaf = null;
                positionActions();
            });
        }

        function onDown(event) {
            if (event.target.closest('button')) return;

            const handle = event.target.closest('.handle');
            if (handle) {
                resizeDirection = handle.dataset.dir;
                const rect = selection.getBoundingClientRect();
                startX = event.clientX;
                startY = event.clientY;
                startLeft = rect.left;
                startTop = rect.top;
                startWidth = rect.width;
                startHeight = rect.height;
                event.preventDefault();
                event.stopPropagation();
                return;
            }

            dragging = true;
            const rect = selection.getBoundingClientRect();
            offsetX = event.clientX - rect.left;
            offsetY = event.clientY - rect.top;
            event.preventDefault();
        }

        function onMove(event) {
            if (resizeDirection) {
                const dx = event.clientX - startX;
                const dy = event.clientY - startY;

                let left = startLeft;
                let top = startTop;
                let width = startWidth;
                let height = startHeight;

                if (resizeDirection.includes('e')) width = Math.max(60, startWidth + dx);
                if (resizeDirection.includes('s')) height = Math.max(60, startHeight + dy);
                if (resizeDirection.includes('w')) {
                    width = Math.max(60, startWidth - dx);
                    left = startLeft + startWidth - width;
                }
                if (resizeDirection.includes('n')) {
                    height = Math.max(60, startHeight - dy);
                    top = startTop + startHeight - height;
                }

                const maxWidth = Math.min(window.innerWidth * 0.9, 2000);
                const maxHeight = Math.min(window.innerHeight * 0.9, 2000);
                width = Math.min(width, maxWidth);
                height = Math.min(height, maxHeight);

                if (resizeDirection.includes('w')) left = startLeft + startWidth - width;
                if (resizeDirection.includes('n')) top = startTop + startHeight - height;

                selection.style.left = left + 'px';
                selection.style.top = top + 'px';
                selection.style.width = width + 'px';
                selection.style.height = height + 'px';

                scheduleActionsPosition();

                return;
            }

            if (dragging) {
                const maxLeft = window.innerWidth - selection.offsetWidth;
                const maxTop = window.innerHeight - selection.offsetHeight;

                selection.style.left = Math.max(0, Math.min(event.clientX - offsetX, maxLeft)) + 'px';
                selection.style.top = Math.max(0, Math.min(event.clientY - offsetY, maxTop)) + 'px';

                scheduleActionsPosition();
            }
        }

        function onUp() {
            if (dragging || resizeDirection) {
                saveScanBox(selection);
                scheduleActionsPosition();
            }
            dragging = false;
            resizeDirection = null;
        }

        function onKeyDown(event) {
            if (event.key === 'Escape') {
                event.preventDefault();
                saveScanBox(selection);
                cleanup();
            }
        }

        function cleanup() {
            try {
                if (actionRaf) {
                    cancelAnimationFrame(actionRaf);
                    actionRaf = null;
                }
                if (overlay.isConnected) overlay.remove();
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                document.removeEventListener('keydown', onKeyDown, true);
            } catch (_) {
            } finally {
                scanSession = null;
            }
        }

        selection.addEventListener('mousedown', onDown);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        document.addEventListener('keydown', onKeyDown, true);

        shadow.getElementById('cancelBtn').addEventListener('click', () => {
            saveScanBox(selection);
            cleanup();
        });

        shadow.getElementById('confirmBtn').addEventListener('click', () => {
            saveScanBox(selection);
            const rect = selection.getBoundingClientRect();
            cleanup();
            recognizeQR(rect);
        });

        positionActions();

        scanSession = { cleanup };

    } catch (err) {
        showError('无法打开扫描框，请刷新页面后重试');
        console.error('QR Scanner startScan error:', err);
    }
}

// =========================================================
// 图片 Canvas (支持 canvas 元素 + GM_xmlhttpRequest 跨域)
// =========================================================

function drawImageToCanvas(source, sourceWidth, sourceHeight, maxSize) {
    try {
        let width = Math.floor(sourceWidth);
        let height = Math.floor(sourceHeight);

        if (!width || !height) return null;

        if (Math.max(width, height) > maxSize) {
            const scale = maxSize / Math.max(width, height);
            width = Math.floor(width * scale);
            height = Math.floor(height * scale);
        }

        if (!width || !height) return null;

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(source, 0, 0, width, height);

        return canvas;
    } catch (_) {
        return null;
    }
}

// 同一张图片 1200px 扫不到时还要再用 2000px 重试一次。
// 这里按 src 缓存“已经解码的原图元素”，第二次直接复用，避免重新下载 / 解码。
const imageSourceCache = new WeakMap();

function isDirectDrawable(src) {
    try {
        const url = new URL(src, location.href);

        // data: / blob: 与同源图片都不会污染 canvas，可以直接绘制
        if (url.protocol === 'data:' || url.protocol === 'blob:') return true;

        return url.origin === location.origin;
    } catch (_) {
        return false;
    }
}

function loadImageSource(img) {
    if (!img) return Promise.resolve(null);

    if (img instanceof HTMLCanvasElement) {
        return Promise.resolve(img);
    }

    const src = img.currentSrc || img.src;

    if (!src) return Promise.resolve(null);

    if (isDirectDrawable(src)) {
        return Promise.resolve(img);
    }

    return new Promise(resolve => {
        let settled = false;
        let timer = null;

        function finish(value) {
            if (settled) return;
            settled = true;

            if (timer) {
                clearTimeout(timer);
                timer = null;
            }

            resolve(value || null);
        }

        function fallbackToGM() {
            fetchImageViaGM(src)
                .then(finish)
                .catch(() => finish(null));
        }

        const image = new Image();
        image.crossOrigin = 'anonymous';

        image.onload = () => {
            image.onload = null;
            image.onerror = null;

            finish(image);
        };

        image.onerror = () => {
            image.onload = null;
            image.onerror = null;

            // 跨域失败，尝试 GM_xmlhttpRequest 获取
            fallbackToGM();
        };

        image.src = src;

        // 图片长期不响应时不再无限等待，直接走跨域兜底
        timer = setTimeout(fallbackToGM, GM_REQUEST_TIMEOUT);
    });
}

function getImageSource(img) {
    if (!img) return Promise.resolve(null);

    if (img instanceof HTMLCanvasElement) return Promise.resolve(img);

    const src = img.currentSrc || img.src;

    if (!src) return Promise.resolve(null);

    // 记住缓存对应的 src，图片被轮播/懒加载换成另一张时不能复用旧结果
    const cached = imageSourceCache.get(img);

    if (cached && cached.src === src) {
        return cached.promise;
    }

    const promise = loadImageSource(img).then(source => {
        if (!source) {
            const current = imageSourceCache.get(img);

            // 失败结果不缓存，允许用户稍后重试
            if (current && current.promise === promise) {
                imageSourceCache.delete(img);
            }
        }

        return source;
    });

    imageSourceCache.set(img, { src, promise });

    return promise;
}

function imageToCanvas(img, maxSize = MAX_IMAGE_SIZE) {
    return getImageSource(img).then(source => {
        if (!source) return null;

        if (source instanceof HTMLCanvasElement) {
            return drawImageToCanvas(source, source.width, source.height, maxSize);
        }

        return drawImageToCanvas(source, source.naturalWidth, source.naturalHeight, maxSize);
    });
}

function fetchImageViaGM(url) {
    return new Promise(resolve => {
        if (typeof GM_xmlhttpRequest !== 'function' || !url) {
            resolve(null);
            return;
        }

        let settled = false;
        let timer = null;

        function finish(value) {
            if (settled) return;
            settled = true;

            if (timer) {
                clearTimeout(timer);
                timer = null;
            }

            resolve(value);
        }

        // 部分脚本管理器的 ontimeout 不触发，再加一层兜底，
        // 避免识别流程因为请求挂死而一直停在 loading。
        timer = setTimeout(() => finish(null), GM_REQUEST_TIMEOUT + 5000);

        try {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'blob',
                timeout: GM_REQUEST_TIMEOUT,
                onload: response => {
                    try {
                        if (!response || !response.response) {
                            finish(null);
                            return;
                        }

                        let blob = response.response;

                        if (!(blob instanceof Blob)) {
                            blob = new Blob([blob]);
                        }

                        const blobUrl = URL.createObjectURL(blob);
                        const image = new Image();

                        image.onload = () => {
                            URL.revokeObjectURL(blobUrl);
                            finish(image);
                        };

                        image.onerror = () => {
                            URL.revokeObjectURL(blobUrl);
                            finish(null);
                        };

                        image.src = blobUrl;
                    } catch (_) {
                        finish(null);
                    }
                },
                onerror: () => finish(null),
                ontimeout: () => finish(null),
                onabort: () => finish(null)
            });
        } catch (_) {
            finish(null);
        }
    });
}

// =========================================================
// 快速扫描
// =========================================================

function scanFast(canvas, context) {
    if (!canvas) return [];

    try {
        const ctx = context || canvas.getContext('2d', { willReadFrequently: true });
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'attemptBoth'
        });
        return code ? [code] : [];
    } catch (_) {
        return [];
    }
}

function isLargeQR(code, canvas) {
    if (!code || !code.location || !canvas) return true;

    const p = code.location;
    const xs = [p.topLeftCorner.x, p.topRightCorner.x, p.bottomLeftCorner.x, p.bottomRightCorner.x];
    const ys = [p.topLeftCorner.y, p.topRightCorner.y, p.bottomLeftCorner.y, p.bottomRightCorner.y];

    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);

    return ((width * height) / (canvas.width * canvas.height)) >= LARGE_QR_RATIO;
}

// =========================================================
// 多区域扫描
// =========================================================

function scanMulti(canvas, depth = MULTI_DEPTH, context) {
    if (!canvas) return [];

    const found = new Map();
    const ctx = context || canvas.getContext('2d', { willReadFrequently: true });

    function addCode(code) {
        if (code && code.data && !found.has(code.data)) {
            found.set(code.data, code);
        }
    }

    function scanRegion(x, y, width, height, level) {
        if (width < 80 || height < 80) return;

        const sx = Math.max(0, Math.floor(x));
        const sy = Math.max(0, Math.floor(y));
        const sw = Math.min(Math.floor(width), canvas.width - sx);
        const sh = Math.min(Math.floor(height), canvas.height - sy);

        if (sw < 50 || sh < 50) return;

        // 根节点（整幅图）已经由 scanFast 扫过，这里直接从四象限开始，
        // 省掉一次与 scanFast 完全重复的整图 jsQR。
        if (level > 0) {
            try {
                const imageData = ctx.getImageData(sx, sy, sw, sh);
                addCode(jsQR(imageData.data, imageData.width, imageData.height, {
                    inversionAttempts: 'attemptBoth'
                }));
            } catch (_) {}
        }

        if (level >= depth) return;

        const halfWidth = width / 2;
        const halfHeight = height / 2;
        const overlapX = halfWidth * 0.2;
        const overlapY = halfHeight * 0.2;

        const regions = [
            [x, y, halfWidth + overlapX, halfHeight + overlapY],
            [x + halfWidth - overlapX, y, halfWidth + overlapX, halfHeight + overlapY],
            [x, y + halfHeight - overlapY, halfWidth + overlapX, halfHeight + overlapY],
            [x + halfWidth - overlapX, y + halfHeight - overlapY, halfWidth + overlapX, halfHeight + overlapY]
        ];

        regions.forEach(region => {
            const rx = Math.max(0, region[0]);
            const ry = Math.max(0, region[1]);
            const rw = Math.min(region[2], canvas.width - rx);
            const rh = Math.min(region[3], canvas.height - ry);

            if (rw >= 80 && rh >= 80) {
                scanRegion(rx, ry, rw, rh, level + 1);
            }
        });
    }

    scanRegion(0, 0, canvas.width, canvas.height, 0);
    return [...found.values()];
}

// =========================================================
// 单张图片扫描 (增强)
// =========================================================

function mergeCodes(...lists) {
    const map = new Map();

    lists.forEach(list => {
        (list || []).forEach(code => {
            if (code && code.data && !map.has(code.data)) {
                map.set(code.data, code);
            }
        });
    });

    return [...map.values()];
}

async function scanImage(image, forceMulti = false, multiDepth = MULTI_DEPTH) {
    // 先尝试中等尺寸（1200px）
    const canvas = await imageToCanvas(image, MAX_IMAGE_SIZE);
    if (!canvas) return [];

    let result = [];
    try {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        const fast = scanFast(canvas, ctx);
        if (fast.length === 1 && !forceMulti && isLargeQR(fast[0], canvas)) {
            result = fast;
        } else {
            // scanMulti 已经跳过整幅图，这里把 fast 的结果合并进来，
            // 避免“整图能识别、分块反而漏掉”的情况丢结果。
            let found = mergeCodes(fast, scanMulti(canvas, multiDepth, ctx));

            if (!found.length) {
                // 二次尝试更大尺寸（原图元素已缓存，不会重新下载）
                const largeCanvas = await imageToCanvas(image, MAX_IMAGE_SIZE_LARGE);
                if (largeCanvas) {
                    try {
                        const largeCtx = largeCanvas.getContext('2d', { willReadFrequently: true });
                        found = mergeCodes(
                            scanFast(largeCanvas, largeCtx),
                            scanMulti(largeCanvas, multiDepth, largeCtx)
                        );
                    } finally {
                        largeCanvas.width = 0;
                        largeCanvas.height = 0;
                    }
                }
            }

            result = found;
        }
    } finally {
        canvas.width = 0;
        canvas.height = 0;
    }
    return result;
}

// =========================================================
// 获取扫描框内图片 (包含 canvas)
// =========================================================

function getImages(rect) {
    const images = [];

    document.querySelectorAll('img').forEach(img => {
        const r = img.getBoundingClientRect();
        if (
            r.width >= 50 &&
            r.height >= 50 &&
            !(r.right < rect.left || r.left > rect.right ||
              r.bottom < rect.top || r.top > rect.bottom) &&
            img.complete &&
            img.naturalWidth > 0
        ) {
            images.push({ image: img, area: r.width * r.height });
        }
    });

    document.querySelectorAll('canvas').forEach(canvas => {
        const r = canvas.getBoundingClientRect();
        if (
            r.width >= 50 &&
            r.height >= 50 &&
            !(r.right < rect.left || r.left > rect.right ||
              r.bottom < rect.top || r.top > rect.bottom) &&
            canvas.width > 0 &&
            canvas.height > 0
        ) {
            images.push({ image: canvas, area: r.width * r.height });
        }
    });

    return images
        .sort((a, b) => b.area - a.area)
        .slice(0, 8)
        .map(item => item.image);
}

// =========================================================
// 并发扫描
// =========================================================

async function scanImagesConcurrent(images) {
    const results = [];
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < images.length) {
            const index = nextIndex++;
            try {
                results.push(...await scanImage(images[index], true));
            } catch (_) {}
        }
    }

    const workerCount = Math.min(MAX_CONCURRENT_IMAGES, images.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return results;
}

// =========================================================
// 截图扫描 (修复跨域污染)
// =========================================================

function releaseCanvas(canvas) {
    if (!canvas) return;

    try {
        canvas.width = 0;
        canvas.height = 0;
    } catch (_) {}
}

function screenshotScan(rect) {
    return new Promise(resolve => {
        loadHtml2Canvas(error => {
            if (error) {
                resolve([]);
                return;
            }

            const x = rect.left + (window.scrollX || 0);
            const y = rect.top + (window.scrollY || 0);
            const deadline = Date.now() + SCREENSHOT_TIMEOUT;

            let settled = false;
            let timer = null;

            function finish(codes) {
                if (settled) return;
                settled = true;

                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }

                resolve(codes || []);
            }

            timer = setTimeout(() => finish([]), SCREENSHOT_TIMEOUT + 1000);

            function render(scale, allowTaint = false) {
                if (settled) return;

                if (Date.now() > deadline) {
                    finish([]);
                    return;
                }

                let effectiveScale = scale;
                const basePixels = rect.width * rect.height;
                if (basePixels > 0) {
                    const maxAllowedScale = Math.sqrt(MAX_SCREENSHOT_PIXELS / basePixels);
                    effectiveScale = Math.min(scale, maxAllowedScale);
                }

                if (effectiveScale < 0.2) {
                    finish([]);
                    return;
                }

                html2canvas(document.body, {
                    x, y,
                    width: rect.width,
                    height: rect.height,
                    scrollX: 0,
                    scrollY: 0,
                    useCORS: true,
                    allowTaint: allowTaint,
                    logging: false,
                    backgroundColor: null,
                    scale: effectiveScale
                })
                .then(canvas => {
                    if (settled) {
                        releaseCanvas(canvas);
                        return;
                    }

                    try {
                        const ctx = canvas.getContext('2d', { willReadFrequently: true });
                        // 读取一个像素，用于确认画布没有被跨域污染
                        ctx.getImageData(0, 0, 1, 1);

                        let codes = scanFast(canvas, ctx);
                        if (!codes.length) {
                            codes = scanMulti(canvas, MULTI_DEPTH, ctx);
                        }

                        releaseCanvas(canvas);

                        if (codes.length) {
                            finish(codes);
                        } else if (scale < 1.0) {
                            render(Math.min(1.0, scale + 0.4), allowTaint);
                        } else if (scale < 2.0) {
                            render(Math.min(2.0, scale + 0.6), allowTaint);
                        } else {
                            finish([]);
                        }
                    } catch (e) {
                        releaseCanvas(canvas);
                        finish([]);
                    }
                })
                .catch(() => {
                    if (settled) return;

                    if (scale < 1.0) {
                        render(Math.min(1.0, scale + 0.4), allowTaint);
                    } else if (scale < 2.0) {
                        render(Math.min(2.0, scale + 0.6), allowTaint);
                    } else {
                        finish([]);
                    }
                });
            }

            render(0.6, false);
        });
    });
}

// =========================================================
// 识别
// =========================================================

async function recognizeQR(rect) {
    if (scanInProgress) return;

    scanInProgress = true;

    try {
        showLoading();

        const found = new Map();

        function addCodes(codes) {
            (codes || []).forEach(code => {
                if (!code || !code.data) return;

                const links = extractResultLinks(code.data);
                links.forEach(link => {
                    if (!found.has(link)) {
                        found.set(link, code);
                    }
                });
            });
        }

        const images = getImages(rect);

        if (images.length === 1) {
            addCodes(await scanImage(images[0], false));
        } else if (images.length > 1) {
            addCodes(await scanImagesConcurrent(images));
        }

        if (found.size) {
            showResults([...found.keys()]);
            return;
        }

        addCodes(await screenshotScan(rect));

        if (found.size) {
            showResults([...found.keys()]);
        } else {
            showError('未识别到二维码。可能原因：\n1. 二维码过小或模糊\n2. 二维码不是标准QR码（如小程序码）\n3. 图片跨域限制导致无法读取\n建议：扩大扫描框，或直接框选二维码图片本身');
        }
    } finally {
        hideLoading();
        scanInProgress = false;
    }
}

// =========================================================
// 自动扫描页面
// =========================================================

async function autoScanPage() {
    if (scanInProgress) return;

    scanInProgress = true;

    try {
        clearAutoHighlights();

        const viewportRect = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
        const images = getImages(viewportRect).slice(0, MAX_AUTO_SCAN_IMAGES);

        if (!images.length) {
            showError('未找到可扫描的图片');
            return;
        }

        showLoading();

        const foundMap = new Map();
        const concurrent = Math.min(2, images.length);
        let index = 0;

        async function worker() {
            while (index < images.length) {
                const imgIndex = index++;
                const img = images[imgIndex];
                try {
                    const codes = await scanImage(img, true, AUTO_MULTI_DEPTH);
                    const links = [];
                    codes.forEach(code => {
                        if (code && code.data) {
                            links.push(...extractResultLinks(code.data));
                        }
                    });
                    if (links.length) {
                        const uniqueLinks = [...new Set(links)];
                        uniqueLinks.forEach(link => {
                            if (!foundMap.has(link)) {
                                foundMap.set(link, { img, links: uniqueLinks });
                            }
                        });
                    }
                } catch (_) {}
            }
        }

        await Promise.all(Array.from({ length: concurrent }, () => worker()));

        const allLinks = [...foundMap.keys()];
        if (!allLinks.length) {
            showError('未在可见图片中找到二维码');
            return;
        }

        for (const [link, info] of foundMap.entries()) {
            highlightImage(info.img, info.links);
        }

        showResults(allLinks);
    } finally {
        hideLoading();
        scanInProgress = false;
    }
}

function highlightImage(img, links) {
    if (!img || !img.classList) return;

    img.classList.add('qr-auto-highlight');
    img.dataset.qrLinks = JSON.stringify(links);
    highlightedImages.add(img);
}

function clearAutoHighlights() {
    highlightedImages.forEach(img => {
        try {
            img.classList.remove('qr-auto-highlight');
            delete img.dataset.qrLinks;
        } catch (_) {}
    });
    highlightedImages.clear();
}

function handleAutoHighlightClick(event) {
    const target = event.target;

    if (!target || typeof target.closest !== 'function') return;

    const img = target.closest('.qr-auto-highlight');
    if (!img) return;

    try {
        const links = JSON.parse(img.dataset.qrLinks || '[]');
        if (links.length) {
            // 图片常被包在 <a> 里，复制时不要顺带跳转页面
            event.preventDefault();
            event.stopPropagation();

            const text = links.join('\n');
            copyTextToClipboard(text);
            showCopyHint(img);
        }
    } catch (_) {}
}

function copyTextToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
        fallbackCopy(text);
    }
}

function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    try {
        document.execCommand('copy');
    } catch (_) {}
    textarea.remove();
}

function showCopyHint(img) {
    const rect = img.getBoundingClientRect();
    const hint = document.createElement('div');
    hint.textContent = '已复制';
    Object.assign(hint.style, {
        position: 'fixed',
        left: rect.left + 'px',
        top: rect.top - 30 + 'px',
        background: 'rgba(0,0,0,0.7)',
        color: '#fff',
        padding: '4px 8px',
        borderRadius: '4px',
        fontSize: '12px',
        zIndex: '2147483647',
        pointerEvents: 'none'
    });
    document.body.appendChild(hint);
    setTimeout(() => hint.remove(), 1500);
}

function handleAutoScanShortcut(event) {
    if (event.ctrlKey && event.shiftKey && event.key === 'F') {
        event.preventDefault();
        loadJsQR(autoScanPage);
    }
}

// =========================================================
// 显示结果
// =========================================================

function showResults(links) {
    links = [...new Set(links)];

    const signature = getScanSignature(links);
    const now = Date.now();

    if (signature !== lastScanSignature || now - lastScanTime >= 1200) {
        addHistoryLinks(links);
        lastScanSignature = signature;
        lastScanTime = now;
    }

    scanResultTime = now;

    resultArea.innerHTML = '';

    const fragment = document.createDocumentFragment();

    const title = document.createElement('div');
    title.className = 'result-title';
    title.innerHTML = `识别到 ${links.length} 个链接 <span id="resultTime">刚刚</span>`;
    fragment.appendChild(title);

    links.forEach((link, index) => {
        const box = document.createElement('div');
        box.className = 'result';

        const number = document.createElement('div');
        number.className = 'result-num';
        number.textContent = `二维码 ${index + 1}`;

        const row = document.createElement('div');
        row.className = 'result-row';

        const linkElement = createLinkElement(link, 'result-link');
        linkElement.title = link;

        const copyButton = document.createElement('button');
        copyButton.className = 'copy-btn';
        copyButton.textContent = '复制';
        copyButton.addEventListener('click', event => {
            event.stopPropagation();
            copyLink(link, copyButton);
        });

        row.append(linkElement, copyButton);
        box.append(number, row);
        fragment.appendChild(box);
    });

    resultArea.appendChild(fragment);

    if (resultTimeInterval) {
        clearInterval(resultTimeInterval);
    }
    resultTimeInterval = setInterval(updateResultTime, 60000);
    updateResultTime();

    panel.hidden = false;
    if (foldedBtn) foldedBtn.style.display = 'none';

    applyPanelPosition();
    applyUIFontSize();
}

function updateResultTime() {
    if (!scanResultTime) return;
    const timeEl = shadow.getElementById('resultTime');
    if (timeEl) {
        timeEl.textContent = formatRelativeTime(scanResultTime);
    }
}

function formatRelativeTime(timestamp) {
    const diff = Math.max(0, Date.now() - timestamp);
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (seconds < 10) return '刚刚';
    if (seconds < 60) return `${seconds}秒前`;
    if (minutes < 60) return `${minutes}分钟前`;
    if (hours < 24) return `${hours}小时前`;
    return `${days}天前`;
}

function showError(message) {
    if (resultTimeInterval) {
        clearInterval(resultTimeInterval);
        resultTimeInterval = null;
    }
    scanResultTime = 0;

    resultArea.innerHTML = '';

    const error = document.createElement('div');
    error.className = 'error';
    error.textContent = message;
    resultArea.appendChild(error);

    panel.hidden = false;
    if (foldedBtn) foldedBtn.style.display = 'none';

    applyPanelPosition();
    applyUIFontSize();
}

// =========================================================
// 复制
// =========================================================

async function copyLink(text, button) {
    const originalText = button.textContent;

    try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text);
        } else {
            throw new Error('clipboard unavailable');
        }

        button.textContent = '已复制';
    } catch (_) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();

        try {
            document.execCommand('copy');
            button.textContent = '已复制';
        } catch (_) {
            button.textContent = '复制失败';
        }

        textarea.remove();
    }

    setTimeout(() => {
        button.textContent = originalText;
    }, 1500);
}

// =========================================================
// 视口
// =========================================================

function bindViewport() {
    let rafId = null;

    const sync = () => {
        if (rafId) {
            cancelAnimationFrame(rafId);
        }
        rafId = requestAnimationFrame(() => {
            applyPanelPosition();
            applyFoldedPosition();
            applyUIFontSize();
            rafId = null;
        });
    };

    window.addEventListener('resize', sync, { passive: true });

    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', sync, { passive: true });
        window.visualViewport.addEventListener('scroll', sync, { passive: true });
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            sync();
        }
    });
}

// =========================================================
// SPA 监听
// =========================================================

function watchUI() {
    let queued = false;

    const observer = new MutationObserver(() => {
        if (!host || host.isConnected || queued) return;

        queued = true;

        requestAnimationFrame(() => {
            queued = false;

            ensureHost();

            applyPanelPosition();
            applyFoldedPosition();
            applyUIFontSize();
        });
    });

    observer.observe(document.documentElement, {
        childList: true
    });
}

// =========================================================
// 初始化
// =========================================================

function init() {
    ensureHost();
    createUI();
    bindViewport();
    watchUI();

    if (!document.getElementById('__qr_highlight_style_79')) {
        const style = document.createElement('style');
        style.id = '__qr_highlight_style_79';
        style.textContent = `
            img.qr-auto-highlight,
            canvas.qr-auto-highlight {
                outline: 3px solid #FF9500 !important;
                outline-offset: 2px;
                cursor: pointer;
                transition: outline-color 0.2s ease;
            }
            img.qr-auto-highlight:hover,
            canvas.qr-auto-highlight:hover {
                outline-color: #FF3B30 !important;
            }
        `;
        document.head.appendChild(style);
    }

    document.addEventListener('click', handleAutoHighlightClick, true);
    document.addEventListener('keydown', handleAutoScanShortcut);

    panel.hidden = true;
    foldedBtn.style.display = 'flex';
    foldedBtn.style.right = '-18px';

    applyPanelPosition();
    applyFoldedPosition();
    applyUIFontSize();
    updateFixedSwitch();

    historyOpen = false;
    if (historyPanel) {
        historyPanel.classList.remove('show');
    }

    renderHistory();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}

})();
