#!/usr/bin/env bash
# scripts/deepseek-balance.sh — остаток счёта DeepSeek по ключу раннера (26.11).
#
# 26.11 счёт DeepSeek кончился, и ревью безопасности краснело на каждом PR
# строкой «API Error: 402 Insufficient Balance» — после минуты установки и без
# слова о том, что делать. Этот скрипт спрашивает GET /user/balance до ревью
# (.github/workflows/security-review.yml) и по расписанию
# (.github/workflows/deepseek-balance.yml), чтобы пустой счёт был назван
# заранее и словами.
#
# Вход: DEEPSEEK_KEY в окружении. Ключ уходит только на api.deepseek.com и
# только через stdin curl (не в аргументах процесса), в лог не печатается.
#
# Выход — строки key=value в stdout (сообщения — в stderr):
#   state=ok|low|empty|unknown|no_key
#   threshold=<порог>   currency=<валюта счёта>
#   http=<код ответа>   (для unknown — почему не прочитано)
# Код выхода — всегда 0: что делать с исходом, решает вызывающий шаг.
#
# Самого остатка в выводе НЕТ: репозиторий публичный, лог Actions и issue
# видят все. Называется только сторона порога.
#
# Порог: 3 USD (20 CNY, если счёт в юанях). Одно ревью стоит ~$0,03 (книги,
# замер 12.11), но тот же ключ DEEPSEEK_API_KEY кормят и другие workflow
# раннера; 3 USD — запас на сутки-другие при проверке раз в 6 часов.
# Поменять — переменная репозитория DEEPSEEK_BALANCE_MIN_USD / _CNY.
set -uo pipefail

MIN_USD="${DEEPSEEK_BALANCE_MIN_USD:-3}"
MIN_CNY="${DEEPSEEK_BALANCE_MIN_CNY:-20}"

num() { [[ "$1" =~ ^-?[0-9]+([.][0-9]+)?$ ]]; }
num "$MIN_USD" || MIN_USD=3
num "$MIN_CNY" || MIN_CNY=20

if [ -z "${DEEPSEEK_KEY:-}" ]; then
  echo "state=no_key"
  echo "threshold=$MIN_USD"
  echo "currency=USD"
  exit 0
fi

BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT

# Ключ — заголовком из конфига на stdin: в `ps` и в трассировке шага его нет.
CODE=$(curl -sS -m 20 -o "$BODY" -w '%{http_code}' --config - https://api.deepseek.com/user/balance 2>/dev/null <<EOF
header = "Authorization: Bearer ${DEEPSEEK_KEY}"
header = "Accept: application/json"
EOF
) || CODE="${CODE:-000}"
[[ "$CODE" =~ ^[0-9]{3}$ ]] || CODE=000

if [ "$CODE" != "200" ]; then
  echo "state=unknown"
  echo "threshold=$MIN_USD"
  echo "currency=USD"
  echo "http=$CODE"
  exit 0
fi

# Числа у DeepSeek приходят строками («"total_balance": "110.00"»), см.
# parseDeepSeekBalance в lib/ai/balances.ts.
AVAIL=$(jq -r '.is_available | if type == "boolean" then tostring else "" end' "$BODY" 2>/dev/null) || AVAIL=""
CUR=$(jq -r '.balance_infos[0].currency // "USD" | tostring' "$BODY" 2>/dev/null) || CUR="USD"
AMOUNT=$(jq -r '.balance_infos[0].total_balance // "" | tostring' "$BODY" 2>/dev/null) || AMOUNT=""
[[ "$CUR" =~ ^[A-Z]{3}$ ]] || CUR=USD
MIN="$MIN_USD"
[ "$CUR" = "CNY" ] && MIN="$MIN_CNY"

STATE=unknown
if [ "$AVAIL" = "false" ]; then
  # is_available=false — сам DeepSeek говорит, что на вызовы денег нет.
  STATE=empty
elif num "$AMOUNT"; then
  if awk -v a="$AMOUNT" 'BEGIN { exit !(a + 0 <= 0) }'; then
    STATE=empty
  elif awk -v a="$AMOUNT" -v m="$MIN" 'BEGIN { exit !(a + 0 < m + 0) }'; then
    STATE=low
  else
    STATE=ok
  fi
fi

echo "state=$STATE"
echo "threshold=$MIN"
echo "currency=$CUR"
echo "http=$CODE"
