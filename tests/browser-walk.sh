#!/usr/bin/env bash
# 輔凰貿易系統 — 真實瀏覽器走查（agent-browser）
#
# 為什麼要跑：API 測試與 Node vm 模擬 DOM 都證明不了前端可用。
#   本系統首次走查即抓到 3 個 API 測試全綠卻完全不能用的 bug：
#     1. ui.date 名稱衝突 → 無限遞迴（RangeError）→ 應收帳款整頁打不開
#     2. onOpen 內 rateEl 在 renderItems 之後才宣告 → TDZ → 新增訂單 Modal 開不出來
#     3. 選客戶帶出 USD 幣別時未同步帶匯率 → 利潤用 rate=1 算錯
#
# 用法：bash tests/browser-walk.sh [工號] [密碼] [port]
# 注意：每次都要重新登入（agent-browser 的 session 不保留 localStorage）

AB="C:/Users/Jack/.workbuddy/binaries/node/versions/22.22.2-2/agent-browser"
USER="${1:-ADMIN}"
PASS="${2:-${APP_TEST_ADMIN_PASSWORD:-}}"
if [ -z "$PASS" ]; then
  echo "請透過 APP_TEST_ADMIN_PASSWORD 提供測試帳號密碼，或以第二個參數傳入。" >&2
  exit 2
fi
PORT="${3:-5200}"
SCRIPT="$(cd "$(dirname "$0")" && pwd)/browser-walk.js"

( $AB open "http://127.0.0.1:${PORT}/?v=$(date +%s)" >/dev/null 2>&1 )   # subshell 避免冷啟動 SIGTERM
$AB wait --load load   >/dev/null 2>&1
$AB set viewport 1680 1300 >/dev/null 2>&1   # 關鍵：視窗太小會「點擊靜默失效」
sleep 1
$AB fill "#login-user" "$USER" >/dev/null 2>&1
$AB fill "#login-pass" "$PASS" >/dev/null 2>&1
$AB eval "document.getElementById('login-btn').click()" >/dev/null 2>&1
sleep 3
# eval 長腳本必須用 base64，否則含引號的表達式會回空字串
$AB eval -b "$(base64 -w0 "$SCRIPT")"
