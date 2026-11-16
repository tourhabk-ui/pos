/**
 * Путь туриста без «сначала подключи MCP» (31.10, слово CTO: «пока не
 * подключишь — не заработает, люди не будут это делать»).
 *
 * 1. vedarai.ru/kuzmich?ask=… (и vedarai.ru/?ask=… — редирект сюда) открывает
 *    чат Кузьмича на сайте и сразу отправляет вопрос. Ничего ставить не надо.
 * 2. Ссылки «спросите у своего ИИ» — открывают ChatGPT / Claude / Perplexity
 *    с готовым вопросом; ИИ ищет в вебе, коннектор не нужен. На карточке тура
 *    это второй уровень под Кузьмичом, и вопрос привязан к странице (#3468).
 *    ВНИМАНИЕ: параметр `q` у chatgpt.com и claude.ai/new НЕ документирован
 *    официально (у perplexity.ai/search?q= — де-факто стабилен). Может
 *    перестать работать без предупреждения; тогда ссылка просто открывает
 *    пустой чат — вреда нет. MCP остаётся бонусом на /mcp.
 */

export const ASK_PARAM = 'ask';
export const ASK_MAX_LEN = 500;

/** Чистит вопрос из URL: обрезает пробелы, управляющие символы и длину. */
export function sanitizeAsk(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, ASK_MAX_LEN);
}

/** Ссылка на чат Кузьмича на сайте с готовым вопросом. */
export function kuzmichAskHref(question: string, base = ''): string {
  const q = sanitizeAsk(question);
  return q ? `${base}/kuzmich?${ASK_PARAM}=${encodeURIComponent(q)}` : `${base}/kuzmich`;
}

export interface AiAskLink { id: 'chatgpt' | 'claude' | 'perplexity'; label: string; href: string }

/**
 * Вопрос для чужого ИИ.
 *
 * Без страницы — называем сайт, чтобы поиск привёл на vedarai.ru.
 *
 * Со страницей (#3468, 16.11) — просим ответить ПО ЭТОЙ СТРАНИЦЕ и не уходить
 * на другие сайты. Повод: на карточке тура вопрос «Стоит ли ехать на тур …?»
 * ChatGPT понял как «сравни с рынком», ушёл к другим компаниям, поставил тур
 * Ведара четвёртым и не вернул ни одной ссылки на vedarai.ru. Что чужой ИИ
 * просьбу исполнит, мы не знаем: это гипотеза, её проверяет только живой
 * прогон. Поэтому внешние ИИ на карточке — второй уровень, а главная дорога —
 * Кузьмич, который отвечает по каталогу Ведара.
 */
export function aiPrompt(question: string, pageUrl?: string | null): string {
  const q = sanitizeAsk(question);
  if (pageUrl) {
    return `Прочитай страницу ${pageUrl} и ответь только по ней: ${q} `
      + 'Не ищи на других сайтах и не сравнивай с другими компаниями. '
      + 'Если на странице нет ответа — так и скажи. '
      + 'Цены и наличие мест называет только оператор в ответе на заявку.';
  }
  return `${q} Посмотри на vedarai.ru (Ведар — туры местных операторов Камчатки, помощник Кузьмич).`.trim();
}

export function aiAskLinks(question: string, pageUrl?: string | null): AiAskLink[] {
  const p = encodeURIComponent(aiPrompt(question, pageUrl));
  return [
    { id: 'chatgpt', label: 'ChatGPT', href: `https://chatgpt.com/?q=${p}` },
    { id: 'claude', label: 'Claude', href: `https://claude.ai/new?q=${p}` },
    { id: 'perplexity', label: 'Perplexity', href: `https://www.perplexity.ai/search?q=${p}` },
  ];
}
