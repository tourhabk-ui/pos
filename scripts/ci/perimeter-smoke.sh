#!/usr/bin/env bash
# Периметр с улицы: критерий «периметр закрыт» из аудита 01.09, исполняемый.
#
# Зачем скрипт, а не шаг в workflow: контейнер разработчика не достаёт до
# vedarai.ru (прокси отдаёт 403 на CONNECT), а раннер GitHub достаёт. Значит
# единственное место, где проверка исполняется по-настоящему, — раннер; а
# единственное место, где её ЛОГИКА проверяется в CI без прода, — этот файл с
# подменённым curl (tests/unit/perimeter-smoke.test.ts).
#
# Три исхода (§4.0), и коды возврата их различают:
#   0 — все строки таблицы сошлись;
#   1 — хотя бы одна строка разошлась (периметр открыт там, где обещан закрытым,
#       или закрыт там, где обещан открытым);
#   2 — хотя бы одну строку НЕ СМОГЛИ проверить (curl не дозвонился, код 000).
#       Это не «хорошо» и не «плохо», и зелёным такое красить нельзя.
#
# Переменные: BASE_URL (по умолчанию https://vedarai.ru), CURL (подмена в тестах).
set -u

BASE_URL="${BASE_URL:-https://vedarai.ru}"
CURL="${CURL:-curl}"

code() {
  # Печатает HTTP-код. При сетевом отказе curl и сам печатает 000, и выходит
  # ненулём — берём одно, не оба: иначе получится «000000», и недозвон
  # прочитается как расхождение, а не как «не смогли проверить».
  local out
  out=$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time 30 "$@" 2>/dev/null) || out='000'
  [ -n "$out" ] || out='000'
  printf '%s' "$out"
}

mismatch=0
unknown=0

# row <имя> <ожидание> <получено>
# ожидание: список кодов через | либо !код (что угодно, кроме этого кода).
row() {
  local name="$1" expect="$2" got="$3" verdict
  if [ "$got" = "000" ]; then
    verdict="НЕ СМОГЛИ ПРОВЕРИТЬ"
    unknown=$((unknown + 1))
  elif [ "${expect#!}" != "$expect" ]; then
    if [ "$got" = "${expect#!}" ]; then verdict="РАСХОЖДЕНИЕ"; mismatch=$((mismatch + 1)); else verdict="ок"; fi
  else
    case "|$expect|" in
      *"|$got|"*) verdict="ок" ;;
      *) verdict="РАСХОЖДЕНИЕ"; mismatch=$((mismatch + 1)) ;;
    esac
  fi
  printf '%-46s ожидание %-10s получено %s  %s\n' "$name" "$expect" "$got" "$verdict"
}

echo "Периметр с улицы: $BASE_URL"
echo

# Закрытое: без cookie и без заголовка секрета.
row "GET  /api/admin/health/kuzmich-grounding" "401|403" \
  "$(code "$BASE_URL/api/admin/health/kuzmich-grounding")"
row "POST /api/admin/operators/create" "401|403" \
  "$(code -X POST "$BASE_URL/api/admin/operators/create")"
row "GET  /api/ai/debug-waterfall" "401|404" \
  "$(code "$BASE_URL/api/ai/debug-waterfall")"
row "GET  /api/ai/debug-waterfall?check=env" "401|404" \
  "$(code "$BASE_URL/api/ai/debug-waterfall?check=env")"
row "GET  /api/cron/watchdog (без секрета)" "401|403" \
  "$(code "$BASE_URL/api/cron/watchdog")"

# Открытое по замыслу: Edge не должен отвечать 401. Тело пустое, поэтому
# хендлер вправе ответить 400 — это и есть «дошли до хендлера».
row "POST /api/safety/sos (пустое тело)" "!401" \
  "$(code -X POST -H 'Content-Type: application/json' -d '{}' "$BASE_URL/api/safety/sos")"
row "POST /api/push/subscribe (пустое тело)" "!401" \
  "$(code -X POST -H 'Content-Type: application/json' -d '{}' "$BASE_URL/api/push/subscribe")"
row "POST /api/mcp tools/list" "200" \
  "$(code -X POST -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$BASE_URL/api/mcp")"

echo
if [ "$unknown" -gt 0 ]; then
  echo "ИТОГ: не смогли проверить строк: $unknown (расхождений среди проверенных: $mismatch). Зелёным не считать."
  exit 2
fi
if [ "$mismatch" -gt 0 ]; then
  echo "ИТОГ: периметр расходится с обещанным в $mismatch строк(ах)."
  exit 1
fi
echo "ИТОГ: периметр с улицы соответствует обещанному."
exit 0
