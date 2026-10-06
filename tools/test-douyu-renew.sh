#!/bin/zsh
# test-douyu-renew.sh — 用真实登录验证 LTP0 自动续期（Cookie 不会打印出来）。
#
# 用法：在浏览器里打开 https://passport.douyu.com/ ，从开发者工具复制这条请求的
# Cookie 请求头，然后运行
#   zsh test-douyu-renew.sh [斗鱼房间号]
#
# 做的事：
#   1. 只列出剪贴板 Cookie 里的字段名，确认有没有 LTP0 / dy_did；
#   2. 故意只保留 dy_did + LTP0（丢掉所有 acf_*），让 live-redirect.js 在模拟的
#      Surge 环境里走一遍续期，看能不能从零换出一套已登录的 acf_*；
#   3. 用续期得到的 Cookie 解析两次直播间，看是不是原画 + [cookie]；
#   4. 续期失败时，打印跳转链（只有状态码、域名和路径、Set-Cookie 的名字）便于排查。
set -eu

room=${1:-6979222}
here=${0:A:h}
js=$here/../surge/live-redirect.js; [[ -f $js ]] || js=$here/../live-redirect.js
tmp=$(mktemp -d -t douyu-renew)
chmod 700 "$tmp"
trap 'rm -rf "$tmp"' EXIT INT TERM

if [[ -t 0 ]]; then raw=$(pbpaste); else raw=$(cat); fi
print -rn -- "$raw" | tr -d '\r\n' | sed -E 's/^[[:space:]]*[Cc]ookie:[[:space:]]*//; s/[;[:space:]]*$//' > "$tmp/cookie"
unset raw

python3 - "$tmp" <<'EOF'
import json, sys, os
tmp = sys.argv[1]
s = open(tmp + '/cookie').read()
jar = {}
for kv in s.split(';'):
    if '=' in kv:
        k, v = kv.split('=', 1); jar[k.strip()] = v.strip()
names = list(jar)
print('剪贴板 Cookie 共 %d 个字段：%s' % (len(names), ', '.join(names)))
if 'LTP0' not in jar:
    print('\n❌ 没有 LTP0。请确认复制的是 passport.douyu.com 那条请求的 Cookie，并且已登录。')
    sys.exit(2)
did = jar.get('dy_did') or jar.get('acf_did') or ''
print('LTP0：有（%d 字符）  dy_did：%s' % (len(jar['LTP0']), '有' if did else '没有'))
rec = {'cookie': ('dy_did=' + did) if did else '', 'ltp0': jar['LTP0'], 'src': 'test',
       'savedAt': 0, 'nextRenewAt': 0}
if not rec['cookie']:
    rec['cookie'] = 'dy_did=' + os.urandom(16).hex()
    print('（没有 dy_did，用随机的代替）')
json.dump({'live_redirect_douyu_auth': json.dumps(rec)}, open(tmp + '/store.json', 'w'))
EOF

mock() { SURGE_MOCK_DIR=$tmp osascript -l JavaScript "$here/surge-mock.js" "$js" "$@" 2>&1 | grep '\[live-redirect\]' | sed -E 's/ -> .*//; s/^\[live-redirect\] /    /' || true; }

echo
echo "== 续期（只带 dy_did + LTP0，丢掉所有 acf_*）"
mock cron "douyu_cookie=none"

ok=$(python3 - "$tmp" <<'EOF'
import json, sys, time
r = json.loads(json.load(open(sys.argv[1] + '/store.json'))['live_redirect_douyu_auth'])
names = [kv.split('=')[0].strip() for kv in r['cookie'].split(';') if '=' in kv]
sys.stderr.write('    续期后 Cookie 字段：%s\n' % ', '.join(names))
sys.stderr.write('    renewedAt：%s  下次续期：%s  错误：%s\n' % (
    time.strftime('%m-%d %H:%M', time.localtime(r['renewedAt'] / 1000)) if r.get('renewedAt') else '无',
    time.strftime('%m-%d %H:%M', time.localtime(r['nextRenewAt'] / 1000)), r.get('lastError') or '无'))
print('1' if r.get('renewedAt') else '0')
EOF
)

if [[ $ok == 1 ]]; then
  echo
  echo "== 用续期得到的 Cookie 解析 douyu/$room（两次）"
  mock "http://live.surge/douyu/$room" "douyu_cookie=none"
  sleep 2
  mock "http://live.surge/douyu/$room" "douyu_cookie=none"
  echo
  echo "✅ 续期成功。上面两次如果都是 rate=0 原画 + [cookie]，整条链路就通了。"
else
  echo
  echo "== 续期失败，跳转链（不含 Cookie 值）："
  python3 - "$tmp" <<'EOF'
import json, sys, time, urllib.request, urllib.error, urllib.parse
r = json.loads(json.load(open(sys.argv[1] + '/store.json'))['live_redirect_douyu_auth'])
base = r['cookie'] + '; LTP0=' + r['ltp0']
class NoRedir(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a): return None
op = urllib.request.build_opener(NoRedir)
t = int(time.time() * 1000)
url = 'https://passport.douyu.com/lapi/passport/iframe/safeAuth?client_id=1&t=%d&_=%d&callback=cb' % (t, t)
for i in range(6):
    req = urllib.request.Request(url, headers={'Cookie': base, 'Referer': 'https://www.douyu.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'})
    try: resp = op.open(req, timeout=8)
    except urllib.error.HTTPError as e: resp = e
    u = urllib.parse.urlsplit(url)
    sc = [h.split('=')[0] for h in resp.headers.get_all('Set-Cookie') or []]
    body = resp.read(200).decode('utf-8', 'replace').replace('\n', ' ')
    print('    %d %s%s  set-cookie=%s' % (resp.status, u.netloc, u.path, ','.join(sc) or '-'))
    loc = resp.headers.get('Location')
    if not loc or not (300 <= resp.status < 400):
        print('    body: ' + body[:150]); break
    url = urllib.parse.urljoin(url, loc)
EOF
fi
