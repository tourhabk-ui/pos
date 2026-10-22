/**
 * Откуда веб-сессия Кузьмича в chat_sessions — по её id (вопрос владельца
 * 22.10: «кузьмич вчера 3 ответа а в переписках нету кто откуда»).
 *
 * В одну таблицу пишут три входа, и колонки «вход» у неё нет:
 * - виджет на сайте партнёра — `widget_<slug>_<id>` (app/api/widget/chat);
 * - еженедельная проверка безопасности — `safety-eval-<время>-<случай>`
 *   (scripts/kuzmich-safety-eval.ts): это не человек, и «Гостем сайта» её
 *   называть нельзя;
 * - всё остальное — чат на сайте (app/api/ai/chat).
 */
export type WebChatSource = 'web' | 'widget' | 'probe';

export function webChatSource(sessionId: string): WebChatSource {
  if (sessionId.startsWith('widget_')) return 'widget';
  if (sessionId.startsWith('safety-eval-')) return 'probe';
  return 'web';
}

/** Имена входов, на которых Кузьмич отвечает (lib/kuzmich/answer-timing, AnswerSurface). */
export const SURFACE_LABELS: Record<string, string> = {
  web: 'сайт', 'web-stream': 'сайт', telegram: 'Telegram', max: 'MAX', widget: 'виджет', a2a: 'A2A', other: 'прочее',
};

/** Ответы по поверхностям одной строкой: «сайт 5 · Telegram 3». Сайт и его потоковый вход — вместе. */
export function surfaceLine(by: Record<string, number>): string {
  const merged = new Map<string, number>();
  for (const [k, n] of Object.entries(by)) {
    const label = SURFACE_LABELS[k] ?? k;
    merged.set(label, (merged.get(label) ?? 0) + n);
  }
  return [...merged.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`).join(' · ');
}
