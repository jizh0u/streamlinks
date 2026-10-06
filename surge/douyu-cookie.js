/*
 * douyu-cookie.js — Surge http-request script (iPhone, needs MITM)
 *
 * Grabs the Douyu web login when you open douyu.com in Safari while logged in:
 *   - acf_* / dy_* cookies from www.douyu.com / m.douyu.com (valid ~6 days)
 *   - LTP0 from passport.douyu.com (valid for months; lets live-redirect.js on the
 *     Apple TV renew the acf_* cookies by itself every 3 days)
 * checks that the login really works, then
 *   - saves it on THIS device ($persistentStore "live_redirect_douyu_auth"), and
 *   - if the module arguments tv_api / tv_key are set, pushes it to Surge on the
 *     Apple TV through its HTTP API (/v1/scripting/evaluate), so nothing has to be
 *     pasted. Otherwise (or if the push fails) tapping the notification copies it.
 *
 * The request itself is passed through untouched. Nothing is sent anywhere else.
 *
 * Module argument: tv_api=<Apple TV IP>:6171&tv_key=<http-api key>   ("none" = off)
 */

var STORE_STATE = 'douyu_cookie_capture_state'; // {cookie, ltp0, sig, okAt, notifiedAt, pushed}
var STORE_AUTH = 'live_redirect_douyu_auth';    // same record format as live-redirect.js
var STORE_LEGACY = 'live_redirect_douyu_cookie';
var RETRY_MS = 10 * 60 * 1000;       // after a failure, try again at most every 10 min
var QUIET_MS = 12 * 3600 * 1000;     // same login already handled: stay quiet for 12 h
var RENEW_EVERY = 3 * 24 * 3600 * 1000;
var UA_PC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

function header(headers, name) {
  var out = [];
  Object.keys(headers || {}).forEach(function (k) {
    if (k.toLowerCase() === name) out.push(String(headers[k]));
  });
  return out.join('; '); // HTTP/2 may send several cookie headers
}

function parseCookie(str) {
  var map = {}, order = [];
  str.split(';').forEach(function (kv) {
    var i = kv.indexOf('=');
    if (i <= 0) return;
    var k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
    if (!(k in map)) order.push(k);
    map[k] = v;
  });
  return { map: map, order: order };
}

function parseArgs(str) {
  var out = {};
  String(typeof str === 'string' ? str : '').split('&').forEach(function (kv) {
    var i = kv.indexOf('=');
    if (i <= 0) return;
    var v = kv.slice(i + 1).trim();
    if (v === 'none' || /\{\{\{.*\}\}\}/.test(v)) v = '';
    out[kv.slice(0, i).trim()] = v;
  });
  return out;
}

function loadState() {
  try { return JSON.parse($persistentStore.read(STORE_STATE) || '{}') || {}; } catch (e) { return {}; }
}
function saveState(s) { $persistentStore.write(JSON.stringify(s), STORE_STATE); }

function finish() { $done({}); }

function verify(cookie, cb) {
  $httpClient.get({
    url: 'https://www.douyu.com/wgapi/livenc/liveweb/follow/top3',
    headers: { 'Cookie': cookie, 'User-Agent': UA_PC, 'Referer': 'https://www.douyu.com/' },
    timeout: 8,
    'auto-cookie': false,
  }, function (err, resp, body) {
    if (err) return cb(false, '校验请求失败：' + err);
    var ok = false;
    try { ok = JSON.parse(body).error === 0; } catch (e) { ok = false; }
    cb(ok, ok ? '' : '斗鱼说未登录：' + String(body).replace(/\s+/g, ' ').trim().slice(0, 60));
  });
}

// Writes the record into the Apple TV's $persistentStore by evaluating a tiny
// script there. cb(ok, message)
function pushToTV(api, key, rec, cb) {
  var script = '$persistentStore.write(' + JSON.stringify(JSON.stringify(rec)) + ', ' +
    JSON.stringify(STORE_AUTH) + ');\nconsole.log("[douyu-cookie] 收到 iPhone 推送的斗鱼 cookie");\n$done();';
  $httpClient.post({
    url: 'http://' + api.replace(/^https?:\/\//, '').replace(/\/+$/, '') + '/v1/scripting/evaluate',
    headers: { 'X-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ script_text: script, mock_type: 'cron', timeout: 5 }),
    timeout: 6,
    policy: 'DIRECT',
    'auto-cookie': false,
  }, function (err, resp, body) {
    if (err) return cb(false, '连不上 ' + api + '（' + err + '）');
    var st = resp.status || resp.statusCode;
    if (st < 200 || st >= 300) return cb(false, api + ' 返回 HTTP ' + st + (st === 401 || st === 403 ? '（tv_key 不对？）' : ''));
    if (/"error"\s*:\s*"[^"]+"/.test(String(body || ''))) return cb(false, String(body).slice(0, 80));
    cb(true, '');
  });
}

(function main() {
  var host = (/^https?:\/\/([^/:]+)/i.exec($request.url) || [])[1] || '';
  var c = parseCookie(header($request.headers, 'cookie'));
  var st = loadState();
  var now = Date.now();
  var changed = false;

  if (c.map.LTP0 && c.map.LTP0 !== st.ltp0) { st.ltp0 = c.map.LTP0; changed = true; }
  if (/^(www|m)\./i.test(host) && c.map.acf_auth && c.map.acf_uid) {
    var keep = c.order.filter(function (k) { return /^(acf_|dy_)/.test(k); });
    var cookie = keep.map(function (k) { return k + '=' + c.map[k]; }).join('; ');
    if (cookie !== st.cookie) { st.cookie = cookie; changed = true; }
  }
  if (changed) saveState(st);
  if (!st.cookie) return finish(); // no www login seen yet (LTP0 alone is kept for later)

  var auth = parseCookie(st.cookie).map;
  var sig = auth.acf_auth + '|' + (st.ltp0 ? st.ltp0.slice(-12) : '');
  if (sig === st.sig && now - (st.notifiedAt || 0) < (st.okAt ? QUIET_MS : RETRY_MS)) return finish();
  st.sig = sig;
  st.notifiedAt = now;
  st.okAt = 0;
  saveState(st);

  var args = parseArgs(typeof $argument !== 'undefined' ? $argument : '');
  var name = decodeURIComponent(auth.acf_nickname || auth.acf_username || auth.acf_uid);
  var missing = ['acf_auth', 'acf_uid', 'acf_stk', 'acf_ltkid', 'acf_username', 'acf_biz', 'acf_ct', 'dy_did']
    .filter(function (k) { return !(k in auth); });

  verify(st.cookie, function (ok, why) {
    if (!ok) {
      $notification.post('斗鱼 Cookie 无效 ❌', why, '请在 Safari 里重新登录 www.douyu.com 后刷新页面。');
      console.log('[douyu-cookie] invalid: ' + why);
      return finish();
    }
    var payload = st.cookie + (st.ltp0 ? '; LTP0=' + st.ltp0 : '');
    var rec = { cookie: st.cookie, ltp0: st.ltp0 || '', src: 'iphone', savedAt: now, nextRenewAt: now + RENEW_EVERY };
    $persistentStore.write(JSON.stringify(rec), STORE_AUTH);
    $persistentStore.write(st.cookie, STORE_LEGACY);
    st.okAt = now;
    saveState(st);

    var who = '账号：' + name + (missing.length ? '（缺 ' + missing.join('、') + '）' : '');
    var renewNote = st.ltp0 ? '已含 LTP0，Apple TV 会每 3 天自动续期，大约 2~3 个月后才需要再来一次。'
                            : '还没拿到 LTP0（自动续期用），这份 cookie 约 6 天过期。';

    function done(pushed, pushMsg) {
      var title, body, opts;
      if (pushed) {
        title = '斗鱼 Cookie 已推送到 Apple TV ✅';
        body = renewNote;
      } else if (args.tv_api) {
        title = '斗鱼 Cookie 已获取，但推送失败 ⚠️';
        body = pushMsg + '。点这条通知复制 Cookie，手动粘贴到 Apple TV 上「虎牙/斗鱼直播」模块的 douyu_cookie 参数。' + renewNote;
      } else {
        title = '斗鱼 Cookie 已获取 ✅';
        body = '点这条通知复制 Cookie，粘贴到「虎牙/斗鱼直播」模块的 douyu_cookie 参数，再部署到 Apple TV。' + renewNote;
      }
      opts = pushed ? { sound: true } : { action: 'clipboard', text: payload, sound: true };
      if (!st.ltp0 && (pushed || !args.tv_api)) {
        // One more step enables auto-renewal: visiting passport.douyu.com sends LTP0.
        body += ' 👉 点这条通知打开 passport.douyu.com，就能补上 LTP0、开启自动续期（会再弹一次通知）。';
        opts = { action: 'open-url', url: 'https://passport.douyu.com/', sound: true };
      }
      $notification.post(title, who, body, opts);
      if (args.tv_api && !pushed) { st.okAt = 0; saveState(st); } // retry the push in 10 min
      console.log('[douyu-cookie] captured, ltp0=' + (st.ltp0 ? 'yes' : 'no') +
                  (args.tv_api ? ', push ' + (pushed ? 'ok' : 'failed: ' + pushMsg) : ''));
      finish();
    }

    if (args.tv_key === 'change-me') done(false, 'tv_key 还是默认的 change-me，请两边都改成随机字符串');
    else if (args.tv_api && args.tv_key) pushToTV(args.tv_api, args.tv_key, rec, done);
    else if (args.tv_api) done(false, '没有填 tv_key');
    else done(false, '');
  });
})();
