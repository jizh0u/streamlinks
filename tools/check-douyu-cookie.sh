#!/bin/zsh
# check-douyu-cookie.sh — 检查剪贴板里的斗鱼 Cookie 能不能用。
#
# 会告诉你：关键字段齐不齐、是否已登录，以及用 live-redirect.js 本身分别以游客/带 Cookie
# 解析一次的结果（拿到哪一档、地址的 expire 是多少）。
# Cookie 只在本机使用，不会打印出来；临时文件放在 mktemp 目录里，结束时删除。
#
# 用法：先按 README 在浏览器里复制好 Cookie，然后运行
#   zsh check-douyu-cookie.sh [斗鱼房间号]
# 房间号默认 6979222（玩机器）。他没开播时，换一个正在直播的房间号。
set -eu

room=${1:-6979222}
here=${0:A:h}
js=$here/../surge/live-redirect.js; [[ -f $js ]] || js=$here/../live-redirect.js
tmp=$(mktemp -d -t douyu-check)
trap 'rm -rf "$tmp"' EXIT INT TERM

if [[ -t 0 ]]; then raw=$(pbpaste); else raw=$(cat); fi   # 默认读剪贴板；也可以用管道传进来
cookie=$(print -r -- "$raw" | tr -d '\r\n' | sed -E 's/^[[:space:]]*[Cc]ookie:[[:space:]]*//; s/[;[:space:]]*$//')
unset raw
if [[ -z $cookie || $cookie != *=* ]]; then
  echo "剪贴板里不像是 Cookie（应该是 name=value; name2=value2 这样的一长串）"
  exit 1
fi

# 1. 字段检查：只列名字，不打印值
have=()
for kv in ${(s:;:)cookie}; do
  kv=${kv## }
  have+=(${kv%%=*})
done
need=(acf_auth acf_uid acf_stk acf_ltkid acf_username acf_biz acf_ct dy_did)
missing=()
for k in $need; do
  (( ${have[(Ie)$k]} )) || missing+=($k)
done
echo "Cookie 共 ${#have} 个字段"
if (( ${#missing} )); then
  echo "缺少关键字段：${missing[*]}"
else
  echo "关键字段齐全"
fi

# 2. 登录状态（斗鱼网页自己用的接口，error=0 表示已登录）
ua='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'
printf 'Cookie: %s\nReferer: https://www.douyu.com/\nUser-Agent: %s\n' "$cookie" "$ua" > "$tmp/h"
login=$(curl -s --compressed -m 10 -H @"$tmp/h" https://www.douyu.com/wgapi/livenc/liveweb/follow/top3 || true)
if [[ $login == *'"error":0'* ]]; then
  echo "登录状态：已登录"
else
  echo "登录状态：未登录或已过期  ${login:0:120}"
fi

# 3. 用 live-redirect.js 本身（模拟 Surge 环境）解析：游客一次、带 Cookie 两次
resolve() {
  print -rn -- "$1" > "$tmp/arg"
  SURGE_MOCK_DIR=$tmp SURGE_MOCK_ARG_FILE=$tmp/arg \
    osascript -l JavaScript "$here/surge-mock.js" "$js" "http://live.surge/douyu/$room" 2>&1 |
    grep '\[live-redirect\]' | sed -E 's/ -> .*//; s/^\[live-redirect\] /    /' || true
}
echo "游客解析："
resolve ""
echo "带 Cookie 解析（两次）："
resolve "douyu_cookie=$cookie"
sleep 2
resolve "douyu_cookie=$cookie"
echo
echo "怎么看："
echo "  - 「登录状态：已登录」才说明 Cookie 有效。游客也会随机拿到原画，所以单看 rate 不够。"
echo "  - 已登录，并且带 Cookie 两次都是 rate=0（原画），而且没有出现「第N次请求」，说明登录后原画是稳定给的。"
echo "  - expire 是地址的有效秒数。游客是 300，CDN 会在 5 分钟时断开。"
