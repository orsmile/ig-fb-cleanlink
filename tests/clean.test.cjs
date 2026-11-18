const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanUrl, cleanText, extractCanonical } = require('../ig-fb-cleanlink.user.js');

const url = (s, o) => cleanUrl(s, o)?.url;

test('IG：貼文與 Reels 去除追蹤參數', () => {
  assert.equal(
    url('https://www.instagram.com/p/DAbc123/?utm_source=ig_web_copy_link&igsh=MzRlODBiNWFlZA=='),
    'https://www.instagram.com/p/DAbc123/');
  assert.equal(
    url('https://www.instagram.com/reel/DAbc123/?igsh=abc'),
    'https://www.instagram.com/reel/DAbc123/');
  assert.equal(
    url('https://www.instagram.com/someone/p/DAbc123/?igsh=abc&img_index=3'),
    'https://www.instagram.com/someone/p/DAbc123/?img_index=3');
});

test('IG：個人頁只移除已知追蹤參數', () => {
  assert.equal(
    url('https://www.instagram.com/someone/?igsh=abc&utm_source=qr&hl=zh-tw'),
    'https://www.instagram.com/someone/?hl=zh-tw');
});

test('IG：乾淨連結不變', () => {
  const r = cleanUrl('https://www.instagram.com/p/DAbc123/');
  assert.equal(r.changed, false);
  assert.equal(r.url, 'https://www.instagram.com/p/DAbc123/');
});

test('FB：share 連結標記為需要解析', () => {
  for (const p of ['p/1AbCdEf/', 'v/1AbCdEf/', 'r/1AbCdEf/', '1AbCdEf/']) {
    const r = cleanUrl(`https://www.facebook.com/share/${p}?mibextid=wwXIfr`);
    assert.equal(r.needsResolve, true, p);
    assert.equal(r.url, `https://www.facebook.com/share/${p}`);
  }
  assert.equal(cleanUrl('https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fa.b').needsResolve, false);
});

test('FB：解析後的 permalink 清掉 rdid / share_url', () => {
  assert.equal(
    url('https://www.facebook.com/someone/posts/pfbid02abc?rdid=xyz&share_url=https%3A%2F%2Fwww.facebook.com%2Fshare%2Fp%2F1AbCdEf%2F'),
    'https://www.facebook.com/someone/posts/pfbid02abc');
  assert.equal(
    url('https://www.facebook.com/permalink.php?story_fbid=pfbid02abc&id=100012345&rdid=xyz&share_url=x&__cft__[0]=AZX&__tn__=%2CO%2CP-R'),
    'https://www.facebook.com/permalink.php?story_fbid=pfbid02abc&id=100012345');
  assert.equal(
    url('https://www.facebook.com/groups/123456/permalink/7890/?rdid=xyz&mibextid=abc'),
    'https://www.facebook.com/groups/123456/permalink/7890/');
  assert.equal(
    url('https://www.facebook.com/reel/123456789?rdid=xyz&fs=e&s=TIeQ9V'),
    'https://www.facebook.com/reel/123456789');
});

test('FB：保留屬於連結本體的參數', () => {
  assert.equal(
    url('https://www.facebook.com/photo/?fbid=123&set=a.456&__cft__[0]=AZX&__tn__=EH-R'),
    'https://www.facebook.com/photo/?fbid=123&set=a.456');
  assert.equal(
    url('https://www.facebook.com/watch/?v=987654&ref=sharing&mibextid=abc'),
    'https://www.facebook.com/watch/?v=987654');
  assert.equal(
    url('https://www.facebook.com/someone/posts/pfbid02abc?comment_id=555&notif_id=1&__tn__=R'),
    'https://www.facebook.com/someone/posts/pfbid02abc?comment_id=555');
  assert.equal(
    url('https://www.facebook.com/profile.php?id=100012345&sk=about&fbclid=abc'),
    'https://www.facebook.com/profile.php?id=100012345');
});

test('FB：未知路徑只移除已知追蹤參數', () => {
  assert.equal(
    url('https://www.facebook.com/events/123/?active_tab=discussion&ref=newsfeed&fbclid=abc'),
    'https://www.facebook.com/events/123/?active_tab=discussion');
  const r = cleanUrl('https://www.facebook.com/search/top?q=hello%20world');
  assert.equal(r.changed, false);
  assert.equal(r.url, 'https://www.facebook.com/search/top?q=hello%20world');
});

test('FB：行動版網域轉成 www，keepHost 時不動', () => {
  assert.equal(
    url('https://m.facebook.com/story.php?story_fbid=1&id=2&mibextid=abc'),
    'https://www.facebook.com/story.php?story_fbid=1&id=2');
  assert.equal(
    url('https://m.facebook.com/story.php?story_fbid=1&id=2&mibextid=abc', { keepHost: true }),
    'https://m.facebook.com/story.php?story_fbid=1&id=2');
});

test('連結跳板還原成目標網址', () => {
  assert.equal(
    url('https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1%26fbclid%3Dabc&h=AT0xyz'),
    'https://example.com/a?x=1');
  assert.equal(
    url('https://l.instagram.com/?u=https%3A%2F%2Fwww.instagram.com%2Fp%2FDAbc%2F%3Figsh%3Dabc&e=AT0'),
    'https://www.instagram.com/p/DAbc/');
});

test('cleanText：只處理整段是單一 IG/FB 網址的文字', () => {
  assert.equal(cleanText('看這篇 https://www.instagram.com/p/DAbc/?igsh=abc'), null);
  assert.equal(cleanText('https://example.com/?fbclid=abc'), null);
  assert.equal(cleanText('not a url'), null);
  assert.equal(cleanText(undefined), null);
  assert.equal(cleanText('  https://www.instagram.com/p/DAbc/?igsh=abc\n').url, 'https://www.instagram.com/p/DAbc/');
});

test('extractCanonical：從 HTML 取正式連結', () => {
  assert.equal(
    extractCanonical('<head><link rel="canonical" href="https://www.facebook.com/a/posts/1?x=1&amp;y=2" /></head>'),
    'https://www.facebook.com/a/posts/1?x=1&y=2');
  assert.equal(
    extractCanonical('<meta property="og:url" content="https://www.facebook.com/reel/1" />'),
    'https://www.facebook.com/reel/1');
  assert.equal(extractCanonical('<html></html>'), null);
});

test('檔頭 @version 與程式內的 VERSION 一致', () => {
  const src = require('node:fs').readFileSync(require.resolve('../ig-fb-cleanlink.user.js'), 'utf8');
  const header = /^\/\/ @version\s+(\S+)/m.exec(src)[1];
  const inCode = /const VERSION = '([^']+)'/.exec(src)[1];
  assert.equal(header, inCode);
});

test('來源改寫：把 wrapped_url 換成 original_content_url', () => {
  const { rewriteWrappedUrl } = require('../ig-fb-cleanlink.user.js');
  const make = (original, wrapped) => JSON.stringify({
    data: { xfb_create_share_url_wrapper: { share_url_wrapper: { id: '123', original_content_url: original, wrapped_url: wrapped } } },
    extensions: { is_final: true },
  });
  const share = 'https://www.facebook.com/share/p/1AbCdEfGhJ/';
  const r = rewriteWrappedUrl(make('https://www.facebook.com/someone/posts/pfbid02abc?__cft__[0]=AZX', share));
  assert.equal(r.clean, 'https://www.facebook.com/someone/posts/pfbid02abc');
  assert.equal(r.share, share);
  const w = JSON.parse(r.text).data.xfb_create_share_url_wrapper.share_url_wrapper;
  assert.equal(w.wrapped_url, 'https://www.facebook.com/someone/posts/pfbid02abc');
  assert.match(w.original_content_url, /__cft__/); // 其他欄位不動

  // 斜線有跳脫的寫法
  const escaped = make('https://www.facebook.com/reel/123456789', share).replace(/\//g, '\/');
  const r2 = rewriteWrappedUrl(escaped);
  assert.ok(r2.text.includes('"wrapped_url":"https:\/\/www.facebook.com\/reel\/123456789"'));
  assert.equal(JSON.parse(r2.text).data.xfb_create_share_url_wrapper.share_url_wrapper.wrapped_url, 'https://www.facebook.com/reel/123456789');

  // 不該動的情況：原始連結不是 FB、wrapped 不是 share 連結、欄位不齊、非字串
  assert.equal(rewriteWrappedUrl(make('https://example.com/a', share)), null);
  assert.equal(rewriteWrappedUrl(make('https://www.facebook.com/reel/1', 'https://www.facebook.com/reel/1')), null);
  assert.equal(rewriteWrappedUrl(make(share, share)), null);
  assert.equal(rewriteWrappedUrl('{"wrapped_url":"' + share + '"}'), null);
  assert.equal(rewriteWrappedUrl(undefined), null);
});
