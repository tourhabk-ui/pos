#!/usr/bin/env bash
# Показать открытые issues в начале сессии — и сказать, какие из них уже заняты.
#
# 19.08 находка «SQL-инъекция через интерполяцию» (#1293) провисела четыре
# часа и была замечена только по вопросу владельца. Механизма, который бы её
# показал, не существовало: issue-reporter выносит находки в GitHub и на этом
# останавливается, а «Claude возьмёт их оттуда» держалось на том, вспомнил я
# или нет.
#
# Память — не механизм. Хук показывает очередь сам, без напоминаний.
#
# ── Занятость (15.09) ──────────────────────────────────────────────────────
#
# 14.09 владелец держал в этом репозитории четыре параллельные сессии, и две
# находки — #1883 и #1889 — были сделаны ДВАЖДЫ, разными сессиями, в один
# день. Работа целого вечера ушла в мусор: у #1883 обе версии дошли до
# готовых PR, вмёржена одна.
#
# Причина не в невнимательности исполнителя, а в раздаче: этот хук выдавал
# всем четверым ОДИН И ТОТ ЖЕ список со словами «разобрать до новой работы».
# Занятые находки выглядели в нём точно так же, как свободные — никакой
# разницы между «никто не взял» и «по ней уже идёт чужой PR» очередь не
# знала. Правило 08.09 «сначала занять, потом чинить» при этом существовало,
# но держалось на том, что исполнитель вспомнит сходить в PR руками.
#
# Теперь очередь сверяется с открытыми PR и помечает занятое.
#
# Помечает, а НЕ прячет — намеренно. Спрятанная находка неотличима от
# несуществующей, а PR может быть брошен, закрыт без мержа или касаться
# issue лишь краем. Решение «всё равно берусь» остаётся за человеком, но
# принимается оно теперь зряче.
#
# ── Чего хук НЕ умеет ──────────────────────────────────────────────────────
#
# Делить сессии ПО ОБЛАСТЯМ (карта / бронь / Кузьмич / экраны) он не может, и
# притворяться не будет. На старте о сессии известны только случайный
# CLAUDE_CODE_SESSION_ID и имя ветки, которое придумывает не человек;
# выводить область из слов в имени ветки — угадывание, а угаданная граница
# хуже отсутствующей: на неё положатся. Область называет владелец первым
# сообщением сессии.
#
# ── Тишина запрещена ───────────────────────────────────────────────────────
#
# Если очередь прочитать не удалось — хук говорит об этом вслух.
# Непрочитанная очередь и пустая очередь — разные вещи. Точно так же и с
# занятостью: не смогли прочитать PR — так и сказано, а не «все свободны».
set -uo pipefail

REPO="${GITHUB_REPOSITORY:-tourhabk-ui/pos}"
TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"

emit() {
  # Экранирование через python: тела issue содержат кавычки и переводы строк.
  python3 -c '
import json, sys
print(json.dumps({
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": sys.stdin.read(),
  }
}))' <<< "$1"
}

if [ -z "$TOKEN" ]; then
  emit "ОЧЕРЕДЬ ISSUES НЕ ПРОЧИТАНА: нет GITHUB_TOKEN. Это не «issues нет» — это «проверка не выполнилась»."
  exit 0
fi

BODY=$(curl -sS --max-time 15 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO/issues?state=open&per_page=30" 2>/dev/null) || {
  emit "ОЧЕРЕДЬ ISSUES НЕ ПРОЧИТАНА: GitHub API недоступен. Это не «issues нет»."
  exit 0
}

# Открытые PR — вторым запросом. Отказ здесь НЕ роняет очередь: список
# находок ценен и без отметок занятости, но о непроверенности будет сказано.
PULLS=$(curl -sS --max-time 15 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO/pulls?state=open&per_page=50" 2>/dev/null) || PULLS=""

# Оба ответа уходят в python ФАЙЛАМИ, не переменными окружения и не argv.
# Первая редакция этой правки передавала их через env — и хук умер с
# «Argument list too long»: тела тридцати issue и полусотни PR не влезают в
# лимит окружения. Заметно это было не по ошибке, а по тому, что очередь
# пришла ПУСТОЙ — то есть поломка притворилась «issues нет», ровно тем, что
# доктрина этого файла запрещает.
TMPDIR_Q=$(mktemp -d) || {
  emit "ОЧЕРЕДЬ ISSUES НЕ ПРОЧИТАНА: нет места под временные файлы."
  exit 0
}
trap 'rm -rf "$TMPDIR_Q"' EXIT
printf '%s' "$BODY"  > "$TMPDIR_Q/issues.json"
printf '%s' "$PULLS" > "$TMPDIR_Q/pulls.json"

OUT=$(python3 - "$TMPDIR_Q/issues.json" "$TMPDIR_Q/pulls.json" <<'PYQUEUE'
import json, sys, re, datetime

def _read(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except Exception:
        return ""

try:
    rows = json.loads(_read(sys.argv[1]))
except Exception:
    print("ОЧЕРЕДЬ ISSUES НЕ ПРОЧИТАНА: ответ GitHub не разобрался.")
    sys.exit(0)
if not isinstance(rows, list):
    print("ОЧЕРЕДЬ ISSUES НЕ ПРОЧИТАНА: GitHub ответил не списком.")
    sys.exit(0)

# Pull requests приходят той же ручкой — они не issues.
items = [r for r in rows if "pull_request" not in r]

# Какие находки уже заняты: открытый PR, ссылающийся на номер в заголовке
# или теле. Это не догадка о намерении, а след чужой работы.
#
# taken: номер issue -> список номеров PR. Значение None означает ТРЕТИЙ
# исход: занятость проверить не удалось (§4.0). Он не равен «свободно».
taken = {}
pulls_ok = False
raw = _read(sys.argv[2])
if raw.strip():
    try:
        pulls = json.loads(raw)
    except Exception:
        pulls = None
    if isinstance(pulls, list):
        pulls_ok = True
        for p in pulls:
            text = "%s\n%s" % (p.get("title") or "", p.get("body") or "")
            for num in set(re.findall(r"#(\d{1,6})", text)):
                # Сам себя PR не занимает.
                if int(num) == p.get("number"):
                    continue
                taken.setdefault(int(num), []).append(p.get("number"))

if not items:
    print("Открытых issues нет.")
    if not pulls_ok:
        print("ЗАНЯТОСТЬ НЕ ПРОВЕРЕНА: список открытых PR не прочитан.")
    sys.exit(0)

now = datetime.datetime.now(datetime.timezone.utc)
free = [r for r in items if int(r["number"]) not in taken]
busy = [r for r in items if int(r["number"]) in taken]

lines = ["ОТКРЫТЫЕ ISSUES (%d). Разобрать до новой работы или сказать, почему нет:" % len(items)]

def row(r):
    created = datetime.datetime.fromisoformat(r["created_at"].replace("Z", "+00:00"))
    days = (now - created).days
    labels = ",".join(l["name"] for l in r.get("labels", []))
    age = "сегодня" if days == 0 else "%d дн." % days
    return "  #%s [%s] %s — %s" % (r["number"], labels or "без метки", r["title"], age)

for r in free:
    lines.append(row(r))

if busy:
    lines.append("")
    lines.append("ЗАНЯТО ДРУГИМИ — не браться, не спросив владельца (правило 08.09):")
    for r in busy:
        prs = ", ".join("#%s" % n for n in sorted(set(taken[int(r["number"])])))
        lines.append("%s  <- открытый PR %s" % (row(r), prs))

if not pulls_ok:
    lines.append("")
    lines.append(
        "ЗАНЯТОСТЬ НЕ ПРОВЕРЕНА: список открытых PR не прочитан. "
        "Это НЕ «все свободны» — перед началом сходить в PR руками."
    )

lines.append("")
lines.append(
    "Область этой сессии хук не знает и не угадывает — её называет владелец. "
    "Не названа — спросить, прежде чем брать из очереди."
)
print("\n".join(lines))
PYQUEUE
)

# Пустой вывод — это поломка, а не «нечего сказать». Молчание здесь читается
# как «очередь чиста», и именно так уже один раз и произошло.
if [ -z "${OUT//[[:space:]]/}" ]; then
  emit "ОЧЕРЕДЬ ISSUES НЕ ПРОЧИТАНА: разбор вернул пустоту. Это не «issues нет»."
  exit 0
fi

emit "$OUT"
