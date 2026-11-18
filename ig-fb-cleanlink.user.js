// ==UserScript==
// @name         IG/FB Clean Link
// @namespace    ig-fb-cleanlink
// @version      0.5.0
// @description  複製 Instagram / Facebook 連結時自動去除追蹤碼；FB 的 /share/ 短連結會換成 permalink。
// @match        https://www.facebook.com/*
// @match        https://web.facebook.com/*
// @match        https://m.facebook.com/*
// @match        https://www.instagram.com/*
// @homepageURL  https://github.com/orsmile/ig-fb-cleanlink
// @supportURL   https://github.com/orsmile/ig-fb-cleanlink/issues
// @updateURL    https://raw.githubusercontent.com/orsmile/ig-fb-cleanlink/main/ig-fb-cleanlink.user.js
// @downloadURL  https://raw.githubusercontent.com/orsmile/ig-fb-cleanlink/main/ig-fb-cleanlink.user.js
// @run-at       document-start
// @inject-into  page
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    cleanAddressBar: true, // 自動清掉網址列上的追蹤參數
    showToast: true,
    resolveTimeoutMs: 8000,
    cleanMessenger: true, // 「以 Messenger 傳送」時把 share 連結換成 permalink
    messengerHoldMs: 10000, // Messenger 訊息等待解析的上限
    rewriteAtSource: true, // 打開分享視窗時就把 FB 給的 share 連結換成 permalink
    blockOnFailure: true, // 轉換失敗時擋下 share 連結（不複製、不傳送）；false 則照原樣放行
    resolveRetries: 1, // 解析失敗後再試幾次
    debugLogSize: 200, // 除錯紀錄保留筆數
  };

  // ───────────────────────── 網址清理（純函式） ─────────────────────────

  const FB_HOST = /(^|\.)facebook\.com$/;
  const IG_HOST = /(^|\.)instagram\.com$/;
  const FB_ALT_HOSTS = new Set(['m.facebook.com', 'web.facebook.com', 'mbasic.facebook.com', 'touch.facebook.com']);
  const LINK_SHIM_HOSTS = new Set(['l.facebook.com', 'lm.facebook.com', 'l.instagram.com']);

  // 指向特定留言，屬於連結本體，一律保留
  const FB_ALWAYS_KEEP = ['comment_id', 'reply_comment_id'];

  // 這些路徑的 query 是連結本體：只保留列出的參數
  const FB_KEEP_BY_PATH = [
    [/^\/(permalink|story)\.php$/, ['story_fbid', 'id']],
    [/^\/photo(\.php|\/)?$/, ['fbid', 'set']],
    [/^\/watch(\/live)?\/?$/, ['v']],
    [/^\/video\.php$/, ['v']],
    [/^\/profile\.php$/, ['id']],
    [/^\/groups\/[^/]+\/?$/, ['multi_permalinks']],
    // 以下路徑本身已是完整 permalink，query 全部移除
    [/^\/[^/]+\/(posts|videos|photos)\//, []],
    [/^\/groups\/[^/]+\/(posts|permalink)\//, []],
    [/^\/reel\//, []],
    [/^\/marketplace\/item\//, []],
  ];

  // 其他路徑：只移除已知追蹤參數
  const FB_DENY = new Set([
    'fbclid', 'mibextid', 'rdid', 'share_url', '__tn__', 'ref', 'refsrc', 'ref_type',
    'fref', 'hc_ref', 'hc_location', 'sfnsn', 'paipv', 'eav', '_rdr', '_rdc',
    'notif_id', 'notif_t', 'acontext', 'extid', 'wtsid',
  ]);
  const FB_DENY_PREFIX = ['__cft__', '__xts__'];

  const IG_DENY = new Set(['igsh', 'igshid', 'ig_rid', 'ig_mid']);
  const EXTERNAL_DENY = new Set(['fbclid', 'igsh', 'igshid']);

  /** 依 keep(key) 過濾 query；回傳是否有移除任何參數。沒移除就不動原字串。 */
  function filterParams(u, keep) {
    const kept = new URLSearchParams();
    let removed = 0;
    for (const [k, v] of u.searchParams) {
      if (keep(k)) kept.append(k, v);
      else removed++;
    }
    if (removed) u.search = kept.toString();
    return removed > 0;
  }

  function isFbSharePath(pathname) {
    return /^\/share\//.test(pathname);
  }

  function cleanFacebook(u, opts) {
    let changed = false;
    if (!opts.keepHost && FB_ALT_HOSTS.has(u.hostname)) {
      u.hostname = 'www.facebook.com';
      changed = true;
    }
    if (isFbSharePath(u.pathname)) {
      // 代碼本身就是追蹤碼，必須解析成 permalink
      filterParams(u, () => false);
      return { url: u.href, changed: false, needsResolve: true };
    }
    const rule = FB_KEEP_BY_PATH.find(([re]) => re.test(u.pathname));
    if (rule) {
      const allow = new Set([...rule[1], ...FB_ALWAYS_KEEP]);
      changed = filterParams(u, (k) => allow.has(k)) || changed;
    } else {
      changed = filterParams(u, (k) =>
        !FB_DENY.has(k) && !FB_DENY_PREFIX.some((p) => k.startsWith(p))) || changed;
    }
    return { url: u.href, changed, needsResolve: false };
  }

  function cleanInstagram(u) {
    let changed;
    if (/^\/(?:[^/]+\/)?(p|reel|reels|tv)\/[^/]+/.test(u.pathname)) {
      // img_index 指向輪播中的第幾張，不是追蹤碼
      changed = filterParams(u, (k) => k === 'img_index');
    } else if (/^\/stories\//.test(u.pathname)) {
      changed = filterParams(u, () => false);
    } else {
      changed = filterParams(u, (k) => !IG_DENY.has(k) && !k.startsWith('utm_'));
    }
    return { url: u.href, changed, needsResolve: false };
  }

  /**
   * 清理單一網址。
   * @returns {{url:string, changed:boolean, needsResolve:boolean}|null} 非 IG/FB 網址回傳 null
   */
  function cleanUrl(input, opts = {}) {
    let u;
    try {
      u = new URL(String(input).trim());
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const host = u.hostname.toLowerCase();

    if (LINK_SHIM_HOSTS.has(host)) {
      // l.facebook.com/l.php?u=<外部連結>：直接還原目標
      const target = u.searchParams.get('u');
      if (!target) return null;
      const inner = cleanUrl(target, opts);
      if (inner) return { ...inner, changed: true };
      try {
        const t = new URL(target);
        filterParams(t, (k) => !EXTERNAL_DENY.has(k) && !k.startsWith('utm_'));
        return { url: t.href, changed: true, needsResolve: false };
      } catch {
        return null;
      }
    }
    if (FB_HOST.test(host)) return cleanFacebook(u, opts);
    if (IG_HOST.test(host)) return cleanInstagram(u);
    return null;
  }

  /** 剪貼簿文字若「整段就是一個 IG/FB 網址」才處理。 */
  function cleanText(text) {
    if (typeof text !== 'string') return null;
    const t = text.trim();
    if (!/^https?:\/\/\S+$/i.test(t)) return null;
    return cleanUrl(t);
  }

  function decodeEntities(s) {
    return s.replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/').replace(/&quot;/g, '"');
  }

  /** HTTP 轉址沒發生時，從 share 頁的 HTML 找正式連結。 */
  function extractCanonical(html) {
    const patterns = [
      /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i,
      /<meta[^>]+property="og:url"[^>]+content="([^"]+)"/i,
      /<meta[^>]+http-equiv="refresh"[^>]+content="[^"]*url=([^"]+)"/i,
    ];
    for (const re of patterns) {
      const m = re.exec(html);
      if (m) return decodeEntities(m[1]);
    }
    return null;
  }

  // ── Messenger 封包（/ws/lightspeed）──
  // 封包由多個區段組成：[類型 1][串流 2][長度 2, little-endian][0][內容…]
  // 傳送貼文的任務裡有一個多層跳脫的 share 連結（每個 / 前面有數個反斜線）。

  const FRAME_SHARE_STRICT = /https:((?:\\)*\/)\1(?:www|web|m)\.facebook\.com\1share\1(?:[\w.-]+\1?)+/;
  const FRAME_SHARE_LOOSE = /facebook\.com[\\/]+share[\\/]/;
  const latin1 = typeof TextDecoder !== 'undefined' ? new TextDecoder('latin1') : null;

  /**
   * 在送出的封包裡找 share 連結。
   * @returns null（與我們無關）｜{error}（看起來相關但格式不認得）｜{index,length,sep,url,lenOffset}
   */
  function findShareInFrame(bytes) {
    if (!latin1 || bytes.length < 16 || bytes.length > 200000) return null;
    const text = latin1.decode(bytes); // 單位元組編碼：字元位置 = 位元組位置
    if (!text.includes('"app_id"') || !text.includes('tasks')) return null;
    if (!FRAME_SHARE_LOOSE.test(text)) return null;
    const m = FRAME_SHARE_STRICT.exec(text);
    if (!m) return { error: 'Messenger 封包裡的連結格式已改變' };
    let o = 0;
    let lenOffset = -1;
    while (o + 6 <= bytes.length) {
      if (bytes[o + 5] !== 0) break;
      const end = o + 6 + (bytes[o + 3] | (bytes[o + 4] << 8));
      if (m.index >= o + 6 && m.index + m[0].length <= end) lenOffset = o + 3;
      o = end;
    }
    if (o !== bytes.length || lenOffset < 0) return { error: 'Messenger 封包結構已改變' };
    return { index: m.index, length: m[0].length, sep: m[1], url: m[0].split(m[1]).join('/'), lenOffset };
  }

  /** 把找到的 share 連結換成 clean，並更新區段長度。失敗回傳 null。 */
  function replaceShareInFrame(bytes, found, clean) {
    if (!/^https:\/\/[\x21-\x7e]+$/.test(clean) || /["\\]/.test(clean)) return null;
    const rep = clean.split('/').join(found.sep);
    const oldLen = bytes[found.lenOffset] | (bytes[found.lenOffset + 1] << 8);
    const newLen = oldLen + rep.length - found.length;
    if (newLen <= 0 || newLen > 0xffff) return null;
    const out = new Uint8Array(bytes.length + rep.length - found.length);
    out.set(bytes.subarray(0, found.index), 0);
    for (let i = 0; i < rep.length; i++) out[found.index + i] = rep.charCodeAt(i);
    out.set(bytes.subarray(found.index + found.length), found.index + rep.length);
    out[found.lenOffset] = newLen & 0xff;
    out[found.lenOffset + 1] = newLen >> 8;
    return out;
  }

  // ── share 連結的來源 ──
  // 打開分享視窗時，FB 用 useLinkSharingCreateWrappedUrlMutation 向伺服器要 share 連結，
  // 回應裡同時有原本的 permalink（original_content_url）和 share 連結（wrapped_url）。
  // 在這裡把 wrapped_url 換掉，之後的複製、Messenger（含端對端加密聊天，封包無法事後改寫）、
  // WhatsApp 等全部都會拿到乾淨連結。

  const WRAP_MUTATION = 'useLinkSharingCreateWrappedUrlMutation';
  const WRAPPED_RE = /"wrapped_url":"((?:[^"\\]|\\.)*)"/;
  const ORIGINAL_RE = /"original_content_url":"((?:[^"\\]|\\.)*)"/;

  /** @returns {{text:string, share:string, clean:string}|null} 回應裡沒有可以安全替換的內容就回傳 null */
  function rewriteWrappedUrl(text) {
    if (typeof text !== 'string') return null;
    const w = WRAPPED_RE.exec(text);
    const o = ORIGINAL_RE.exec(text);
    if (!w || !o) return null;
    let wrapped;
    let original;
    try {
      wrapped = cleanUrl(JSON.parse('"' + w[1] + '"'));
      original = cleanUrl(JSON.parse('"' + o[1] + '"'));
    } catch {
      return null;
    }
    if (!wrapped || !wrapped.needsResolve || !original || original.needsResolve) return null;
    let value = JSON.stringify(original.url).slice(1, -1);
    if (w[1].includes('\\/')) value = value.replace(/\//g, '\\/'); // 跟著原本的跳脫方式
    return {
      text: text.slice(0, w.index) + '"wrapped_url":"' + value + '"' + text.slice(w.index + w[0].length),
      share: wrapped.url,
      clean: original.url,
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      cleanUrl, cleanText, extractCanonical, isFbSharePath, findShareInFrame, replaceShareInFrame, rewriteWrappedUrl,
    };
  }
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // ───────────────────────── 瀏覽器端 ─────────────────────────

  // @grant none：腳本直接跑在頁面環境，才能攔到頁面自己的剪貼簿呼叫
  const VERSION = '0.5.0'; // 與檔頭 @version 一致
  const running = window.__igFbCleanLink;
  if (running) {
    // 已有另一份在跑。版本不同代表 Tampermonkey 裡同時啟用了新舊兩份，新功能不會生效。
    if (running !== VERSION) {
      const other = running === true ? '0.2.0 或更舊' : running;
      console.warn(`[cleanlink] v${VERSION} 未啟用：另一份腳本（v${other}）已在執行`);
      const notify = () => {
        const el = document.createElement('div');
        el.textContent = `⚠ IG/FB Clean Link：Tampermonkey 裡有兩份腳本同時啟用（v${other} 與 v${VERSION}），請停用或刪除舊的那份。點此關閉`;
        el.style.cssText = 'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483647;' +
          'padding:8px 16px;border-radius:8px;background:rgba(176,74,0,.96);color:#fff;' +
          'font:14px/1.4 system-ui,sans-serif;cursor:pointer;max-width:80vw';
        el.addEventListener('click', () => el.remove());
        document.body.appendChild(el);
      };
      if (document.body) notify();
      else document.addEventListener('DOMContentLoaded', notify, { once: true });
    }
    return;
  }
  window.__igFbCleanLink = VERSION;
  console.info(`[cleanlink] IG/FB Clean Link v${VERSION} 已啟用`);

  // ── 除錯紀錄 ──
  // 存在這個網站的 localStorage，只留最近幾筆，不會傳到任何地方。
  // 取出方式：失敗提示上的「複製除錯紀錄」，或在 Console 執行 __igFbCleanLinkLog()

  const LOG_KEY = 'igFbCleanLink.log';
  const TAB = Math.random().toString(36).slice(2, 8);
  const mine = []; // 這個分頁的紀錄。FB 會不定時清掉 localStorage，所以記憶體裡也留一份
  let dirty = false;
  let saveTimer = 0;

  function errText(e) {
    if (!e) return '未知錯誤';
    const name = e.name && e.name !== 'Error' ? e.name + ': ' : '';
    return name + (e.message || String(e));
  }

  function readLog() {
    try {
      const saved = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  }

  /** 已存檔的（含其他分頁寫的）加上這個分頁的，依時間排序。 */
  function mergedLog() {
    const saved = readLog();
    const have = new Set(saved.map((x) => x.n));
    const all = saved.concat(mine.filter((x) => !have.has(x.n)));
    all.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
    return all.slice(-CONFIG.debugLogSize);
  }

  function flushLog() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!dirty) return;
    dirty = false;
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(mergedLog()));
    } catch {
      // localStorage 不能用就只留在 console
    }
  }

  function record(event, data) {
    const entry = { t: new Date().toISOString(), n: TAB + '-' + mine.length, e: event };
    for (const [k, v] of Object.entries(data || {})) {
      entry[k] = v instanceof Error ? Object.assign({ message: errText(v) }, v.info) : v;
    }
    console.debug('[cleanlink]', event, entry);
    mine.push(entry);
    dirty = true;
    if (!saveTimer) saveTimer = setTimeout(flushLog, 500);
  }

  function dumpLog() {
    flushLog();
    const head = {
      script: 'IG/FB Clean Link', version: VERSION, host: location.hostname,
      blockOnFailure: CONFIG.blockOnFailure, ua: navigator.userAgent, exported: new Date().toISOString(),
    };
    return [head, ...mergedLog()].map((x) => JSON.stringify(x)).join('\n');
  }

  window.__igFbCleanLinkLog = () => {
    const text = dumpLog();
    console.log(text);
    return text;
  };
  window.addEventListener('pagehide', flushLog);
  record('start', { path: location.pathname });

  // ── 提示 ──

  let toastEl = null;
  let toastTimer = 0;
  let toastSticky = false;

  function hideToast() {
    if (!toastEl) return;
    clearTimeout(toastTimer);
    toastSticky = false;
    toastEl.style.opacity = '0';
    toastEl.style.pointerEvents = 'none';
  }

  /**
   * @param {string} msg
   * @param {{warning?:boolean, sticky?:boolean, actions?:{label:string, fn:Function}[]}} [opts]
   *   warning：橘色、可點擊關閉；sticky：不自動消失；actions：附加按鈕
   */
  function toast(msg, opts = {}) {
    if ((!CONFIG.showToast && !opts.warning) || !document.body) return;
    if (toastSticky && !opts.warning) return; // 不讓一般提示蓋掉還沒處理的警示
    if (!toastEl) {
      toastEl = document.createElement('div');
      Object.assign(toastEl.style, {
        position: 'fixed', left: '50%', bottom: '32px', transform: 'translateX(-50%)',
        zIndex: '2147483647', padding: '8px 16px', borderRadius: '8px',
        color: '#fff', font: '14px/1.4 system-ui, sans-serif', cursor: 'pointer',
        transition: 'opacity .2s', maxWidth: '80vw', overflow: 'hidden', textOverflow: 'ellipsis',
      });
      toastEl.addEventListener('click', hideToast);
    }
    toastEl.textContent = msg;
    for (const a of opts.actions || []) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = a.label;
      btn.style.cssText = 'margin-left:10px;padding:2px 10px;border-radius:6px;border:1px solid #fff;' +
        'background:transparent;color:#fff;font:inherit;cursor:pointer';
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        hideToast();
        try {
          a.fn();
        } catch (e) {
          record('error', { where: 'toast action', error: e });
        }
      });
      toastEl.appendChild(btn);
    }
    toastEl.style.opacity = '1';
    toastEl.style.whiteSpace = opts.warning ? 'normal' : 'nowrap';
    toastEl.style.background = opts.warning ? 'rgba(176,74,0,.96)' : 'rgba(20,20,20,.92)';
    toastEl.style.pointerEvents = opts.warning ? 'auto' : 'none';
    if (!toastEl.isConnected) document.body.appendChild(toastEl);
    clearTimeout(toastTimer);
    toastSticky = !!opts.sticky;
    if (!opts.sticky) toastTimer = setTimeout(hideToast, opts.warning ? 15000 : 2500);
  }

  function setClipboard(text) {
    return origWriteText
      ? origWriteText.call(navigator.clipboard, text)
      : Promise.reject(new Error('no clipboard API'));
  }

  const logAction = {
    label: '複製除錯紀錄',
    fn: () => setClipboard(dumpLog()).then(
      () => toast('除錯紀錄已複製，可貼到 GitHub issue（內含你轉換過的連結，貼出前請先看過）', { warning: true }),
      (e) => toast('無法寫入剪貼簿，請在 Console 執行 __igFbCleanLinkLog()：' + errText(e), { warning: true })),
  };

  /** 失敗原因；FB 改版造成的會提醒需要更新腳本。 */
  function failText(e) {
    return errText(e) + (e && e.needsUpdate ? '；FB 可能已改版，腳本需要更新' : '');
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── FB share 連結 → permalink ──

  const resolveCache = new Map(); // share 連結 → Promise<permalink>

  async function fetchPermalink(shareUrl) {
    if (!FB_HOST.test(location.hostname)) {
      throw Object.assign(new Error('只能在 facebook.com 上解析'), { noRetry: true });
    }
    const u = new URL(shareUrl);
    u.protocol = 'https:';
    u.host = location.host; // 保持同源，才帶得到登入狀態
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, CONFIG.resolveTimeoutMs);
    const info = {};
    const fail = (msg, extra) => Object.assign(new Error(msg), { info }, extra);
    try {
      const res = await fetch(u.href, { credentials: 'include', redirect: 'follow', signal: ctrl.signal });
      info.status = res.status;
      info.redirected = res.redirected;
      let finalUrl = res.url;
      if (finalUrl) info.finalPath = new URL(finalUrl).pathname;
      if (!finalUrl || isFbSharePath(new URL(finalUrl).pathname)) {
        finalUrl = extractCanonical(await res.text());
        info.fromHtml = finalUrl ? new URL(finalUrl, location.origin).pathname : null;
      }
      // 回應正常卻找不到 permalink，才算是 FB 改版；否則視為暫時性錯誤
      const changed = res.ok ? { needsUpdate: true } : null;
      if (!finalUrl) throw fail(`找不到正式連結（HTTP ${res.status}）`, changed);
      const f = new URL(finalUrl, location.origin);
      if (/^\/(login|checkpoint)/.test(f.pathname)) throw fail('需要登入：' + f.pathname, { noRetry: true });
      if (isFbSharePath(f.pathname)) throw fail(`轉址後仍是 share 連結（HTTP ${res.status}）`, changed);
      const r = cleanUrl(f.href);
      if (!r || r.needsResolve) throw fail('解析結果不是 FB 連結');
      return r.url;
    } catch (e) {
      if (timedOut) throw fail(`解析逾時（${CONFIG.resolveTimeoutMs}ms）`);
      if (!e.info) e.info = info;
      throw e;
    } finally {
      clearTimeout(timer);
      ctrl.abort(); // 已拿到網址，不必下載整頁
    }
  }

  async function resolveWithRetry(shareUrl) {
    let lastErr;
    for (let attempt = 0; attempt <= CONFIG.resolveRetries; attempt++) {
      if (attempt) await sleep(300);
      const t0 = Date.now();
      try {
        const clean = await fetchPermalink(shareUrl);
        record('resolve-ok', { url: shareUrl, clean, attempt, ms: Date.now() - t0 });
        return clean;
      } catch (e) {
        lastErr = e;
        record('resolve-failed', { url: shareUrl, attempt, ms: Date.now() - t0, online: navigator.onLine, error: e });
        if (e.noRetry) break;
      }
    }
    throw lastErr;
  }

  function getPermalink(shareUrl) {
    let p = resolveCache.get(shareUrl);
    if (!p) {
      p = resolveWithRetry(shareUrl);
      resolveCache.set(shareUrl, p);
      p.catch(() => resolveCache.delete(shareUrl)); // 失敗的不快取，下次重試
    }
    return p;
  }

  /** 把解析好的乾淨連結寫進剪貼簿；寫不進去（例如已切到別的視窗）就留一個按鈕讓使用者補按。 */
  function writeClean(clean) {
    return setClipboard(clean).then(
      () => toast('已複製乾淨連結：' + clean),
      (e) => {
        record('clipboard-write-failed', { clean, focused: document.hasFocus(), error: e });
        toast('⚠ 乾淨連結已取得，但寫不進剪貼簿（分頁不在前景？）', {
          warning: true, sticky: true,
          actions: [{ label: '複製乾淨連結', fn: () => setClipboard(clean).then(() => toast('已複製乾淨連結：' + clean)) }, logAction],
        });
      });
  }

  /**
   * 複製到 share 連結時：解析成 permalink 再寫入剪貼簿。永遠不會 reject。
   * @param {boolean} blocked 原本的 share 連結是否已被擋下（沒進剪貼簿）
   */
  function resolveForCopy(shareUrl, original, blocked, via) {
    record('copy-share', { via, url: shareUrl, blocked });
    if (!resolveCache.has(shareUrl)) toast('轉換為乾淨連結中…');
    return getPermalink(shareUrl).then(writeClean, (e) => {
      const actions = [logAction];
      if (blocked) {
        actions.unshift({
          label: '改複製原連結',
          fn: () => setClipboard(original).then(() => toast('已複製原本的 share 連結'), (e2) =>
            record('clipboard-write-failed', { focused: document.hasFocus(), error: e2 })),
        });
      }
      toast(blocked
        ? `⚠ 轉換失敗，已擋下 share 連結，剪貼簿沒有變更（${failText(e)}）`
        : `⚠ 轉換失敗，剪貼簿仍是原本的 share 連結（${failText(e)}）`,
      { warning: true, sticky: blocked, actions });
    });
  }

  // ── 在來源就換掉 share 連結 ──
  // 攔的是 JSON.parse 而不是 XHR 的回應：有些擴充功能會把 XMLHttpRequest 包一層，
  // 改寫 responseText 會被它蓋掉；而 FB 不管用什麼方式收到回應，最後都要經過 JSON.parse。

  const sourceCleaned = new Set(); // 已在來源換成 permalink 的連結，複製時用來顯示提示
  const origParse = JSON.parse;
  let sourceSeen = 0; // 看過幾次帶 wrapped_url 的回應
  let warnedSource = false;

  function warnSource(detail) {
    record('source-not-rewritten', detail);
    if (warnedSource) return;
    warnedSource = true;
    toast('⚠ 無法在來源換掉 share 連結；傳到加密聊天的訊息可能仍是 share 連結。FB 可能已改版，腳本需要更新', {
      warning: true, actions: [logAction],
    });
  }

  if (CONFIG.rewriteAtSource && FB_HOST.test(location.hostname)) {
    JSON.parse = function (text, ...rest) {
      // 先用長度擋掉絕大多數呼叫，避免拖慢 FB
      if (typeof text === 'string' && text.length < 20000 && text.includes('"wrapped_url"')) {
        sourceSeen++;
        try {
          const r = rewriteWrappedUrl(text);
          if (r) {
            sourceCleaned.add(r.clean);
            resolveCache.set(r.share, Promise.resolve(r.clean)); // 萬一別處還是拿到 share 連結，不必再解析
            record('source-rewritten', { url: r.share, clean: r.clean });
            text = r.text;
          } else {
            // 例如分享的是外部網址：沒有 permalink 可換，交給後面的剪貼簿／封包攔截處理
            record('source-skipped', { len: text.length, hasOriginal: text.includes('"original_content_url"') });
          }
        } catch (e) {
          record('error', { where: 'JSON.parse hook', error: e });
        }
      }
      return origParse.call(this, text, ...rest);
    };

    // FB 送出取得 share 連結的請求後，若回應沒有經過上面的改寫，代表格式變了
    const xhrProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    const origXhrSend = xhrProto && xhrProto.send;
    if (origXhrSend) {
      xhrProto.send = function (body) {
        try {
          const text = typeof body === 'string' ? body
            : body instanceof URLSearchParams ? body.toString() : '';
          if (text.includes(WRAP_MUTATION)) {
            const before = sourceSeen;
            const xhr = this;
            xhr.addEventListener('loadend', () => setTimeout(() => {
              if (sourceSeen === before) warnSource({ status: xhr.status, responseType: xhr.responseType });
            }, 1500));
          }
        } catch (e) {
          record('error', { where: 'xhr send', error: e });
        }
        return origXhrSend.apply(this, arguments);
      };
    }
  }

  // ── 攔截剪貼簿寫入 ──
  // blockOnFailure 開啟時，share 連結不會先進剪貼簿，等解析成功才寫入乾淨連結；
  // 關閉時照舊：原本的寫入先進行，解析成功後再覆寫一次。

  const clipProto = window.Clipboard && window.Clipboard.prototype;
  const origWriteText = clipProto && clipProto.writeText;
  const origWrite = clipProto && clipProto.write;

  function safeCleanText(text, where) {
    try {
      return cleanText(text);
    } catch (e) {
      record('error', { where, error: e });
      return null;
    }
  }

  if (origWriteText) {
    clipProto.writeText = function (text) {
      const r = safeCleanText(text, 'writeText');
      if (!r) return origWriteText.call(this, text);
      if (r.needsResolve) {
        if (CONFIG.blockOnFailure) return resolveForCopy(r.url, text, true, 'writeText');
        const p = origWriteText.call(this, text);
        resolveForCopy(r.url, text, false, 'writeText');
        return p;
      }
      if (!r.changed) {
        if (sourceCleaned.has(r.url)) toast('已複製乾淨連結：' + r.url);
        return origWriteText.call(this, text);
      }
      toast('已複製乾淨連結');
      return origWriteText.call(this, r.url);
    };
  }

  if (origWrite) {
    clipProto.write = function (items) {
      const self = this;
      let item = null;
      try {
        item = Array.prototype.find.call(items, (it) =>
          it && it.types && Array.prototype.includes.call(it.types, 'text/plain'));
      } catch (e) {
        record('error', { where: 'write', error: e });
      }
      if (!item) return origWrite.call(self, items);
      return item.getType('text/plain').then((b) => b.text()).then((text) => {
        const r = safeCleanText(text, 'write');
        if (!r) return origWrite.call(self, items);
        if (r.needsResolve) {
          if (CONFIG.blockOnFailure) return resolveForCopy(r.url, text, true, 'write');
          return origWrite.call(self, items).then(() => {
            resolveForCopy(r.url, text, false, 'write');
          });
        }
        if (!r.changed) return origWrite.call(self, items);
        toast('已複製乾淨連結');
        return origWriteText.call(self, r.url);
      }, (e) => {
        record('error', { where: 'write getType', error: e });
        return origWrite.call(self, items);
      });
    };
  }

  // 舊式 execCommand('copy')，以及使用者自己選取網址按 Ctrl+C
  function selectedText() {
    const el = document.activeElement;
    if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') && typeof el.selectionStart === 'number') {
      return el.value.slice(el.selectionStart, el.selectionEnd);
    }
    return String(document.getSelection() || '');
  }

  document.addEventListener('copy', (e) => {
    try {
      const text = selectedText();
      const r = cleanText(text);
      if (!r) return;
      if (r.needsResolve) {
        // 取消預設行為且不放任何資料：剪貼簿維持原狀，share 連結不會進去
        if (CONFIG.blockOnFailure) e.preventDefault();
        resolveForCopy(r.url, text.trim(), CONFIG.blockOnFailure, 'copy-event');
        return;
      }
      if (!r.changed) {
        if (sourceCleaned.has(r.url)) toast('已複製乾淨連結：' + r.url);
        return;
      }
      if (!e.clipboardData) return;
      e.clipboardData.setData('text/plain', r.url);
      e.preventDefault();
      toast('已複製乾淨連結');
    } catch (err) {
      record('error', { where: 'copy-event', error: err });
    }
  }, true);

  // ── 以 Messenger 傳送 ──
  // 送出前先扣住封包，解析出 permalink 後改寫再放行。期間同一條連線的其他封包
  // 依序排隊（排隊中的封包放行前也會檢查），維持原本順序。
  // 失敗時：blockOnFailure 開啟就不送出這則訊息，並留一個「仍用 share 連結送出」的按鈕；
  // 關閉就照原樣送出。

  const wsProto = window.WebSocket && window.WebSocket.prototype;
  const origSend = wsProto && wsProto.send;
  const heldQueues = new WeakMap(); // 連線 → 排隊中的封包
  const MAX_LINKS_PER_FRAME = 8;
  let warnedTextFrame = false;

  function toBytes(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    return null;
  }

  function wsPath(ws) {
    try {
      return new URL(ws.url).pathname;
    } catch {
      return '?';
    }
  }

  /** 給除錯紀錄用的封包摘要：長度、開頭幾個位元組、share 連結附近的內容。 */
  function frameInfo(text, length) {
    const i = text.search(FRAME_SHARE_LOOSE);
    const hex = (c) => c.charCodeAt(0).toString(16).padStart(2, '0');
    return {
      len: length,
      head: Array.from(text.slice(0, 14), hex).join(' '),
      near: i < 0 ? '' : text.slice(Math.max(0, i - 30), i + 90).replace(/[^\x20-\x7e]/g, '.'),
    };
  }

  /** 這個封包需要改寫嗎？回傳複製出來的位元組，不需要就回傳 null。 */
  function inspectOutgoing(ws, data) {
    if (!FB_HOST.test(location.hostname)) return null;
    if (typeof data === 'string') {
      // 目前 FB 只用二進位封包；若哪天改成文字，至少留下紀錄並提醒
      if (data.length < 200000 && data.includes('tasks') && FRAME_SHARE_LOOSE.test(data)) {
        record('messenger-text-frame', { ws: wsPath(ws), frame: frameInfo(data, data.length) });
        if (!warnedTextFrame) {
          warnedTextFrame = true;
          toast('⚠ Messenger 的封包格式已改變，這則訊息已照原樣送出；腳本需要更新', { warning: true, actions: [logAction] });
        }
      }
      return null;
    }
    const bytes = toBytes(data);
    return bytes && findShareInFrame(bytes) ? bytes : null;
  }

  function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`等待解析逾時（${CONFIG.messengerHoldMs}ms）`)), Math.max(0, ms));
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /** 把封包裡所有 share 連結換成 permalink；任何一步失敗就 reject，不會送出改到一半的封包。 */
  async function rewriteFrame(bytes) {
    const deadline = Date.now() + CONFIG.messengerHoldMs;
    const changed = (msg) => Object.assign(new Error(msg), { needsUpdate: true });
    const urls = [];
    let cur = bytes;
    for (;;) {
      const found = findShareInFrame(cur);
      if (!found) return { bytes: cur, urls };
      if (found.error) throw changed(found.error);
      if (urls.length >= MAX_LINKS_PER_FRAME) throw new Error('封包裡的 share 連結太多');
      const r = cleanUrl(found.url);
      if (!r || !r.needsResolve) throw changed('封包裡的連結無法辨識');
      const clean = await withTimeout(getPermalink(r.url), deadline - Date.now());
      const out = replaceShareInFrame(cur, found, clean);
      if (!out) throw changed('無法改寫 Messenger 封包');
      cur = out;
      urls.push(clean);
    }
  }

  function rawSend(ws, data) {
    try {
      if (ws.readyState === 1) {
        origSend.call(ws, data);
        return true;
      }
      record('messenger-socket-closed', { ws: wsPath(ws), readyState: ws.readyState });
    } catch (e) {
      record('error', { where: 'ws send', error: e });
    }
    toast('⚠ 連線已中斷，訊息可能沒有送出，請到 Messenger 確認', { warning: true, actions: [logAction] });
    return false;
  }

  /** 放行排隊中的封包；遇到另一個需要改寫的就再扣住。 */
  function drain(ws) {
    const queue = heldQueues.get(ws);
    while (queue && queue.length) {
      const data = queue.shift();
      let bytes = null;
      try {
        bytes = inspectOutgoing(ws, data);
      } catch (e) {
        record('error', { where: 'inspect', error: e });
      }
      if (bytes) {
        processHeld(ws, bytes);
        return;
      }
      rawSend(ws, data);
    }
    heldQueues.delete(ws);
  }

  function processHeld(ws, original) {
    const t0 = Date.now();
    rewriteFrame(original).then(({ bytes, urls }) => {
      record('messenger-rewritten', { ms: Date.now() - t0, urls });
      if (rawSend(ws, bytes)) toast('已用乾淨連結傳送：' + urls[0]);
    }, (e) => {
      const blocked = CONFIG.blockOnFailure;
      record('messenger-failed', {
        ms: Date.now() - t0, blocked, ws: wsPath(ws), error: e,
        frame: frameInfo(latin1.decode(original), original.length),
      });
      if (!blocked) {
        rawSend(ws, original);
        toast(`⚠ 轉換失敗，已用原本的 share 連結傳送（${failText(e)}）`, { warning: true, actions: [logAction] });
        return;
      }
      toast(`⚠ 轉換失敗，已擋下這則 Messenger 訊息，沒有送出（${failText(e)}）`, {
        warning: true, sticky: true,
        actions: [{
          label: '仍用 share 連結送出',
          fn: () => {
            const ok = rawSend(ws, original);
            record('messenger-sent-original', { ok });
            if (ok) toast('已用原本的 share 連結送出');
          },
        }, logAction],
      });
    }).catch((e) => record('error', { where: 'processHeld', error: e })).then(() => drain(ws));
  }

  if (CONFIG.cleanMessenger && origSend) {
    wsProto.send = function (data) {
      const queue = heldQueues.get(this);
      if (queue) {
        queue.push(data);
        return undefined;
      }
      let bytes = null;
      try {
        bytes = inspectOutgoing(this, data);
      } catch (e) {
        record('error', { where: 'inspect', error: e });
      }
      if (!bytes) return origSend.call(this, data);
      heldQueues.set(this, []);
      processHeld(this, bytes);
      return undefined;
    };
  }

  // ── 網址列 ──

  if (CONFIG.cleanAddressBar) {
    let lastHref = '';
    const tidy = () => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      try {
        const r = cleanUrl(location.href, { keepHost: true });
        if (!r || r.needsResolve || !r.changed) return;
        if (new URL(r.url).origin !== location.origin) return;
        history.replaceState(history.state, '', r.url);
        lastHref = location.href;
      } catch (e) {
        record('error', { where: 'address bar', error: e });
      }
    };
    tidy();
    setInterval(tidy, 1000);
  }
})();
