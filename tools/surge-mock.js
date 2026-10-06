// surge-mock.js — run a Surge http-request script on macOS (JXA / JavaScriptCore)
// with a minimal mock of $httpClient / $persistentStore / $done, for local checks.
//
//   osascript -l JavaScript surge-mock.js SCRIPT.js URL [ARGUMENT]
//
// Environment:
//   SURGE_MOCK_DIR       working dir for temp files (default /tmp)
//   SURGE_MOCK_ARG_FILE  read $argument from this file instead of the command line
//                        (keeps secrets such as cookies out of `ps`)
// Request headers and bodies are handed to curl through files, never on the
// command line. The object passed to $done() is written to $SURGE_MOCK_DIR/result.json.
ObjC.import('Foundation');

function env(name) {
  var v = $.NSProcessInfo.processInfo.environment.objectForKey(name);
  return v && !v.isNil() ? v.js : '';
}

function readText(path) {
  var s = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null);
  return s.isNil() ? '' : s.js;
}

function writeText(path, text) {
  $(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
}

function run(argv) {
  var app = Application.currentApplication();
  app.includeStandardAdditions = true;
  var dir = env('SURGE_MOCK_DIR') || '/tmp';
  var argFile = env('SURGE_MOCK_ARG_FILE');
  var scriptPath = argv[0], url = argv[1];
  var argument = argFile ? readText(argFile) : (argv[2] || '');
  var code = readText(scriptPath);
  var storePath = dir + '/store.json';
  var store = {};
  try { store = JSON.parse(readText(storePath) || '{}'); } catch (e) { store = {}; }
  var sh = function (s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; };
  var log = function () {
    console.log(Array.prototype.slice.call(arguments).map(function (a) {
      return typeof a === 'string' ? a : JSON.stringify(a);
    }).join(' '));
  };

  var httpClient = {};
  ['get', 'post', 'head', 'put', 'delete', 'patch', 'options'].forEach(function (m) {
    httpClient[m] = function (opts, cb) {
      if (typeof opts === 'string') opts = { url: opts };
      var hdrIn = dir + '/req_headers.txt', bodyIn = dir + '/req_body.txt';
      var hdrOut = dir + '/resp_headers.txt', bodyOut = dir + '/resp_body.txt';
      var headers = opts.headers || {};
      writeText(hdrIn, Object.keys(headers).map(function (k) { return k + ': ' + headers[k]; }).join('\n') + '\n');
      var cmd = 'curl -s -m ' + (opts.timeout || 5) + ' -X ' + m.toUpperCase() + ' -H @' + sh(hdrIn) +
        ' -D ' + sh(hdrOut) + ' -o ' + sh(bodyOut) + " -w '%{http_code}'";
      if (opts['auto-redirect'] !== false) cmd += ' -L';
      if (opts.body !== undefined) {
        writeText(bodyIn, typeof opts.body === 'object' ? JSON.stringify(opts.body) : String(opts.body));
        cmd += ' --data-binary @' + sh(bodyIn);
      }
      cmd += ' ' + sh(opts.url);
      var status;
      try {
        status = app.doShellScript(cmd, { alteringLineEndings: false });
      } catch (e) {
        return cb(String(e), null, null);
      }
      var blocks = readText(hdrOut).split(/\r?\n\r?\n/).filter(function (b) { return b.trim(); });
      var respHeaders = {};
      (blocks[blocks.length - 1] || '').split(/\r?\n/).slice(1).forEach(function (line) {
        var i = line.indexOf(':');
        if (i <= 0) return;
        var k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
        var prev = Object.keys(respHeaders).filter(function (x) { return x.toLowerCase() === k.toLowerCase(); })[0];
        if (prev === undefined) respHeaders[k] = v;
        else respHeaders[prev] = [].concat(respHeaders[prev], v); // repeated header, e.g. Set-Cookie
      });
      cb(null, { status: Number(status), headers: respHeaders }, readText(bodyOut));
    };
  });

  var persistentStore = {
    read: function (k) { return Object.prototype.hasOwnProperty.call(store, k || '_') ? store[k || '_'] : null; },
    write: function (v, k) {
      if (v === null) delete store[k || '_']; else store[k || '_'] = String(v);
      writeText(storePath, JSON.stringify(store));
      return true;
    },
  };
  var g = Function('return this')();
  g.$httpClient = httpClient;
  g.$persistentStore = persistentStore;
  g.$argument = argument;
  g.$notification = {
    post: function (title, subtitle, body, opts) {
      var shown = {};
      Object.keys(opts || {}).forEach(function (k) { shown[k] = k === 'text' ? '<' + String(opts.text).length + ' chars>' : opts[k]; });
      log('[mock notification] ' + title + ' | ' + subtitle + ' | ' + body + ' | options: ' + JSON.stringify(shown));
      if (opts && opts.text !== undefined) writeText(dir + '/notification_text.txt', String(opts.text));
    },
  };
  g.$environment = { system: 'tvOS', 'surge-version': 'mock' };
  var reqHeaders = { 'Host': 'live.surge', 'User-Agent': 'AptvPlayer/1.4.6', 'Accept': '*/*' };
  var hf = env('SURGE_MOCK_REQ_HEADERS_FILE');
  if (hf) reqHeaders = JSON.parse(readText(hf));
  if (url !== 'cron') g.$request = { url: url, method: 'GET', id: 'mock', headers: reqHeaders }; // "cron": no $request
  g.$done = function (obj) { writeText(dir + '/result.json', JSON.stringify(obj === undefined ? {} : obj)); };
  writeText(dir + '/result.json', '');
  (0, eval)(code); // top level, like Surge's JSC engine
  return '';
}
