/**
 * Путь туриста без «сначала подключи MCP» (31.10, слово CTO: «пока не
 * подключишь — не заработает, люди не будут это делать»).
 *
 * 1. vedarai.ru/kuzmich?ask=… (и vedarai.ru/?ask=… — редирект сюда) открывает
 *    чат Кузьмича на сайте и сразу отправляет вопрос. Ничего ставить не надо.
 * 2. Ссылки «спросите у своего ИИ» — открывают ChatGPT / Claude / Perplexity
 *    с готовым вопросом; ИИ ищет в вебе, коннектор не нужен.
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

/** Вопрос для чужого ИИ: явно называем сайт, чтобы поиск привёл на vedarai.ru. */
export function aiPrompt(question: string): string {
  const q = sanitizeAsk(question);
  return `${q} Посмотри на vedarai.ru (Ведар — туры местных операторов Камчатки, помощник Кузьмич).`.trim();
}

export function aiAskLinks(question: string): AiAskLink[] {
  const p = encodeURIComponent(aiPrompt(question));
  return [
    { id: 'chatgpt', label: 'ChatGPT', href: `https://chatgpt.com/?q=${p}` },
    { id: 'claude', label: 'Claude', href: `https://claude.ai/new?q=${p}` },
    { id: 'perplexity', label: 'Perplexity', href: `https://www.perplexity.ai/search?q=${p}` },
  ];
}
