/**
 * Ответ Кузьмича → разметка, которую примет Telegram (parse_mode=HTML).
 *
 * Одна функция на оба обработчика бота: второй вход /api/telegram/kuzmich
 * держал её у себя, а канонический вебхук /api/telegram/webhook отправлял
 * ответ модели как есть (аудит 15.10, TG-BRAIN). Модель отвечает то
 * markdown-звёздочками, то эмодзи вопреки промпту — копия правила в двух
 * роутах разошлась бы так же, как расходились до неё глаголы, стиль линии и
 * тип ключа.
 */

/** Снять эмодзи (эмотиконы, символы, флаги). Переносы строк не схлопывать: дни программы — список, не абзац. */
function stripEmoji(s: string): string {
  return s.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').replace(/[^\S\n]{2,}/g, ' ');
}

/**
 * «День 1 — …» в Telegram читается заголовком дня.
 * Модель пишет обычный текст: жирным строку делает отправка, не промпт.
 */
export function emphasizeTripDays(raw: string): string {
  return raw.replace(/(^|\n)([ \t]*)(День\s+\d+[^\n]*)/g, (_all, lead: string, space: string, day: string) => {
    if (day.includes('<b>')) return `${lead}${space}${day}`;
    return `${lead}${space}<b>${day.trim()}</b>`;
  });
}

/** Остатки markdown → HTML Telegram, неподдерживаемое — прочь, эмодзи — прочь. */
export function sanitizeForTelegram(raw: string): string {
  let t = raw;
  // **bold** or __bold__ → <b>bold</b>
  t = t.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  t = t.replace(/__(.+?)__/g, '<b>$1</b>');
  // *italic* → <i>italic</i> (but not bullet-list asterisks)
  t = t.replace(/(?<!\n)\*(?!\s)(.+?)(?<!\s)\*/g, '<i>$1</i>');
  // Remove leftover markdown artifacts: # headers, * bullet, ``` code blocks
  t = t.replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/^[\*\-]\s+/gm, '- ');
  t = t.replace(/```[\s\S]*?```/g, '');
  // Strip emojis
  t = stripEmoji(t);
  return t.trim();
}
