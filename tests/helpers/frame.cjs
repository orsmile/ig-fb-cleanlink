/** 仿照實測抓到的 /ws/lightspeed 封包：一個 "{}" 區段 + 一個帶三層 JSON 的資料區段。 */
function buildFrame(url, text = '') {
  const esc = (s) => JSON.stringify(s).replace(/\//g, '\\/'); // FB 的 JSON 會跳脫斜線
  const inner = esc({ thread_id: 123456789, otid: '7400000000000000000', send_type: 6, text, url });
  const payload = esc({ epoch_id: 7400000000000000000n.toString(), tasks: [{ label: '46', payload: inner, queue_name: '123', task_id: 3 }], version_id: '1' });
  const json = `{"app_id":"2220391788200892","payload":${JSON.stringify(payload)},"request_id":9,"type":3}`;
  const body = Buffer.concat([Buffer.from([0x00, 0x80]), Buffer.from(json, 'latin1')]);
  const head1 = Buffer.from([0x0f, 0x1a, 0x00, 0x02, 0x00, 0x00, 0x7b, 0x7d]);
  const head2 = Buffer.from([0x0d, 0x1a, 0x00, body.length & 0xff, body.length >> 8, 0x00]);
  return new Uint8Array(Buffer.concat([head1, head2, body]));
}

module.exports = { buildFrame };
