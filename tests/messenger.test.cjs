const test = require('node:test');
const assert = require('node:assert/strict');
const { findShareInFrame, replaceShareInFrame } = require('../ig-fb-cleanlink.user.js');

const { buildFrame } = require('./helpers/frame.cjs');

test('Messenger：找到封包裡的 share 連結並改寫', () => {
  const frame = buildFrame('https://www.facebook.com/share/p/1AbCdEfGhJ/');
  const found = findShareInFrame(frame);
  assert.equal(found.url, 'https://www.facebook.com/share/p/1AbCdEfGhJ/');
  assert.match(found.sep, /^\\+\/$/); // 多層跳脫：數個反斜線 + /

  const clean = 'https://www.facebook.com/permalink.php?story_fbid=pfbid02abc&id=100012345';
  const out = replaceShareInFrame(frame, found, clean);
  const text = Buffer.from(out).toString('latin1');
  assert.ok(!text.includes('share'));
  // 區段長度與實際長度一致，前一個區段不變
  assert.equal(out[11] | (out[12] << 8), out.length - 14);
  assert.deepEqual([...out.slice(0, 8)], [...frame.slice(0, 8)]);
  // 改寫後三層 JSON 仍可解析
  const outer = JSON.parse(text.slice(text.indexOf('{"app_id"')));
  const task = JSON.parse(outer.payload).tasks[0];
  assert.equal(JSON.parse(task.payload).url, clean);
  // 除了網址以外的位元組完全不變
  const before = Buffer.from(frame).toString('latin1');
  assert.equal(text.slice(0, found.index).slice(14), before.slice(0, found.index).slice(14));
  assert.equal(text.slice(-40), before.slice(-40));
});

test('Messenger：同一個封包有多個 share 連結時逐一改寫', () => {
  let frame = buildFrame('https://www.facebook.com/share/p/1AbCdEfGhJ/', 'https://www.facebook.com/share/r/2KlMnOpQrS/');
  const seen = [];
  for (let found; (found = findShareInFrame(frame));) {
    assert.equal(found.error, undefined);
    seen.push(found.url);
    frame = replaceShareInFrame(frame, found, `https://www.facebook.com/reel/${seen.length}`);
    assert.ok(seen.length <= 2);
  }
  assert.deepEqual(seen.sort(), [
    'https://www.facebook.com/share/p/1AbCdEfGhJ/',
    'https://www.facebook.com/share/r/2KlMnOpQrS/',
  ]);
  const text = Buffer.from(frame).toString('latin1');
  assert.equal(frame[11] | (frame[12] << 8), frame.length - 14);
  const inner = JSON.parse(JSON.parse(JSON.parse(text.slice(text.indexOf('{"app_id"'))).payload).tasks[0].payload);
  assert.deepEqual([inner.text, inner.url].sort(), ['https://www.facebook.com/reel/1', 'https://www.facebook.com/reel/2']);
});

test('Messenger：無關的封包不處理', () => {
  assert.equal(findShareInFrame(new Uint8Array(Buffer.from('x'.repeat(40)))), null);
  assert.equal(findShareInFrame(buildFrame('https://www.facebook.com/someone/posts/pfbid02abc')), null);
});

test('Messenger：格式改變時回報 error 而不是亂改', () => {
  const frame = buildFrame('https://www.facebook.com/share/p/1AbCdEfGhJ/');
  const badLen = frame.slice();
  badLen[11] ^= 0x01; // 長度欄位對不上
  assert.match(findShareInFrame(badLen).error, /結構已改變/);
  const badFlag = frame.slice();
  badFlag[13] = 0x07;
  assert.match(findShareInFrame(badFlag).error, /結構已改變/);
  // 連結的寫法變了（例如不再跳脫成同一種分隔）
  const sep = findShareInFrame(frame).sep;
  const text = Buffer.from(frame).toString('latin1').replace('www.facebook.com' + sep + 'share', 'www.facebook.com/share');
  assert.match(findShareInFrame(new Uint8Array(Buffer.from(text, 'latin1'))).error, /連結格式已改變/);
});

test('Messenger：不安全的替換內容會被拒絕', () => {
  const frame = buildFrame('https://www.facebook.com/share/p/1AbCdEfGhJ/');
  const found = findShareInFrame(frame);
  assert.equal(replaceShareInFrame(frame, found, 'https://www.facebook.com/a"b'), null);
  assert.equal(replaceShareInFrame(frame, found, 'javascript:alert(1)'), null);
  assert.equal(replaceShareInFrame(frame, found, 'https://www.facebook.com/' + 'a'.repeat(70000)), null);
});
