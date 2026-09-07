#!/usr/bin/env bash
# scripts/wait-for-deploy.sh — дождаться, пока прод отдаёт СВОЮ сборку.
#
# Одно правило для всех замеров с раннера (ai-debug, scout-digest, prod-check):
# «тот ли код на проде» спрашивается у маркера деплоя /version.json, который
# scripts/write-version.js пишет в момент сборки образа (commit + built_at).
#
# Почему не /api/health build_time. 04.09 (#1582) штамп поставили через
# `env: { BUILD_TIME }` в next.config.js. Замер 05.09 (prod-check run 8):
# на проде `build_time: null` при uptime 464 с — в standalone-сборке значение
# до обработчика маршрута не доходит, и три ожидания подряд честно отсидели
# по 25 минут, ничего не дождавшись. Маркер version.json стоит с 23.08 и
# отдаётся всеми сборками — сверять надо с ним.
#
# Два исхода «доехало»:
#   1. commit маркера == наш sha (точное совпадение по 7 знакам);
#   2. built_at маркера >= времени нашего коммита — Timeweb собирает голову
#      main, и более новая сборка СОДЕРЖИТ наш коммит (см. deploy.yml, 16.08:
#      ждать ровно свой sha — значит 20 минут ждать то, что уже произошло).
# «Не дождались» говорится вслух и НЕ роняет прогон: замер на текущем коде
# тоже информативен, но обязан знать, что он на чужом коде.
#
# Переменные: BASE (https://vedarai.ru), WANT_SHA (sha коммита прогона),
# NEED_AFTER (ISO-время коммита; пусто при workflow_dispatch — тогда только
# исход 1), ATTEMPTS (50), SLEEP (30).
set -u
BASE="${BASE:-https://vedarai.ru}"
WANT_SHA="${WANT_SHA:-${GITHUB_SHA:-}}"
NEED_AFTER="${NEED_AFTER:-}"
ATTEMPTS="${ATTEMPTS:-50}"
SLEEP="${SLEEP:-30}"

iso2epoch() {
  python3 -c 'import sys,datetime
v=(sys.argv[1] or "").strip()
try: print(int(datetime.datetime.fromisoformat(v.replace("Z","+00:00")).timestamp()))
except Exception: print(0)' "$1"
}

NEED=$(iso2epoch "$NEED_AFTER")
echo "ждём прод на ${WANT_SHA:0:7} (или сборку новее $NEED_AFTER, epoch $NEED)"

for i in $(seq 1 "$ATTEMPTS"); do
  BODY=$(curl -s --max-time 20 "$BASE/version.json" || true)
  # commit built_at_epoch reason — одной строкой, чтобы не парсить JSON дважды.
  TRIPLE=$(printf '%s' "$BODY" | python3 -c 'import json,sys,datetime
try:
    d=json.load(sys.stdin)
    c=str(d.get("commit") or "unknown")
    b=d.get("built_at")
    ts=int(datetime.datetime.fromisoformat(str(b).replace("Z","+00:00")).timestamp()) if b else -1
    print(c, ts, str(d.get("reason") or "-"))
except Exception: print("no-marker", -1, "-")' 2>/dev/null || echo "no-marker -1 -")
  SERVED=${TRIPLE%% *}; REST=${TRIPLE#* }; BT=${REST%% *}; REASON=${REST#* }

  if [ -n "$WANT_SHA" ] && [ "${SERVED:0:7}" = "${WANT_SHA:0:7}" ]; then
    echo "прод на нашем коммите ${SERVED:0:7} (попытка $i)"; exit 0
  fi
  if [ "$BT" -gt 0 ] && [ "$NEED" -gt 0 ] && [ "$BT" -ge "$NEED" ]; then
    echo "прод на сборке новее нашего коммита: ${SERVED:0:7}, built_at $BT >= $NEED — содержит наш код (попытка $i)"; exit 0
  fi
  echo "ещё не доехало: прод отдаёт ${SERVED:0:7} (built_at $BT, reason $REASON), жду ${SLEEP}с ($i/$ATTEMPTS)"
  sleep "$SLEEP"
done
echo "ВНИМАНИЕ: своей сборки не дождались за $((ATTEMPTS * SLEEP / 60)) мин — прогон идёт на том коде, что есть (прод отдаёт ${SERVED:0:7})"
exit 0
