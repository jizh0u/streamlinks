/*
 * live-redirect.js — Surge http-request script (works on Surge tvOS / iOS / Mac)
 *
 * Point a player (e.g. APTV) at a fake URL, and this script resolves the real
 * Huya / Douyu stream on the device itself (DIRECT, from your home IP) and
 * answers with a 302 redirect. The platform therefore schedules a CDN node for
 * your own ISP (e.g. Shanghai Telecom) instead of for some VPS.
 *
 *   http://live.surge/huya/<room>        top tier = the streamer's original (原画, no ratio)
 *   http://live.surge/douyu/<room>       best tier the request is allowed (guest: 蓝光4M)
 *
 * Optional query parameters
 *   huya : cdn=al|tx|hs   fmt=flv|hls
 *          ratio=max (highest re-encoded tier, e.g. 20000) | ratio=<kbps, e.g. 20000>
 *   douyu: cdn=<line, e.g. hw-h5 / tct-h5>   rate=<0 = best, 4 = 蓝光4M, 3 = 超清 ...>
 *
 * Optional module argument (from #!arguments):
 *   huya_cdn=auto|al|tx|hs&douyu_cdn=&douyu_cookie=<cookie string>
 *   douyu_cookie must be last; everything after "douyu_cookie=" is used as-is.
 *   The cookie can also arrive in $persistentStore (key "live_redirect_douyu_auth",
 *   pushed from the iPhone by douyu-cookie.js). If it contains LTP0 (passport
 *   credential, valid for months), the acf_* login cookies are renewed every 3 days
 *   via passport safeAuth — on demand and from the cron entry of the module
 *   (run without $request).
 *   Douyu guests (no cookie) get 蓝光4M only, and the CDN closes guest streams after
 *   300 s (expire=300; the old URL then answers 403), so the player has to reopen
 *   the live.surge URL to continue.
 */

var UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
var UA_PC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
var STORE_PREFIX = 'live_redirect_';
var G = typeof globalThis !== 'undefined' ? globalThis : Function('return this')();

// ------------------------------------------------------------------ helpers
function HttpError(status, message) {
  this.status = status;
  this.message = message;
}

function parseQuery(qs) {
  var out = {};
  (qs || '').split('&').forEach(function (kv) {
    if (!kv) return;
    var i = kv.indexOf('=');
    var k = i < 0 ? kv : kv.slice(0, i);
    var v = i < 0 ? '' : kv.slice(i + 1);
    try { out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { out[k] = v; }
  });
  return out;
}

function parseArgument(str) {
  var out = {};
  if (typeof str !== 'string' || !str) return out;
  var ck = str.indexOf('douyu_cookie=');
  if (ck >= 0) {
    out.douyu_cookie = str.slice(ck + 'douyu_cookie='.length);
    str = str.slice(0, ck);
    // b64_<base64url> = encoded cookie (what douyu-cookie.js copies): only [A-Za-z0-9_-],
    // so it cannot break the Surge config line.
    var b = /^\s*b64_([A-Za-z0-9_-]+)/.exec(out.douyu_cookie);
    if (b) out.douyu_cookie = base64Decode(b[1].replace(/-/g, '+').replace(/_/g, '/'));
  }
  str.split('&').forEach(function (kv) {
    var i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  });
  Object.keys(out).forEach(function (k) {
    // Unresolved {{{placeholder}}} (no parameter table support) or "none" -> empty.
    if (/\{\{\{.*\}\}\}/.test(out[k]) || out[k] === 'none') out[k] = '';
  });
  return out;
}

function http(method, opts) {
  return new Promise(function (resolve, reject) {
    var o = { timeout: 6, policy: 'DIRECT', 'auto-cookie': false };
    Object.keys(opts).forEach(function (k) { o[k] = opts[k]; });
    $httpClient[method](o, function (err, resp, body) {
      if (err) return reject(new Error(method.toUpperCase() + ' ' + o.url.split('?')[0] + ': ' + err));
      resolve({ status: resp.status || resp.statusCode, headers: resp.headers, body: body });
    });
  });
}

function parseJSON(text, what) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(what + ' 返回的不是 JSON: ' + String(text).slice(0, 120));
  }
}

function md5(str) {
  str = unescape(encodeURIComponent(str));
  function add(x, y) { var l = (x & 0xFFFF) + (y & 0xFFFF); return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xFFFF); }
  function rol(x, n) { return (x << n) | (x >>> (32 - n)); }
  function cmn(q, a, b, x, s, t) { return add(rol(add(add(a, q), add(x, t)), s), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
  var n = str.length, nblk = ((n + 8) >> 6) + 1, x = [], i;
  for (i = 0; i < nblk * 16; i++) x[i] = 0;
  for (i = 0; i < n; i++) x[i >> 2] |= str.charCodeAt(i) << ((i % 4) * 8);
  x[n >> 2] |= 0x80 << ((n % 4) * 8);
  x[nblk * 16 - 2] = n * 8;
  var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (i = 0; i < x.length; i += 16) {
    var oa = a, ob = b, oc = c, od = d;
    a = ff(a, b, c, d, x[i], 7, -680876936); d = ff(d, a, b, c, x[i + 1], 12, -389564586);
    c = ff(c, d, a, b, x[i + 2], 17, 606105819); b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, x[i + 4], 7, -176418897); d = ff(d, a, b, c, x[i + 5], 12, 1200080426);
    c = ff(c, d, a, b, x[i + 6], 17, -1473231341); b = ff(b, c, d, a, x[i + 7], 22, -45705983);
    a = ff(a, b, c, d, x[i + 8], 7, 1770035416); d = ff(d, a, b, c, x[i + 9], 12, -1958414417);
    c = ff(c, d, a, b, x[i + 10], 17, -42063); b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, x[i + 12], 7, 1804603682); d = ff(d, a, b, c, x[i + 13], 12, -40341101);
    c = ff(c, d, a, b, x[i + 14], 17, -1502002290); b = ff(b, c, d, a, x[i + 15], 22, 1236535329);
    a = gg(a, b, c, d, x[i + 1], 5, -165796510); d = gg(d, a, b, c, x[i + 6], 9, -1069501632);
    c = gg(c, d, a, b, x[i + 11], 14, 643717713); b = gg(b, c, d, a, x[i], 20, -373897302);
    a = gg(a, b, c, d, x[i + 5], 5, -701558691); d = gg(d, a, b, c, x[i + 10], 9, 38016083);
    c = gg(c, d, a, b, x[i + 15], 14, -660478335); b = gg(b, c, d, a, x[i + 4], 20, -405537848);
    a = gg(a, b, c, d, x[i + 9], 5, 568446438); d = gg(d, a, b, c, x[i + 14], 9, -1019803690);
    c = gg(c, d, a, b, x[i + 3], 14, -187363961); b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, x[i + 13], 5, -1444681467); d = gg(d, a, b, c, x[i + 2], 9, -51403784);
    c = gg(c, d, a, b, x[i + 7], 14, 1735328473); b = gg(b, c, d, a, x[i + 12], 20, -1926607734);
    a = hh(a, b, c, d, x[i + 5], 4, -378558); d = hh(d, a, b, c, x[i + 8], 11, -2022574463);
    c = hh(c, d, a, b, x[i + 11], 16, 1839030562); b = hh(b, c, d, a, x[i + 14], 23, -35309556);
    a = hh(a, b, c, d, x[i + 1], 4, -1530992060); d = hh(d, a, b, c, x[i + 4], 11, 1272893353);
    c = hh(c, d, a, b, x[i + 7], 16, -155497632); b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, x[i + 13], 4, 681279174); d = hh(d, a, b, c, x[i], 11, -358537222);
    c = hh(c, d, a, b, x[i + 3], 16, -722521979); b = hh(b, c, d, a, x[i + 6], 23, 76029189);
    a = hh(a, b, c, d, x[i + 9], 4, -640364487); d = hh(d, a, b, c, x[i + 12], 11, -421815835);
    c = hh(c, d, a, b, x[i + 15], 16, 530742520); b = hh(b, c, d, a, x[i + 2], 23, -995338651);
    a = ii(a, b, c, d, x[i], 6, -198630844); d = ii(d, a, b, c, x[i + 7], 10, 1126891415);
    c = ii(c, d, a, b, x[i + 14], 15, -1416354905); b = ii(b, c, d, a, x[i + 5], 21, -57434055);
    a = ii(a, b, c, d, x[i + 12], 6, 1700485571); d = ii(d, a, b, c, x[i + 3], 10, -1894986606);
    c = ii(c, d, a, b, x[i + 10], 15, -1051523); b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, x[i + 8], 6, 1873313359); d = ii(d, a, b, c, x[i + 15], 10, -30611744);
    c = ii(c, d, a, b, x[i + 6], 15, -1560198380); b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, x[i + 4], 6, -145523070); d = ii(d, a, b, c, x[i + 11], 10, -1120210379);
    c = ii(c, d, a, b, x[i + 2], 15, 718787259); b = ii(b, c, d, a, x[i + 9], 21, -343485551);
    a = add(a, oa); b = add(b, ob); c = add(c, oc); d = add(d, od);
  }
  var hex = '0123456789abcdef', out = '', w = [a, b, c, d];
  for (i = 0; i < 4; i++) {
    for (var j = 0; j < 4; j++) {
      var by = (w[i] >> (j * 8)) & 0xFF;
      out += hex.charAt((by >> 4) & 0xF) + hex.charAt(by & 0xF);
    }
  }
  return out;
}

function base64Decode(s) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var out = '', buf = 0, bits = 0;
  s = String(s).replace(/[^A-Za-z0-9+/]/g, '');
  for (var i = 0; i < s.length; i++) {
    buf = (buf << 6) | chars.indexOf(s.charAt(i));
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buf >> bits) & 0xFF);
    }
  }
  return out;
}

function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function randomHex(len) {
  var s = '';
  while (s.length < len) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

function storeRead(key) {
  try { return $persistentStore.read(STORE_PREFIX + key); } catch (e) { return null; }
}

function storeWrite(key, value) {
  try { $persistentStore.write(value, STORE_PREFIX + key); } catch (e) { /* ignore */ }
}

// --------------------------------------------------------------------- Huya
// Huya's tier list (liveData.bitRateInfo), e.g.
//   蓝光30M iBitRate=0 | 蓝光20M 20000 | 蓝光8M 8000 | 蓝光4M 4000 | 超清 2000 | 流畅 500
// iBitRate 0 is the streamer's original, requested WITHOUT a ratio parameter
// (verified: room 998's original is 2560x1440 while ratio=20000 is a 1080p
// re-encode, and ratio=50000 for its "蓝光50M" label does not exist).
// The onMetaData "videodatarate: 8000" of the original stream is a fake label.
function huyaTiers(d) {
  var ld = d.liveData || {};
  var tiers = [];
  try { tiers = JSON.parse(ld.bitRateInfo || '[]') || []; } catch (e) { tiers = []; }
  if (!tiers.length && d.stream && d.stream.flv) tiers = d.stream.flv.rateArray || [];
  return tiers.map(function (t) { return { name: t.sDisplayName, ratio: Number(t.iBitRate) || 0 }; });
}

// Returns the ratio to request: 0 = original (no ratio parameter).
function huyaPickRatio(d, wanted) {
  var tiers = huyaTiers(d);
  var reencoded = tiers.map(function (t) { return t.ratio; }).filter(function (r) { return r > 0; });
  var maxReencoded = reencoded.length ? Math.max.apply(null, reencoded) : 0;
  if (wanted === 'max') return maxReencoded;
  if (wanted !== undefined && wanted !== '') return Number(wanted) || 0;
  var hasOriginal = !tiers.length || tiers.some(function (t) { return t.ratio === 0; });
  return hasOriginal ? 0 : maxReencoded;
}

function huyaTierName(d, ratio) {
  var t = huyaTiers(d).filter(function (x) { return x.ratio === ratio; })[0];
  return t ? t.name : (ratio ? String(ratio) : '原画');
}

// Re-sign the anticode the way Huya's H5 player SDK does; the anticode returned
// by the API as-is is rejected by some CDN nodes.
function huyaAntiCode(oldAntiCode, streamName) {
  var q = parseQuery(oldAntiCode);
  var ctype = q.ctype || 'huya_live';
  var t = q.t || '100';
  var pf = base64Decode(q.fm || '').split('_')[0];
  var t13 = Date.now();
  var uid = randInt(1400000000000, 1400009999999);
  var seqid = uid + t13;
  var wsTime = q.wsTime || Math.floor(t13 / 1000 + 6 * 3600).toString(16);
  var hash = md5(seqid + '|' + ctype + '|' + t);
  var wsSecret = md5(pf + '_' + uid + '_' + streamName + '_' + hash + '_' + wsTime);
  var uuid = ((t13 % 1e10) * 1000 + randInt(0, 999)) % 4294967295;
  return 'wsSecret=' + wsSecret + '&wsTime=' + wsTime + '&seqid=' + seqid + '&ctype=' + ctype +
    '&ver=1&fs=' + (q.fs || 'bgct') + '&uuid=' + uuid + '&u=' + uid + '&t=' + t +
    '&sv=2401310322&sdk_sid=' + t13 + '&codec=264';
}

function huya(room, q, args) {
  return http('get', {
    url: 'https://mp.huya.com/cache.php?m=Live&do=profileRoom&roomid=' + encodeURIComponent(room),
    headers: { 'User-Agent': UA_MOBILE, 'Referer': 'https://m.huya.com/' },
  }).then(function (r) {
    var j = parseJSON(r.body, '虎牙接口');
    var d = j && j.data;
    if (!d || typeof d !== 'object') throw new HttpError(404, '虎牙房间 ' + room + ' 不存在: ' + (j && j.message));
    if (d.liveStatus !== 'ON' && d.liveStatus !== 'REPLAY') {
      throw new HttpError(404, '虎牙 ' + room + (d.liveStatus ? ' 未开播 (' + d.liveStatus + ')' : ' 房间不存在'));
    }
    var list = ((d.stream && d.stream.baseSteamInfoList) || []).filter(function (s) {
      return s.sStreamName && s.sFlvUrl && s.sFlvAntiCode;
    });
    if (!list.length) throw new HttpError(404, '虎牙 ' + room + ' 没有可用的流');

    var want = String(q.cdn || args.huya_cdn || 'auto').toUpperCase();
    var s = list.filter(function (x) { return x.sCdnType === want; })[0];
    if (!s) {
      s = list.slice().sort(function (a, b) {
        return (Number(b.iWebPriorityRate) || 0) - (Number(a.iWebPriorityRate) || 0);
      })[0];
    }
    var ratio = huyaPickRatio(d, q.ratio);
    var hls = String(q.fmt || '').toLowerCase() === 'hls';
    var base = hls ? s.sHlsUrl + '/' + s.sStreamName + '.' + (s.sHlsUrlSuffix || 'm3u8')
                   : s.sFlvUrl + '/' + s.sStreamName + '.' + (s.sFlvUrlSuffix || 'flv');
    var url = base + '?' + huyaAntiCode(hls ? (s.sHlsAntiCode || s.sFlvAntiCode) : s.sFlvAntiCode, s.sStreamName);
    if (ratio > 0) url += '&ratio=' + ratio;
    return { url: url, note: s.sCdnType + ' ' + huyaTierName(d, ratio) + (ratio ? ' ratio=' + ratio : '') };
  });
}

// -------------------------------------------------------------------- Douyu
function douyuRealRid(room) {
  var cached = storeRead('dy_rid_' + room);
  if (cached) return Promise.resolve(cached);
  return http('get', {
    url: 'https://www.douyu.com/' + encodeURIComponent(room),
    headers: { 'User-Agent': UA_PC, 'Referer': 'https://www.douyu.com/' },
  }).then(function (r) {
    var m = /room_id\\?"?\s*[:=]\s*(\d+)/.exec(r.body || '');
    var rid = m ? m[1] : room;
    if (m) storeWrite('dy_rid_' + room, rid);
    return rid;
  }, function (e) {
    console.log('[live-redirect] douyu room page failed, using ' + room + ' as-is: ' + e.message);
    return room;
  });
}

function installCryptoJSShim() {
  if (!G.CryptoJS) {
    G.CryptoJS = { MD5: function (s) { var h = md5(String(s)); return { toString: function () { return h; } }; } };
  }
  if (!G.window) G.window = G;
  if (!G.navigator) G.navigator = { userAgent: UA_PC };
}

// ------------------------------------------------------------ Douyu login
// Since 2026-09 Douyu guests get at most 蓝光4M and stream URLs that the CDN cuts
// after 300 s (expire=300); a logged-in web cookie (acf_*) is what other projects
// use for 原画 / 8M. The acf_* cookies live ~6.1 days. With LTP0 (the long-lived
// passport.douyu.com credential, months) they can be renewed through
// passport safeAuth, the way bililive-go / biliLive-tools do it.
//
// State: $persistentStore "live_redirect_douyu_auth" = JSON
//   { cookie, ltp0, src, savedAt, nextRenewAt, renewedAt, lastError }
// Sources, in this order:
//   1. module argument douyu_cookie, adopted only when it differs from the value
//      adopted last time (so a renewed cookie is not overwritten by the stale one);
//   2. the stored record (written by renewals, or pushed from the iPhone by
//      douyu-cookie.js through Surge's HTTP API);
//   3. the old plain-cookie key "live_redirect_douyu_cookie".
var DAY = 24 * 3600 * 1000;
var RENEW_EVERY = 3 * DAY;
var RENEW_RETRY = 6 * 3600 * 1000;
var RENEW_RETRY_INVALID = DAY;

function cookieValue(cookie, name) {
  var m = new RegExp('(?:^|;\\s*)' + name + '=([^;]*)').exec(cookie || '');
  return m ? m[1] : '';
}

function normCookie(s) {
  return String(s || '').replace(/[\r\n]+/g, '').trim().replace(/^cookie:\s*/i, '').replace(/;\s*$/, '');
}

function parseCookieStr(s) {
  var jar = { map: {}, order: [] };
  normCookie(s).split(';').forEach(function (kv) {
    var i = kv.indexOf('=');
    if (i <= 0) return;
    var k = kv.slice(0, i).trim();
    if (!(k in jar.map)) jar.order.push(k);
    jar.map[k] = kv.slice(i + 1).trim();
  });
  return jar;
}

function jarString(jar, skip) {
  return jar.order.filter(function (k) { return k !== skip && jar.map[k] !== undefined; })
    .map(function (k) { return k + '=' + jar.map[k]; }).join('; ');
}

function authFromCookie(str, src) {
  var jar = parseCookieStr(str);
  var now = Date.now();
  return { cookie: jarString(jar, 'LTP0'), ltp0: jar.map.LTP0 || '', src: src, savedAt: now,
           nextRenewAt: now + RENEW_EVERY };
}

function authLoad(args) {
  var rec = null;
  try { rec = JSON.parse(storeRead('douyu_auth') || 'null'); } catch (e) { rec = null; }
  var param = normCookie(args.douyu_cookie);
  if (param && param !== storeRead('douyu_param_seen')) {
    rec = authFromCookie(param, 'param');
    storeWrite('douyu_param_seen', param);
    authSave(rec);
  }
  if (!rec || !rec.cookie) {
    var legacy = normCookie(storeRead('douyu_cookie'));
    if (legacy) {
      rec = authFromCookie(legacy, 'store');
      authSave(rec);
    }
  }
  return rec && rec.cookie ? rec : null;
}

function authSave(rec) { storeWrite('douyu_auth', JSON.stringify(rec)); }

// All Set-Cookie headers of a response as [name, value] pairs. Surge may hand
// several Set-Cookie headers over as an array or as one comma/newline-joined string.
function setCookiePairs(headers) {
  var out = [];
  Object.keys(headers || {}).forEach(function (k) {
    if (k.toLowerCase() !== 'set-cookie') return;
    var v = headers[k];
    (Array.isArray(v) ? v : String(v).split(/\n|,(?=\s*[^;,=\s]+=)/)).forEach(function (sc) {
      var first = String(sc).split(';')[0];
      var i = first.indexOf('=');
      if (i > 0) out.push([first.slice(0, i).trim(), first.slice(i + 1).trim()]);
    });
  });
  return out;
}

function douyuLoggedIn(cookie) {
  return http('get', {
    url: 'https://www.douyu.com/wgapi/livenc/liveweb/follow/top3',
    headers: { 'User-Agent': UA_PC, 'Referer': 'https://www.douyu.com/', 'Cookie': cookie },
    timeout: 5,
  }).then(function (r) {
    try { return JSON.parse(r.body).error === 0; } catch (e) { return false; }
  });
}

// passport safeAuth with LTP0 -> 302 to a one-time www.douyu.com login URL that
// sets fresh acf_* cookies. Redirects are followed by hand so that the
// Set-Cookie of every hop is kept.
function authRenew(rec) {
  var jar = parseCookieStr(rec.cookie);
  var did = jar.map.dy_did || jar.map.acf_did || '';
  var base = (did ? 'dy_did=' + did + '; ' : '') + 'LTP0=' + rec.ltp0;
  var fresh = {};
  var t = Date.now();

  function hop(url, n) {
    return http('get', {
      url: url,
      headers: { 'User-Agent': UA_PC, 'Referer': 'https://www.douyu.com/', 'Cookie': base },
      timeout: 5,
      'auto-redirect': false,
    }).then(function (r) {
      setCookiePairs(r.headers).forEach(function (p) { if (p[1] && p[1] !== 'deleted') fresh[p[0]] = p[1]; });
      var loc = '';
      Object.keys(r.headers || {}).forEach(function (k) { if (k.toLowerCase() === 'location') loc = r.headers[k]; });
      if (r.status >= 300 && r.status < 400 && loc && n < 6) {
        if (/^\/\//.test(loc)) loc = 'https:' + loc;
        else if (/^\//.test(loc)) loc = url.replace(/^(https?:\/\/[^/]+).*$/, '$1') + loc;
        if (!/^https?:\/\/([a-z0-9-]+\.)*douyu\.com\//i.test(loc)) throw new Error('续期跳到了非斗鱼地址');
        return hop(loc, n + 1);
      }
      return r;
    });
  }

  return hop('https://passport.douyu.com/lapi/passport/iframe/safeAuth?client_id=1&t=' + t + '&_=' + t +
             '&callback=cb', 0).then(function (last) {
    if (!fresh.acf_auth) {
      var e = new Error('没有拿到新的 acf_auth: ' + String(last.body || '').replace(/\s+/g, ' ').slice(0, 80));
      e.invalid = /未登录|error"?\s*:\s*1/.test(String(last.body || ''));
      throw e;
    }
    Object.keys(fresh).forEach(function (k) {
      if (k === 'LTP0') return;
      if (!(k in jar.map)) jar.order.push(k);
      jar.map[k] = fresh[k];
    });
    var cookie = jarString(jar, 'LTP0');
    return douyuLoggedIn(cookie).then(function (ok) {
      if (!ok) { var e = new Error('续期后的 cookie 仍未登录'); e.invalid = true; throw e; }
      return { cookie: cookie, ltp0: fresh.LTP0 || '' };
    });
  });
}

// Returns a Promise of the cookie string to use ('' = guest). Renews first when due.
function douyuAuthReady(args, force) {
  var rec = authLoad(args);
  if (!rec) return Promise.resolve('');
  var now = Date.now();
  if (!rec.ltp0) return Promise.resolve(rec.cookie);
  // Due every RENEW_EVERY; right away when only dy_did + LTP0 were supplied (no acf_auth
  // yet), unless that already failed (then the retry schedule in nextRenewAt applies).
  var bare = !cookieValue(rec.cookie, 'acf_auth') && !rec.lastError;
  if (!force && !bare && now < (rec.nextRenewAt || 0)) return Promise.resolve(rec.cookie);
  return authRenew(rec).then(function (res) {
    var cookie = res.cookie;
    if (res.ltp0) rec.ltp0 = res.ltp0; // passport may rotate LTP0
    rec.cookie = cookie;
    rec.renewedAt = now;
    rec.nextRenewAt = now + RENEW_EVERY;
    rec.lastError = '';
    authSave(rec);
    console.log('[live-redirect] 斗鱼 cookie 已自动续期，下次 ' + new Date(rec.nextRenewAt).toISOString().slice(0, 10));
    return cookie;
  }, function (e) {
    rec.nextRenewAt = now + (e.invalid ? RENEW_RETRY_INVALID : RENEW_RETRY);
    rec.lastError = e.message;
    authSave(rec);
    console.log('[live-redirect] 斗鱼 cookie 续期失败' + (e.invalid ? '（LTP0 可能已失效，需要重新抓取）' : '') +
                ': ' + e.message);
    return rec.cookie;
  });
}

function douyu(room, q, args) {
  return douyuAuthReady(args, false).then(function (cookie) { return douyuPlay(room, q, args, cookie); });
}

function douyuPlay(room, q, args, userCookie) {
  var cdn = q.cdn !== undefined ? q.cdn : (args.douyu_cdn || '');
  var rate = q.rate !== undefined ? q.rate : '0';
  var rid, signFn;
  var tries = 1; // getH5Play requests for the current identity (max 3, see again())

  function guestDid() {
    var did = storeRead('dy_did');
    if (!did) {
      did = randomHex(32);
      storeWrite('dy_did', did);
    }
    return did;
  }

  // One signed getH5Play call. The signing did must be the device id the
  // cookie was issued to (dy_did, else acf_did / acf_devid).
  function play(cookieIn) {
    var did = cookieIn && (cookieValue(cookieIn, 'dy_did') || cookieValue(cookieIn, 'acf_did') ||
                           cookieValue(cookieIn, 'acf_devid'));
    var cookie = cookieIn;
    if (!did) {
      did = guestDid();
      cookie = 'dy_did=' + did + '; acf_did=' + did + (cookieIn ? '; ' + cookieIn : '');
    }
    var sign = G[signFn](rid, did, String(Math.floor(Date.now() / 1000)));
    var body = sign + '&cdn=' + encodeURIComponent(cdn) + '&rate=' + encodeURIComponent(rate) +
      '&ver=Douyu_223061205&iar=0&ive=0&hevc=0&fa=0';
    return http('post', {
      url: 'https://www.douyu.com/lapi/live/getH5Play/' + rid,
      headers: {
        'User-Agent': UA_PC,
        'Referer': 'https://www.douyu.com/' + room,
        'Origin': 'https://www.douyu.com',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookie,
      },
      body: body,
    }).then(function (r) {
      var j;
      try { j = JSON.parse(r.body); } catch (e) {
        return { ok: false, j: null, msg: '返回的不是 JSON: ' + String(r.body).replace(/\s+/g, ' ').slice(0, 80),
                 error: 'HTTP ' + r.status };
      }
      var ok = j && j.error === 0 && j.data && j.data.rtmp_url;
      return { ok: !!ok, j: j, msg: (j && j.msg) || '未开播', error: j && j.error };
    });
  }

  return douyuRealRid(room).then(function (r) {
    rid = r;
    return http('get', {
      url: 'https://www.douyu.com/swf_api/homeH5Enc?rids=' + rid,
      headers: { 'User-Agent': UA_PC, 'Referer': 'https://www.douyu.com/' + room },
    });
  }).then(function (r) {
    var enc = parseJSON(r.body, '斗鱼 homeH5Enc');
    var js = enc && enc.data && enc.data['room' + rid];
    if (!js) throw new Error('斗鱼签名脚本获取失败: ' + String(r.body).slice(0, 120));
    installCryptoJSShim();
    (0, eval)(js); // defines the signing function in global scope
    signFn = (/function\s+(ub98484234)\s*\(/.exec(js) || /function\s+(ub\d+)\s*\(/.exec(js) || [])[1];
    if (!signFn || typeof G[signFn] !== 'function') throw new Error('斗鱼签名函数不存在');
    return play(userCookie);
  }).then(function (res) {
    // An expired login cookie may get the request rejected instead of downgraded:
    // retry once as a guest so the channel still plays.
    if (res.ok || !userCookie) return res;
    console.log('[live-redirect] 斗鱼 带 cookie 的请求失败 (error ' + res.error + ' ' + res.msg + ')，改用游客身份重试');
    userCookie = '';
    return play('');
  }).then(function (res) {
    // Douyu grants 原画 to guests on some requests only (about 1 in 3 when tested,
    // random per request, same did). If the room has 原画 but this answer is a
    // lower tier, ask at most twice more.
    function again(r) {
      var d = r.ok && r.j.data;
      var hasOriginal = d && (d.multirates || []).some(function (x) { return String(x.rate) === '0'; });
      if (!d || String(rate) !== '0' || String(d.rate) === '0' || !hasOriginal || tries >= 3) return r;
      tries++;
      return play(userCookie).then(again);
    }
    return again(res);
  }).then(function (res) {
    if (!res.ok) throw new HttpError(res.j ? 404 : 502, '斗鱼 ' + room + ': ' + res.msg + ' (error ' + res.error + ')');
    var d = res.j.data;
    var rates = d.multirates || [];
    var rateName = (rates.filter(function (x) { return String(x.rate) === String(d.rate); })[0] || {}).name;
    var expire = (/[?&]expire=(\d+)/.exec(d.rtmp_live || '') || [])[1];
    if (userCookie && String(rate) === '0' && String(d.rate) !== '0' &&
        rates.some(function (x) { return String(x.rate) === '0'; })) {
      console.log('[live-redirect] 斗鱼 已带 cookie，' + tries + ' 次请求都没拿到原画 (rate=' + d.rate + ')，cookie 可能已过期');
    }
    return {
      url: d.rtmp_url + '/' + d.rtmp_live,
      note: (d.rtmp_cdn || '') + ' rate=' + d.rate + (rateName ? ' ' + rateName : '') +
        (expire ? ' expire=' + expire : '') + (userCookie ? ' [cookie]' : ' [游客]') +
        (tries > 1 ? ' 第' + tries + '次请求' : ''),
    };
  });
}

// --------------------------------------------------------------------- main
var HELP = 'live-redirect: use http://live.surge/huya/<room> or http://live.surge/douyu/<room>\n';

function reply(status, headers, body) {
  headers = headers || {};
  headers['Cache-Control'] = 'no-store';
  if (body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'text/plain; charset=utf-8';
  $done({ response: { status: status, headers: headers, body: body || '' } });
}

(function main() {
  var args0 = parseArgument(typeof $argument !== 'undefined' ? $argument : '');
  if (typeof $request === 'undefined') {
    // cron: keep the Douyu login fresh even when nobody is watching.
    var rec0 = authLoad(args0);
    if (!rec0) { console.log('[live-redirect] cron: 没有斗鱼 cookie，跳过'); return $done(); }
    if (!rec0.ltp0) { console.log('[live-redirect] cron: cookie 里没有 LTP0，无法自动续期'); return $done(); }
    douyuAuthReady(args0, false).then(function () {
      var r = authLoad(args0) || {};
      console.log('[live-redirect] cron: 下次续期 ' + new Date(r.nextRenewAt || 0).toISOString() +
                  (r.lastError ? '，上次错误: ' + r.lastError : ''));
      $done();
    }, function (e) { console.log('[live-redirect] cron: ' + e); $done(); });
    return;
  }
  var match = /^https?:\/\/live\.surge(?::\d+)?\/(huya|douyu)\/([^/?#]+?)(?:\.(flv|m3u8))?\/?(?:\?([^#]*))?$/i
    .exec($request.url.split('#')[0]);
  if (!match) return reply(404, null, HELP);
  var platform = match[1].toLowerCase();
  var room = decodeURIComponent(match[2]);
  var q = parseQuery(match[4]);
  if (match[3] && q.fmt === undefined) q.fmt = match[3].toLowerCase() === 'm3u8' ? 'hls' : 'flv';
  var args = parseArgument(typeof $argument !== 'undefined' ? $argument : '');
  var job = platform === 'huya' ? huya(room, q, args) : douyu(room, q, args);
  job.then(function (res) {
    console.log('[live-redirect] ' + platform + '/' + room + ' ' + res.note + ' -> ' + res.url);
    reply(302, { 'Location': res.url }, 'Redirecting to ' + res.url + '\n');
  }).catch(function (e) {
    var status = e instanceof HttpError ? e.status : 502;
    var msg = (e && e.message) || String(e);
    console.log('[live-redirect] ' + platform + '/' + room + ' failed: ' + msg);
    reply(status, null, msg + '\n');
  });
})();
