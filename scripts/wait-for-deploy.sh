#!/usr/bin/env bash
# scripts/wait-for-deploy.sh — дождаться, пока прод отдаёт СВОЮ сборку.
#
# Одно правило для всех замеров с раннера (ai-debug, scout-digest, prod-check
# и ещё три десятка workflow): «тот ли код на проде».
#
# ── Точный исход: запись выката (15.10, выкат только проверенного sha) ─────
#
# С 15.10 прод получает только коммит, прошедший CI: deploy.yml по зелёному
# CI на main заказывает у Timeweb сборку ровно этого sha, сверяет, что сайт
# его отдаёт, и ТОЛЬКО ПОСЛЕ сверки пишет GitHub Deployment в окружение
# vedarai.ru (шаг «Запись выката»). Запись значит «этот sha на проде» — не
# намерение, а сверенный факт; сверка не подтвердила — записи нет.
#
# Отсюда первый исход, точный. Берётся последняя запись выката D и
# сравнивается с нашим коммитом (GET compare/D...WANT_SHA):
#   behind / identical — наш коммит предок выкаченного или он сам: в проде;
#   ahead — D предок нашего. Если ВСЕ файлы между ними лежат вне образа
#     (.github/ и tests/ — ни сборка, ни рантайм их не читают: tsconfig
#     исключает tests, импортов из .github и tests в app/, lib/, components/,
#     start.js и scripts/migrate-standalone.js нет — сверено grep'ом 15.10),
#     прод уже несёт тот же код: в проде. Иначе — ждём следующую запись.
#     Переименование проверяется по обоим именам: файл, уехавший из app/
#     в .github/, образ меняет;
#   diverged — наш коммит не в линии выкаченного: ждём и говорим.
# Список файлов сравнения GitHub режет на 300; усечённый список «всё вне
# образа» не доказывает — это ожидание, а не успех.
#
# Почему не время сборки. Без автодеплоя путь коммита до прода — очередь CI
# и сам CI (медиана 15 мин, худший 36) плюс сборка Timeweb (12–26). Образ
# ПРЕДЫДУЩЕГО коммита, заказанный после ЕГО CI, получает built_at позже
# пуша нашего на те же 15–60 минут, и по времени от нашего не отличим ничем —
# та же болезнь #1762, только хуже. Запись выката называет коммит, а не время.
#
# Запросы к GitHub — с токеном (GH_TOKEN или GITHUB_TOKEN; шагу его даёт
# workflow, `deployments: read` в его permissions) и не чаще раза в GH_EVERY
# (60 с); сравнение — только когда сменился D или прошлое не удалось. Без
# токена GitHub не опрашивается вовсе: анонимно лимит 60 запросов в час на
# IP, а IP у раннеров общий — опрос раз в 30 с съел бы его за полчаса.
# Отказ HTTP или битый JSON — «не смог прочитать», а не «доехало» (§4.0).
#
# ── Запасной путь: маркер /version.json (с 23.08) ──────────────────────────
#
# Когда запись прочитать не смогли (нет токена, отказ API, записей ещё нет —
# так бывает до первого выката по новой схеме), это сказано в логе словами
# «…запись выката… — ждём по built_at», и судит маркер деплоя, который
# scripts/write-version.js пишет в момент сборки образа (commit + built_at).
#
# Почему не /api/health build_time. 04.09 (#1582) штамп поставили через
# `env: { BUILD_TIME }` в next.config.js. Замер 05.09 (prod-check run 8):
# на проде `build_time: null` при свежем контейнере — в standalone-сборке
# значение до обработчика маршрута не доходит, и три ожидания подряд честно
# отсидели по 25 минут, ничего не дождавшись. Маркер version.json стоит с
# 23.08 и отдаётся всеми сборками.
#
# Два исхода запасного пути:
#   1. commit маркера == наш sha (точное совпадение по 7 знакам) — он
#      проверяется на каждой попытке и при читаемой записи: точный ответ
#      сайта не хуже записи;
#   2. built_at маркера >= времени нашего коммита + MIN_BUILD_SECONDS —
#      образ собран так поздно, что заведомо новее нашего коммита.
#
# Запас в исходе 2 — не украшение (#1762, 10.09). Образ ПРЕДЫДУЩЕГО коммита,
# собранный после нашего пуша, тоже имеет built_at > времени пуша — и без
# запаса он проходит за свежий. Так дважды за час (safety-ledger-check run 8,
# prod-check run 46) старый контейнер сошёл за новый: мерж 00:02:34, built_at
# 00:06:44. Пока маркер на проде отдаёт `commit: unknown` (reason
# no_git_head), исход 1 недостижим.
#
# 600 с (десять минут) стояли, пока сборку запускал вебхук на каждый пуш.
# 15.10 автодеплой выключен, и предыдущий коммит строится после ЕГО CI:
# худший CI 36 мин + худшая сборка 26 = 62, плюс работа шага выката.
# Отсюда 3900 с (65 мин): меньше — и образ предыдущего коммита снова сходит
# за наш. Цена известна и принята: запасной путь почти всегда кончается «не
# дождались» — он запасной, и мягче, чем был, ему быть нельзя. То же число
# держит deploy.yml (сторож wait-for-deploy-strict).
#
# ── Окно ────────────────────────────────────────────────────────────────────
#
# 140 x 30 с = 70 минут. Запись выката появляется после CI (худший 36),
# заказа и сборки (худшая 26) и сверки сайта: 62 с лишним. Прежние 35 минут
# «едущий» вместе с эндпоинтом коммит не укладывали по построению — 14
# workflow с REQUIRE_FRESH=1 краснели бы, не дождавшись.
#
# «Не дождались» говорится вслух и НЕ роняет прогон: замер на текущем коде
# тоже информативен, но обязан знать, что он на чужом коде. Исход называет
# последнюю запись выката, которую видел.
#
# Переменные: BASE (https://vedarai.ru), WANT_SHA (sha коммита прогона),
# NEED_AFTER (ISO-время коммита; пусто при workflow_dispatch — тогда в
# запасном пути только исход 1), MIN_BUILD_SECONDS (3900), ATTEMPTS (140),
# SLEEP (30), GH_EVERY (60), DEPLOY_ENVIRONMENT (vedarai.ru — то же имя пишет
# deploy.yml), GH_TOKEN/GITHUB_TOKEN, GITHUB_REPOSITORY, CODE_PATHS и
# CODE_STABLE_MINUTES (60) — см. ниже «код эндпоинта давно не менялся».
set -u
BASE="${BASE:-https://vedarai.ru}"
WANT_SHA="${WANT_SHA:-${GITHUB_SHA:-}}"
NEED_AFTER="${NEED_AFTER:-}"
# 140 x 30 c = 70 минут — см. шапку «Окно».
ATTEMPTS="${ATTEMPTS:-140}"
SLEEP="${SLEEP:-30}"
# Запас запасного пути — см. шапку: без него (и с прежними 600 при
# выключенном автодеплое) образ предыдущего коммита сходит за свежий.
MIN_BUILD_SECONDS="${MIN_BUILD_SECONDS:-3900}"
DEPLOY_ENVIRONMENT="${DEPLOY_ENVIRONMENT:-vedarai.ru}"
GH_EVERY="${GH_EVERY:-60}"
GH_API="${GITHUB_API_URL:-https://api.github.com}"
GH_REPO="${GITHUB_REPOSITORY:-}"
GH_AUTH="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
# Пути вне образа: ни сборка, ни рантайм их не читают (см. шапку).
OUTSIDE_IMAGE=".github/ tests/"

iso2epoch() {
  python3 -c 'import sys,datetime
v=(sys.argv[1] or "").strip()
try: print(int(datetime.datetime.fromisoformat(v.replace("Z","+00:00")).timestamp()))
except Exception: print(0)' "$1"
}

# ── Код эндпоинта давно не менялся — ждать нечего (03.10) ─────────────────
# Маркер сборки сейчас не отличает свою сборку от чужой: commit «unknown»,
# built_at то на 25 с позже пуша, то на 20 минут раньше. Ожидание по нему
# 03.10 трижды отсидело весь срок (place-coords run 20, сверка с OSM run 8),
# хотя пушился только маркер, а код эндпоинта на проде был тот же.
#
# CODE_PATHS — файлы, от которых зависит ответ прода этому прогону. Если ни
# один коммит за CODE_STABLE_MINUTES (60, заметно дольше самой долгой
# сборки — 26 мин) их не трогал, прод уже несёт этот код. Смотрится окно, а
# не один коммит: правка роута за две минуты до маркера окном ловится, а
# одним последним коммитом — нет. Истории не хватает, чтобы покрыть окно, —
# ждём по-старому.
if [ -n "${CODE_PATHS:-}" ]; then
  WINDOW_MIN="${CODE_STABLE_MINUTES:-60}"
  OLDEST=$(git log --format=%ct --reverse 2>/dev/null | head -1)
  SINCE=$(( $(date +%s) - WINDOW_MIN * 60 ))
  if [ -n "$OLDEST" ] && [ "$OLDEST" -lt "$SINCE" ]; then
    # shellcheck disable=SC2086
    TOUCHED=$(git log --since="@$SINCE" --format='%h %s' -- $CODE_PATHS 2>/dev/null)
    if [ -z "$TOUCHED" ]; then
      echo "код эндпоинта ($CODE_PATHS) не менялся ${WINDOW_MIN} мин — прод уже несёт его, ждать нечего"
      exit 0
    fi
    echo "код эндпоинта менялся за ${WINDOW_MIN} мин — ждём сборку:"
    echo "$TOUCHED"
  else
    echo "история короче окна ${WINDOW_MIN} мин — не могу сказать, менялся ли код; ждём по-старому"
  fi
fi

TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT

# ── Запись выката ───────────────────────────────────────────────────────────
#
# REC — что известно о записи сейчас: ok (прочитана), none (записей нет ни
# одной), fail (не смог прочитать), off (читать нечем — к GitHub не ходим).
REC=off; REC_WHY=""
D_SHA=""; D_ID=""; VERDICT=""; VERDICT_TXT=""; CMP_D=""
LAST_GH=0
if [ -z "$GH_AUTH" ]; then
  REC_WHY="в env шага нет GH_TOKEN/GITHUB_TOKEN, а без токена GitHub не опрашиваем: анонимно 60 запросов в час на общий IP раннера"
elif [ -z "$GH_REPO" ]; then
  REC_WHY="не задан GITHUB_REPOSITORY"
elif [ -z "$WANT_SHA" ]; then
  REC_WHY="не задан WANT_SHA — сравнивать запись не с чем"
else
  REC=""
fi

# Печатает HTTP-код; тело — в файл $2. Отказ сети — «000», не пустота.
gh_get() {
  local code
  code=$(curl -sS --max-time 20 -o "$2" -w '%{http_code}' \
    -H "Authorization: Bearer $GH_AUTH" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "$GH_API/$1" 2>"$TMPD/curl.err") || code="000"
  printf '%s' "${code:-000}"
}

# Сравнение D с нашим коммитом -> VERDICT in|wait и VERDICT_TXT словами.
# Не смогли — REC=fail: этой попыткой судит запасной путь, а следующий опрос
# сравнит заново, даже если D тот же.
compare_record() {
  local code line st kind list
  code=$(gh_get "repos/$GH_REPO/compare/$D_SHA...$WANT_SHA" "$TMPD/cmp.json")
  if [ "$code" != "200" ]; then
    REC=fail; REC_WHY="сравнение ${D_SHA:0:7}...${WANT_SHA:0:7}: HTTP $code $(tr '\n' ' ' < "$TMPD/curl.err" 2>/dev/null | head -c 160)"
    CMP_D=""; return
  fi
  line=$(python3 -c '
import json, sys
outside = tuple(sys.argv[2].split())
try:
    c = json.load(open(sys.argv[1]))
    st = str(c["status"])
except Exception:
    print("bad"); sys.exit()
if st in ("behind", "identical", "diverged"):
    print(st); sys.exit()
if st != "ahead":
    print("bad"); sys.exit()
files = c.get("files")
if not isinstance(files, list):
    print("ahead\tnofiles\t-"); sys.exit()
if len(files) >= 300:
    print("ahead\ttruncated\t%d" % len(files)); sys.exit()
paths = []
for f in files:
    names = [f.get(k) for k in ("filename", "previous_filename")] if isinstance(f, dict) else []
    names = [str(n) for n in names if n]
    paths.extend(names if names else ["(файл без имени)"])
inside = [p for p in paths if not p.startswith(outside)]
show = lambda xs: ", ".join(xs[:5]) + (" и ещё %d" % (len(xs) - 5) if len(xs) > 5 else "")
if inside:
    print("ahead\timage\t" + show(inside))
else:
    uniq = sorted(set(paths))
    print("ahead\toutside\t" + (show(uniq) if uniq else "изменённых файлов нет"))
' "$TMPD/cmp.json" "$OUTSIDE_IMAGE" 2>/dev/null || echo bad)
  st=$(printf '%s' "$line" | cut -f1)
  kind=$(printf '%s' "$line" | cut -f2)
  list=$(printf '%s' "$line" | cut -f3-)
  CMP_D="$D_SHA"
  case "$st" in
    behind|identical)
      VERDICT=in
      VERDICT_TXT="наш коммит ${WANT_SHA:0:7} в проде: последняя запись выката — ${D_SHA:0:7} (#$D_ID), сравнение: $st" ;;
    diverged)
      VERDICT=wait
      VERDICT_TXT="выкачен ${D_SHA:0:7} (#$D_ID), наш коммит не в его линии (diverged) — ждём запись, которая его содержит" ;;
    ahead)
      case "$kind" in
        outside)
          VERDICT=in
          VERDICT_TXT="между выкаченным ${D_SHA:0:7} (#$D_ID) и нашим коммитом только файлы вне образа: $list — прод уже несёт тот же код" ;;
        image)
          VERDICT=wait
          VERDICT_TXT="выкачен ${D_SHA:0:7} (#$D_ID); между ним и нашим коммитом есть файлы образа: $list" ;;
        truncated)
          VERDICT=wait
          VERDICT_TXT="выкачен ${D_SHA:0:7} (#$D_ID); сравнение с нашим коммитом усечено ($list файлов) — «всё вне образа» не доказать" ;;
        *)
          VERDICT=wait
          VERDICT_TXT="выкачен ${D_SHA:0:7} (#$D_ID); сравнение с нашим коммитом не назвало файлов — «всё вне образа» не доказать" ;;
      esac ;;
    *)
      REC=fail; REC_WHY="сравнение ${D_SHA:0:7}...${WANT_SHA:0:7}: ответ не разобран"
      CMP_D="" ;;
  esac
}

poll_record() {
  local code line
  LAST_GH=$(date +%s)
  code=$(gh_get "repos/$GH_REPO/deployments?environment=$DEPLOY_ENVIRONMENT&per_page=5" "$TMPD/dep.json")
  if [ "$code" != "200" ]; then
    REC=fail; REC_WHY="список записей: HTTP $code $(tr '\n' ' ' < "$TMPD/curl.err" 2>/dev/null | head -c 160)"
    return
  fi
  # Самая свежая запись — наибольший id: порядок выдачи не обещан.
  line=$(python3 -c '
import json, re, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print("bad"); sys.exit()
if not isinstance(d, list):
    print("bad"); sys.exit()
if not d:
    print("none"); sys.exit()
rows = [x for x in d if isinstance(x, dict) and isinstance(x.get("id"), int)
        and re.fullmatch(r"[0-9a-f]{40}", str(x.get("sha") or ""))]
if not rows:
    print("bad"); sys.exit()
top = max(rows, key=lambda x: x["id"])
print("ok", top["sha"], top["id"])
' "$TMPD/dep.json" 2>/dev/null || echo bad)
  case "$line" in
    ok\ *)
      # shellcheck disable=SC2086
      set -- $line
      REC=ok
      if [ "$2" != "$CMP_D" ]; then
        D_SHA="$2"; D_ID="$3"
        compare_record
      fi ;;
    none)
      REC=none; REC_WHY="записи выката в окружении $DEPLOY_ENVIRONMENT нет ни одной" ;;
    *)
      REC=fail; REC_WHY="список записей: ответ не разобран" ;;
  esac
}

NEED=$(iso2epoch "$NEED_AFTER")
if [ "$REC" = off ]; then
  echo "запись выката читать нечем ($REC_WHY) — ждём по built_at"
fi
echo "ждём прод на ${WANT_SHA:0:7}: по записи выката $DEPLOY_ENVIRONMENT, запасной путь — сборка не раньше чем через ${MIN_BUILD_SECONDS}с после $NEED_AFTER (epoch $NEED)"

SERVED="-"
for i in $(seq 1 "$ATTEMPTS"); do
  if [ "$REC" != off ]; then
    NOW=$(date +%s)
    if [ "$LAST_GH" -eq 0 ] || [ $((NOW - LAST_GH)) -ge "$GH_EVERY" ]; then
      poll_record
      case "$REC" in
        fail) echo "не смог прочитать запись выката ($REC_WHY) — ждём по built_at" ;;
        none) echo "$REC_WHY — ждём по built_at" ;;
      esac
    fi
  fi
  if [ "$REC" = ok ] && [ "$VERDICT" = in ]; then
    echo "$VERDICT_TXT (попытка $i)"; exit 0
  fi

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

  # Разница «сборка минус пуш» печатается всегда: читающий видит, тот ли
  # образ, без арифметики в голове (#1762, пункт 3). Отрицательная — образ
  # старше пуша; малая положительная — скорее всего, образ предыдущего коммита.
  if [ "$BT" -gt 0 ] && [ "$NEED" -gt 0 ]; then
    AHEAD=$((BT - NEED)); AHEAD_TXT="built_at минус пуш = ${AHEAD}с"
  else
    AHEAD=""; AHEAD_TXT="built_at $BT, время пуша не задано"
  fi

  if [ -n "$WANT_SHA" ] && [ "${SERVED:0:7}" = "${WANT_SHA:0:7}" ]; then
    echo "прод на нашем коммите ${SERVED:0:7} ($AHEAD_TXT, попытка $i)"; exit 0
  fi
  # Запись прочитана — судит она; время сборки при ней не спрашивается: оно
  # и есть то, что запись заменила (см. шапку).
  if [ "$REC" = ok ]; then
    echo "ещё не доехало по записи выката: $VERDICT_TXT; жду ${SLEEP}с ($i/$ATTEMPTS)"
    sleep "$SLEEP"
    continue
  fi
  if [ -n "$AHEAD" ] && [ "$AHEAD" -ge "$MIN_BUILD_SECONDS" ]; then
    echo "прод на сборке новее нашего коммита: ${SERVED:0:7}, $AHEAD_TXT >= запаса ${MIN_BUILD_SECONDS}с — содержит наш код (запасной путь, попытка $i)"; exit 0
  fi
  echo "ещё не доехало: прод отдаёт ${SERVED:0:7} ($AHEAD_TXT, reason $REASON), жду ${SLEEP}с ($i/$ATTEMPTS)"
  sleep "$SLEEP"
done

case "$REC" in
  ok)   SEEN="последняя запись выката: $VERDICT_TXT" ;;
  none) SEEN="$REC_WHY" ;;
  fail) SEEN="запись выката не прочитана: $REC_WHY" ;;
  *)    SEEN="запись выката не читалась: $REC_WHY" ;;
esac
# ── Не дождались: два разных случая ────────────────────────────────────────
#
# Замер ПО ЖИВУЩЕМУ эндпоинту на чужой сборке всё ещё полезен: он меряет прод
# как он есть, лишь бы знал об этом. Такой прогон продолжается.
#
# Но если эндпоинт едет ТЕМ ЖЕ коммитом, «не дождались» означает не «померим
# старое», а «спросим то, чего на проде нет». Ответ будет 404, и он ничего не
# скажет о предмете замера.
#
# Замер 07.09 показал цену этой разницы: две пробы (разбор справочника и
# retrieval Кузьмича) ждали по 28 минут, сдались, отчитались УСПЕХОМ и
# получили 404 — прогон красный, работа не сделана, вызов модели потрачен, а
# причина в логе выглядела как отказ эндпоинта, а не как незаехавшая сборка.
#
# Кто едет вместе со своим эндпоинтом, ставит REQUIRE_FRESH=1 и краснеет
# честно — на своей причине, а не на чужой.
if [ "${REQUIRE_FRESH:-0}" = "1" ]; then
  echo "::error::Своей сборки не дождались за $((ATTEMPTS * SLEEP / 60)) мин (прод отдаёт ${SERVED:0:7}; $SEEN). Эндпоинт этого прогона едет тем же коммитом, значит спрашивать нечего: это «не смогли спросить», а не отказ прода. Смотреть прогон «Deploy to Timeweb Cloud» по этому коммиту: CI красный — выката нет; сборка не подтвердилась — записи нет."
  exit 1
fi
echo "ВНИМАНИЕ: своей сборки не дождались за $((ATTEMPTS * SLEEP / 60)) мин — прогон идёт на том коде, что есть (прод отдаёт ${SERVED:0:7}; $SEEN)"
exit 0
