#!/usr/bin/env bash
# После влития своего PR: ветка сессии заново от main и запушена (pr-drive §5).
#
# Перезапись ветки на сервере допускается, только когда всё, что на ней
# лежит, уже есть в main: слияние её головы с main не меняет дерево main.
# Иначе — отказ: на ветке невлитая работа (может быть, этой же сессии).
# Ветки на сервере нет (удалена после влития) — обычный push -u.
#
#   bash scripts/session/after-merge.sh <ветка>
set -euo pipefail
branch="${1:?Нужно имя ветки: bash scripts/session/after-merge.sh <ветка>}"
remote="${2:-origin}"

git fetch -q "$remote" main
remote_sha="$(git ls-remote --heads "$remote" "$branch" | cut -f1)"
main_tree="$(git rev-parse "$remote/main^{tree}")"

if [ -n "$remote_sha" ]; then
  git fetch -q "$remote" "$branch"
  merged_tree="$(git merge-tree --write-tree "$remote/main" "$remote_sha" 2>/dev/null | head -n1 || true)"
  if [ "$merged_tree" != "$main_tree" ]; then
    echo "ОТКАЗ: на $remote/$branch (${remote_sha:0:9}) есть изменения, которых нет в main." >&2
    echo "Ветка не тронута. Влейте её PR или разберитесь вручную." >&2
    exit 1
  fi
fi

git checkout -q -B "$branch" "$remote/main"
if [ -n "$remote_sha" ]; then
  git push -q --force-with-lease="$branch:$remote_sha" -u "$remote" "$branch" 2>/dev/null
else
  git push -q -u "$remote" "$branch" 2>/dev/null
fi
echo "OK    $branch = $(git rev-parse --short HEAD) ($remote/main), запушена"
