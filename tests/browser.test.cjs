// 用假的瀏覽器環境跑腳本的瀏覽器端：剪貼簿攔截、Messenger 封包排隊、失敗時擋下、除錯紀錄。
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFrame } = require('./helpers/frame.cjs');

const SHARE_A = 'https://www.facebook.com/share/p/1AbCdEfGhJ/';
const SHARE_B = 'https://www.facebook.com/share/r/2KlMnOpQrS/';
const PERMALINKS = {
  '/share/p/1AbCdEfGhJ/': 'https://www.facebook.com/someone/posts/pfbid02abc?rdid=x',
  '/share/r/2KlMnOpQrS/': 'https://www.facebook.com/reel/123456789?rdid=x',
};

function makeElement() {
  const el = {
    style: {}, children: [], handlers: {}, isConnected: false, text: '',
    addEventListener(type, fn) { this.handlers[type] = fn; },
    appendChild(c) { this.children.push(c); c.isConnected = true; },
    click() { this.handlers.click({ stopPropagation() {} }); },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return this.text; },
    set(v) { this.text = v; this.children = []; },
  });
  return el;
}

const env = { written: [], fetchOk: true, fetches: 0, store: {}, copyHandler: null };

class FakeClipboard {
  writeText(text) { env.written.push(text); return Promise.resolve(); }
  write() { return Promise.resolve(); }
}
class FakeWebSocket {
  constructor() { this.url = 'wss://edge-chat.facebook.com/ws/lightspeed?sid=1'; this.readyState = 1; this.sent = []; }
  send(data) { this.sent.push(data); }
}

const body = makeElement();
const set = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
set('window', { Clipboard: FakeClipboard, WebSocket: FakeWebSocket, addEventListener() {} });
set('document', {
  body, activeElement: null,
  createElement: makeElement,
  addEventListener(type, fn) { if (type === 'copy') env.copyHandler = fn; },
  getSelection: () => env.selection || '',
  hasFocus: () => true,
});
set('location', { hostname: 'www.facebook.com', host: 'www.facebook.com', origin: 'https://www.facebook.com', href: 'https://www.facebook.com/', pathname: '/' });
set('navigator', { clipboard: new FakeClipboard(), userAgent: 'test', onLine: true });
set('history', { state: null, replaceState() {} });
set('localStorage', {
  getItem: (k) => (k in env.store ? env.store[k] : null),
  setItem: (k, v) => { env.store[k] = String(v); },
});
set('fetch', async (url) => {
  env.fetches++;
  if (!env.fetchOk) throw new TypeError('Failed to fetch');
  return { url: PERMALINKS[new URL(url).pathname], status: 200, ok: true, redirected: true, text: async () => '' };
});
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = () => 0; // 網址列輪詢會讓測試程序無法結束
require('../ig-fb-cleanlink.user.js');
globalThis.setInterval = realSetInterval;

const toastEl = () => body.children[0];
const frameText = (d) => Buffer.from(d).toString('latin1');
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const FAIL_WAIT = 450; // 失敗會重試一次，中間等 300ms

test('Messenger：連續兩則 share 訊息都會改寫，順序不變', async () => {
  env.fetchOk = true;
  const ws = new FakeWebSocket();
  ws.send(buildFrame(SHARE_A));
  ws.send('ping');
  ws.send(buildFrame(SHARE_B));
  ws.send('pong');
  assert.equal(ws.sent.length, 0); // 全部扣住
  await settle();
  assert.equal(ws.sent.length, 4);
  assert.match(frameText(ws.sent[0]), /someone\\+\/posts\\+\/pfbid02abc/);
  assert.equal(ws.sent[1], 'ping');
  assert.match(frameText(ws.sent[2]), /reel\\+\/123456789/);
  assert.equal(ws.sent[3], 'pong');
  for (const i of [0, 2]) assert.doesNotMatch(frameText(ws.sent[i]), /share|rdid/);
  // 放行後不再排隊
  ws.send('later');
  assert.equal(ws.sent[4], 'later');
});

test('Messenger：轉換失敗時擋下訊息，其他封包照常送出，可手動改用原連結', async () => {
  env.fetchOk = false;
  const ws = new FakeWebSocket();
  const frame = buildFrame('https://www.facebook.com/share/p/9ZzYyXxWw/');
  ws.send(frame);
  ws.send('ping');
  await settle(FAIL_WAIT);
  assert.deepEqual(ws.sent, ['ping']);
  assert.match(toastEl().text, /已擋下這則 Messenger 訊息.*Failed to fetch/);
  const [sendAnyway] = toastEl().children;
  assert.equal(sendAnyway.text, '仍用 share 連結送出');
  sendAnyway.click();
  assert.equal(ws.sent.length, 2);
  assert.deepEqual([...ws.sent[1]], [...frame]);
});

test('複製：成功時只寫入乾淨連結', async () => {
  env.fetchOk = true;
  env.written.length = 0;
  await navigator.clipboard.writeText(SHARE_A + '?mibextid=abc');
  assert.deepEqual(env.written, ['https://www.facebook.com/someone/posts/pfbid02abc']);
});

test('複製：失敗時 share 連結不進剪貼簿，可手動改複製原連結', async () => {
  env.fetchOk = false;
  env.written.length = 0;
  const original = 'https://www.facebook.com/share/p/8QqWwEeRr/';
  await navigator.clipboard.writeText(original);
  assert.deepEqual(env.written, []);
  assert.match(toastEl().text, /已擋下 share 連結/);
  toastEl().children[0].click();
  await settle();
  assert.deepEqual(env.written, [original]);
});

test('複製：execCommand 路徑也會擋下 share 連結', async () => {
  env.fetchOk = true;
  env.written.length = 0;
  env.selection = SHARE_B;
  let prevented = false;
  const data = [];
  env.copyHandler({ preventDefault() { prevented = true; }, clipboardData: { setData: (...a) => data.push(a) } });
  assert.equal(prevented, true);
  assert.deepEqual(data, []);
  await settle();
  assert.deepEqual(env.written, ['https://www.facebook.com/reel/123456789']);
});

test('除錯紀錄：失敗原因會留下來', async () => {
  const lines = window.__igFbCleanLinkLog().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].script, 'IG/FB Clean Link');
  const events = lines.map((l) => l.e);
  for (const e of ['start', 'resolve-ok', 'resolve-failed', 'messenger-rewritten', 'messenger-failed', 'copy-share']) {
    assert.ok(events.includes(e), e);
  }
  const failed = lines.find((l) => l.e === 'messenger-failed');
  assert.equal(failed.blocked, true);
  assert.match(failed.error.message, /Failed to fetch/);
  assert.match(failed.frame.near, /share/);
  assert.ok(JSON.parse(env.store['igFbCleanLink.log']).length > 0);
  // FB 會清掉 localStorage：這個分頁的紀錄仍要拿得到
  delete env.store['igFbCleanLink.log'];
  const again = window.__igFbCleanLinkLog().split('\n');
  assert.equal(again.length, lines.length);
});
