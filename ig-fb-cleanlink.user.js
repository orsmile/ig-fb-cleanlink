// ==UserScript==
// @name         IG/FB Clean Link
// @namespace    ig-fb-cleanlink
// @version      0.3.2
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
    messengerHoldMs: 4000, // 等待解析的上限，超過就照原樣送出
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

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { cleanUrl, cleanText, extractCanonical, isFbSharePath, findShareInFrame, replaceShareInFrame };
  }
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // ───────────────────────── 瀏覽器端 ─────────────────────────

  // @grant none：腳本直接跑在頁面環境，才能攔到頁面自己的剪貼簿呼叫
  const VERSION = '0.3.2'; // 與檔頭 @version 一致
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
  const log = (...a) => console.debug('[cleanlink]', ...a);

  let toastEl = null;
  let toastTimer = 0;
  function toast(msg, warning) {
    if ((!CONFIG.showToast && !warning) || !document.body) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      Object.assign(toastEl.style, {
        position: 'fixed', left: '50%', bottom: '32px', transform: 'translateX(-50%)',
        zIndex: '2147483647', padding: '8px 16px', borderRadius: '8px',
        color: '#fff', font: '14px/1.4 system-ui, sans-serif', cursor: 'pointer',
        transition: 'opacity .2s', maxWidth: '80vw',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      });
      toastEl.addEventListener('click', () => {
        toastEl.style.opacity = '0';
        toastEl.style.pointerEvents = 'none';
      });
    }
    toastEl.textContent = msg;
    toastEl.style.opacity = '1';
    toastEl.style.background = warning ? 'rgba(176,74,0,.96)' : 'rgba(20,20,20,.92)';
    toastEl.style.pointerEvents = warning ? 'auto' : 'none'; // 警示可點擊關閉
    if (!toastEl.isConnected) document.body.appendChild(toastEl);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.style.opacity = '0';
      toastEl.style.pointerEvents = 'none';
    }, warning ? 15000 : 2500);
  }

  // FB/IG 改版導致腳本失效時，明確告訴使用者，而不是默默失敗
  const warned = new Set();
  function warnNeedsUpdate(reason, detail) {
    console.warn('[cleanlink] 可能需要更新腳本：' + reason, detail || '');
    if (warned.has(reason)) return;
    warned.add(reason);
    toast('⚠ IG/FB Clean Link 可能需要更新：' + reason + '（這次已照原樣處理）', true);
  }

  function setClipboard(text) {
    return origWriteText
      ? origWriteText.call(navigator.clipboard, text)
      : Promise.reject(new Error('no clipboard API'));
  }

  // ── FB share 連結 → permalink ──

  const resolveCache = new Map(); // share 連結 → Promise<permalink>

  async function fetchPermalink(shareUrl) {
    if (!FB_HOST.test(location.hostname)) throw new Error('只能在 facebook.com 上解析');
    const u = new URL(shareUrl);
    u.protocol = 'https:';
    u.host = location.host; // 保持同源，才帶得到登入狀態
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CONFIG.resolveTimeoutMs);
    try {
      const res = await fetch(u.href, { credentials: 'include', redirect: 'follow', signal: ctrl.signal });
      let finalUrl = res.url;
      if (!finalUrl || isFbSharePath(new URL(finalUrl).pathname)) {
        finalUrl = extractCanonical(await res.text());
      }
      if (!finalUrl) throw Object.assign(new Error('找不到正式連結'), { needsUpdate: true });
      const f = new URL(finalUrl, location.origin);
      if (/^\/(login|checkpoint)/.test(f.pathname)) throw new Error('需要登入：' + f.pathname);
      if (isFbSharePath(f.pathname)) {
        throw Object.assign(new Error('轉址後仍是 share 連結'), { needsUpdate: true });
      }
      const r = cleanUrl(f.href);
      if (!r || r.needsResolve) throw new Error('解析結果不是 FB 連結');
      return r.url;
    } finally {
      clearTimeout(timer);
      ctrl.abort(); // 已拿到網址，不必下載整頁
    }
  }

  function getPermalink(shareUrl) {
    let p = resolveCache.get(shareUrl);
    if (!p) {
      p = fetchPermalink(shareUrl);
      resolveCache.set(shareUrl, p);
      p.catch((e) => {
        resolveCache.delete(shareUrl);
        if (e && e.needsUpdate) warnNeedsUpdate('share 連結的解析方式已改變', e);
      });
    }
    return p;
  }

  function resolveAndOverwrite(shareUrl) {
    if (!resolveCache.has(shareUrl)) toast('轉換為乾淨連結中…');
    getPermalink(shareUrl)
      .then((clean) => setClipboard(clean).then(() => toast('已複製乾淨連結：' + clean)))
      .catch((e) => {
        log('resolve failed', shareUrl, e);
        if (!(e && e.needsUpdate)) toast('無法轉換，剪貼簿仍是原本的 share 連結');
      });
  }

  // ── 攔截剪貼簿寫入 ──
  // 原本的寫入一律照常進行；需要非同步處理時，事後再覆寫一次。

  const expose = (fn) => fn;
  const clipProto = window.Clipboard && window.Clipboard.prototype;
  const origWriteText = clipProto && clipProto.writeText;
  const origWrite = clipProto && clipProto.write;

  function handleCopiedText(text) {
    const r = cleanText(text);
    if (!r) return text;
    if (r.needsResolve) {
      resolveAndOverwrite(r.url);
      return text;
    }
    if (!r.changed) return text;
    toast('已複製乾淨連結');
    return r.url;
  }

  if (origWriteText) {
    clipProto.writeText = expose(function (text) {
      let out = text;
      try {
        out = handleCopiedText(text);
      } catch (e) {
        log(e);
      }
      return origWriteText.call(this, out);
    });
  }

  async function postProcessItems(items) {
    for (const item of items) {
      if (!item.types || !Array.prototype.includes.call(item.types, 'text/plain')) continue;
      const text = await (await item.getType('text/plain')).text();
      const r = cleanText(text);
      if (!r) return;
      if (r.needsResolve) resolveAndOverwrite(r.url);
      else if (r.changed) setClipboard(r.url).then(() => toast('已複製乾淨連結'));
      return;
    }
  }

  if (origWrite) {
    clipProto.write = expose(function (items) {
      const p = origWrite.call(this, items);
      try {
        postProcessItems(items).catch(log);
      } catch (e) {
        log(e);
      }
      return p;
    });
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
      const r = cleanText(selectedText());
      if (!r) return;
      if (r.needsResolve) {
        resolveAndOverwrite(r.url);
        return;
      }
      if (!r.changed || !e.clipboardData) return;
      e.clipboardData.setData('text/plain', r.url);
      e.preventDefault();
      toast('已複製乾淨連結');
    } catch (err) {
      log(err);
    }
  }, true);

  // ── 以 Messenger 傳送 ──
  // 送出前先扣住封包，解析出 permalink 後改寫再放行。期間同一條連線的其他封包
  // 依序排隊，維持原本順序。任何一步失敗都照原樣送出，不擋訊息。

  const wsProto = window.WebSocket && window.WebSocket.prototype;
  const origSend = wsProto && wsProto.send;
  const heldQueues = new WeakMap();

  function toBytes(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    return null;
  }

  function inspectOutgoing(ws, data) {
    if (!FB_HOST.test(location.hostname) || !/lightspeed/.test(ws.url)) return null;
    const bytes = toBytes(data);
    if (!bytes) return null;
    const found = findShareInFrame(bytes);
    if (!found) return null;
    if (found.error) {
      warnNeedsUpdate(found.error);
      return null;
    }
    const r = cleanUrl(found.url);
    if (!r || !r.needsResolve) return null;
    return { bytes, found, shareUrl: r.url };
  }

  if (CONFIG.cleanMessenger && origSend) {
    wsProto.send = function (data) {
      const queue = heldQueues.get(this);
      if (queue) {
        queue.push(data);
        return undefined;
      }
      let job = null;
      try {
        job = inspectOutgoing(this, data);
      } catch (e) {
        log(e);
      }
      if (!job) return origSend.call(this, data);

      const ws = this;
      const pending = [];
      heldQueues.set(ws, pending);
      const release = (first) => {
        heldQueues.delete(ws);
        for (const d of [first, ...pending]) {
          try {
            if (ws.readyState === 1) origSend.call(ws, d);
            else toast('⚠ 連線已中斷，訊息可能沒有送出，請到 Messenger 確認', true);
          } catch (e) {
            log(e);
          }
        }
      };
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), CONFIG.messengerHoldMs));
      Promise.race([getPermalink(job.shareUrl), timeout]).then((clean) => {
        const out = replaceShareInFrame(job.bytes, job.found, clean);
        if (!out) {
          warnNeedsUpdate('無法改寫 Messenger 封包', clean);
          release(job.bytes);
          return;
        }
        release(out);
        toast('已用乾淨連結傳送：' + clean);
      }, (e) => {
        log('messenger resolve failed', e);
        release(job.bytes);
        if (!(e && e.needsUpdate)) toast('無法轉換，已用原本的 share 連結傳送');
      });
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
        log(e);
      }
    };
    tidy();
    setInterval(tidy, 1000);
  }
})();
