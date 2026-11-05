#!/usr/bin/env bash
# Порядок цепочки эволюции (05.11, слово владельца: «главное, чтоб не
# нарушался порядок — решатель не раньше других»).
#
# Цепочка держалась только на часах расписания: разведка 05:03/17:03 →
# эволюция 17:13/20:13/23:13 → ревью 19:11 → выпуск issues 19:31 → судья
# 10:20 (UTC). Планировщик GitHub доставляет её пачками с опозданием на
# часы, и 03.11 эволюция с решателем стартовала в 22:16:27 — за 4 секунды
# до конца разведки (22:16:31): решатель работал на вчерашней сводке.
#
# Этот шаг стоит первым у каждого звена и ждёт, пока у названных
# предшественников нет идущих или ждущих в очереди прогонов. Три исхода:
#   0 — предшественники не идут, звено запускается;
#   1 — они всё ещё идут через WAIT_LIMIT_SEC — звено НЕ запускается раньше них;
#   1 — прогоны не прочитались — порядок не проверен, звено не запускается
#       (не смог проверить ≠ «можно», §4.0).
#
# Использование: wait-for-predecessors.sh cron-scout-digest.yml [ещё.yml …]
# Нужны GITHUB_TOKEN (права actions: read) и GITHUB_REPOSITORY.
# Сторож: tests/unit/wait-for-predecessors.test.ts.
set -uo pipefail

: "${GITHUB_TOKEN:?нужен GITHUB_TOKEN с правом actions: read}"
: "${GITHUB_REPOSITORY:?нужен GITHUB_REPOSITORY}"
API="${GITHUB_API_URL:-https://api.github.com}"
LIMIT_SEC="${WAIT_LIMIT_SEC:-900}"
STEP_SEC="${WAIT_STEP_SEC:-30}"

if [ "$#" -eq 0 ]; then
  echo "::error::не названы предшественники — нечего ждать, а значит и порядок не проверен"
  exit 1
fi

deadline=$(( $(date +%s) + LIMIT_SEC ))

# Число идущих и ждущих прогонов workflow; -1 — не прочитали.
busy_of() {
  local total=0 n st body
  for st in queued in_progress waiting requested pending; do
    body=$(curl -fsS --max-time 20 \
      -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      "$API/repos/$GITHUB_REPOSITORY/actions/workflows/$1/runs?status=$st&per_page=1") || { echo -1; return; }
    n=$(printf '%s' "$body" | jq -r '.total_count // empty' 2>/dev/null)
    case "$n" in ''|*[!0-9]*) echo -1; return ;; esac
    total=$((total + n))
  done
  echo "$total"
}

while :; do
  waiting=""
  for wf in "$@"; do
    n=$(busy_of "$wf")
    if [ "$n" = "-1" ]; then
      echo "::error::не смог прочитать прогоны $wf — порядок не проверен, звено не запускается раньше предшественников"
      exit 1
    fi
    if [ "$n" -gt 0 ]; then waiting="$waiting $wf($n)"; fi
  done
  if [ -z "$waiting" ]; then
    echo "Предшественники не идут: $* — запускаюсь"
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::предшественники всё ещё идут через $((LIMIT_SEC / 60)) мин:$waiting — звено не запускается раньше них"
    exit 1
  fi
  echo "Жду предшественников:$waiting"
  sleep "$STEP_SEC"
done
