#!/usr/bin/env bash
# Образец голоса DeepSeek — владельцу в Telegram, на слух.
#
# Слово владельца 15.11: «голос не работает», «deepseek добавили голос».
# Проверка прода 189: голос Qwen отвечает 403 (кончилась бесплатная квота), а
# DeepSeek на русскую фразу отдал 12,9 с звука. Но русского нет в списке
# языков DeepSeek, и проба не знает, понятна ли речь: длительность — не
# разборчивость. Решить, годится ли голос туристу, может только человек,
# который его услышит. Поэтому образец уходит владельцу голосовым сообщением,
# а кнопка «Озвучить» на DeepSeek не переключается.
#
# Фраза — вшитая, без персональных данных: числа, время, сокращение МЧС и
# названия мест, то есть то, на чём синтез ошибается чаще всего.
#
# Три исхода на голос (§4.0): ушло в Telegram; DeepSeek не дал звук; Telegram
# не принял. Любой отказ — красный прогон с причиной. Ключи наружу не выходят:
# в лог идут только коды ответов и размеры.
#
# Окружение: DEEPSEEK_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_ID (секреты),
# VOICES (через пробел), OUT_DIR. Нужны curl, jq, ffmpeg.

set -euo pipefail

VOICES="${VOICES:-stella tide}"
OUT_DIR="${OUT_DIR:-voice-sample}"
TTS_URL='https://api.deepseek.com/v1/tools/tts'
SAMPLE_TEXT='Здравствуйте! Это образец голоса Кузьмича. Вулкан Авачинский, Курильское озеро, Петропавловск-Камчатский. Экстренный вызов — 112. Регистрация группы в МЧС — до выхода на маршрут. Встреча в 7:30, группа из 4 человек, выезд 18 ноября.'

if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  echo "::error::секрет DEEPSEEK_API_KEY не задан — образец не получен"
  exit 1
fi
if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_OWNER_ID:-}" ]; then
  echo "::error::секреты TELEGRAM_BOT_TOKEN и TELEGRAM_OWNER_ID не заданы — образец некуда отправить"
  exit 1
fi

mkdir -p "$OUT_DIR"
failed=0
sent=0
for voice in $VOICES; do
  body=$(jq -cn --arg t "$SAMPLE_TEXT" --arg v "$voice" '{text: $t, voice_id: $v, format: "wav"}')
  code=$(curl -sS -o "$OUT_DIR/$voice.wav" -w '%{http_code}' --max-time 120 -X POST "$TTS_URL" \
    -H "Authorization: Bearer $DEEPSEEK_API_KEY" -H 'Content-Type: application/json' \
    -d "$body") || code=000
  bytes=$(wc -c < "$OUT_DIR/$voice.wav" 2>/dev/null || echo 0)
  if [ "$code" != 200 ] || [ "$bytes" -lt 1000 ]; then
    echo "::error::голос $voice: DeepSeek звука не дал (HTTP $code, $bytes байт)"
    head -c 300 "$OUT_DIR/$voice.wav" 2>/dev/null || true
    echo
    failed=1
    continue
  fi

  # Голосовое сообщение Telegram — OGG/Opus; WAV он покажет файлом.
  if ! ffmpeg -loglevel error -y -i "$OUT_DIR/$voice.wav" -c:a libopus -b:a 48k "$OUT_DIR/$voice.ogg"; then
    echo "::error::голос $voice: звук получен ($bytes байт), но не перекодирован в OGG"
    failed=1
    continue
  fi

  caption="Образец голоса DeepSeek «$voice» для кнопки «Озвучить». Русского в документации DeepSeek нет — оцените на слух: понятна ли речь, верно ли прочитаны числа и МЧС."
  tg=$(curl -sS -o "$OUT_DIR/$voice.telegram.json" -w '%{http_code}' --max-time 60 \
    -F "chat_id=$TELEGRAM_OWNER_ID" -F "voice=@$OUT_DIR/$voice.ogg" -F "caption=$caption" \
    "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendVoice") || tg=000
  if [ "$tg" != 200 ] || [ "$(jq -r '.ok // false' "$OUT_DIR/$voice.telegram.json" 2>/dev/null)" != true ]; then
    echo "::error::голос $voice: Telegram не принял сообщение (HTTP $tg)"
    jq -r '.description // empty' "$OUT_DIR/$voice.telegram.json" 2>/dev/null || true
    failed=1
    continue
  fi
  echo "голос $voice: ушёл владельцу в Telegram (WAV $bytes байт)"
  sent=$((sent + 1))
done

echo "Итог: отправлено $sent из $(echo $VOICES | wc -w)."
exit "$failed"
