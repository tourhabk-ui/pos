#!/usr/bin/env bash
# Статус-лайн Claude Code для репо Ведара.
# Вход — JSON на stdin (model, workspace, transcript_path); выход — одна строка.
# Формат: Модель | папка | ветка *грязь ^ahead vbehind | [#####·····] 47% из 200k
# Идея — ykdojo/claude-code-tips (Tip 0), реализация своя: без эмодзи (правило
# репо), цвета — ANSI, близкие к токенам Ведара (accent/ocean/muted).

set -u
input=$(cat)

jqr() { printf '%s' "$input" | jq -r "$1" 2>/dev/null; }

model=$(jqr '.model.display_name // "Claude"')
dir=$(jqr '.workspace.current_dir // "."')
transcript=$(jqr '.transcript_path // empty')
name=$(basename "$dir")

# ANSI: accent (оранжевый), ocean (голубой), muted (серый), reset.
A=$'\033[38;5;208m'; O=$'\033[38;5;74m'; M=$'\033[38;5;245m'; R=$'\033[0m'

# ── git: ветка, число изменённых файлов, расхождение с upstream ──
git_part=""
branch=$(git -C "$dir" branch --show-current 2>/dev/null)
if [ -n "$branch" ]; then
  dirty=$(git -C "$dir" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  ab=$(git -C "$dir" rev-list --left-right --count '@{upstream}...HEAD' 2>/dev/null)
  behind=${ab%%$'\t'*}; ahead=${ab##*$'\t'}
  st=""
  [ "${dirty:-0}" != "0" ] && st=" ${A}*${dirty}${R}"
  [ -n "${ahead:-}" ] && [ "$ahead" != "0" ] && [ "$ahead" != "$ab" ] && st="$st ${M}^${ahead}${R}"
  [ -n "${behind:-}" ] && [ "$behind" != "0" ] && [ "$behind" != "$ab" ] && st="$st ${M}v${behind}${R}"
  git_part=" ${M}|${R} ${O}${branch}${R}${st}"
fi

# ── контекст: последний usage из транскрипта, шкала от 200k ──
ctx_part=""
if [ -n "$transcript" ] && [ -f "$transcript" ]; then
  # tail -n (не -c): обрезка по байтам рвёт первую JSON-строку, и jq -s
  # валит весь пакет. Usage есть почти в каждом ответе — 50 строк хватает.
  used=$(tail -n 50 "$transcript" 2>/dev/null \
    | jq -rs '[ .[] | .message.usage | select(. != null and .input_tokens != null)
        | (.input_tokens + (.cache_read_input_tokens // 0) + (.cache_creation_input_tokens // 0)) ]
        | last // empty' 2>/dev/null)
  if [ -n "$used" ] && [ "$used" != "null" ]; then
    limit=200000
    pct=$(( used * 100 / limit )); [ "$pct" -gt 100 ] && pct=100
    filled=$(( pct / 10 ))
    bar=""
    for i in 1 2 3 4 5 6 7 8 9 10; do
      if [ "$i" -le "$filled" ]; then bar="${bar}#"; else bar="${bar}."; fi
    done
    barcolor=$O
    [ "$pct" -ge 60 ] && barcolor=$A
    [ "$pct" -ge 85 ] && barcolor=$'\033[38;5;196m'
    ctx_part=" ${M}|${R} ${barcolor}[${bar}]${R} ${M}${pct}% из 200k${R}"
  fi
fi

printf '%s' "${A}${model}${R} ${M}|${R} ${name}${git_part}${ctx_part}"
