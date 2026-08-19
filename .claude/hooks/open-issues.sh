#!/usr/bin/env bash
# Показать открытые issues в начале сессии.
#
# 19.08 находка «SQL-инъекция через интерполяцию» (#1293) провисела четыре
# часа и была замечена только по вопросу владельца. Механизма, который бы её
# показал, не существовало: issue-reporter выносит находки в GitHub и на этом
# останавливается, а «Claude возьмёт их оттуда» держалось на том, вспомнил я
# или нет.
#
# Память — не механизм. Хук показывает очередь сам, без напоминаний.
#
# Тишина здесь запрещена: если очередь прочитать не удалось, хук говорит об
# этом вслух. Непрочитанная очередь и пустая очередь — разные вещи, и молчать
# одинаково в обоих случаях значит выдавать первое за второе.
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

OUT=$(printf '%s' "$BODY" | python3 -c '
import json, sys, datetime
try:
    rows = json.load(sys.stdin)
except Exception:
    print("ОЧЕРЕДЬ ISSUES НЕ ПРОЧИТАНА: ответ GitHub не разобрался.")
    sys.exit(0)
if not isinstance(rows, list):
    print("ОЧЕРЕДЬ ISSUES НЕ ПРОЧИТАНА: GitHub ответил не списком.")
    sys.exit(0)
# Pull requests приходят той же ручкой — они не issues.
items = [r for r in rows if "pull_request" not in r]
if not items:
    print("Открытых issues нет.")
    sys.exit(0)
now = datetime.datetime.now(datetime.timezone.utc)
lines = ["ОТКРЫТЫЕ ISSUES (%d). Разобрать до новой работы или сказать, почему нет:" % len(items)]
for r in items:
    created = datetime.datetime.fromisoformat(r["created_at"].replace("Z", "+00:00"))
    days = (now - created).days
    labels = ",".join(l["name"] for l in r.get("labels", []))
    age = "сегодня" if days == 0 else "%d дн." % days
    lines.append("  #%s [%s] %s — %s" % (r["number"], labels or "без метки", r["title"], age))
print("\n".join(lines))
')

emit "$OUT"
