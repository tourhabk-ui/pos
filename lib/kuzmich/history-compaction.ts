/**
 * lib/kuzmich/history-compaction.ts
 *
 * Компакция истории = суммаризация, а не удаление (Roitman §18, Eq 18.4).
 * splitHistoryForCompaction (context-budget.ts) отбрасывает голову диалога,
 * не влезающую в токен-бюджет, молча — если там был исходный запрос туриста
 * или уже сообщённый факт безопасности (место закрыто, есть алерт), модель
 * может повторить вопрос или упустить контекст. Сжимаем отброшенное в 1-2
 * предложения устойчивых фактов и добавляем в динамический блок промпта —
 * НЕ в сам массив истории (чтобы не плодить второе system-сообщение и не
 * трогать протокол ChatMessage[] для остальных вызывающих getHistory()).
 *
 * Только для tourist-facing чата Кузьмича (aiChat) — вызывается явно, не
 * встроено в общий getHistory(), которым пользуются operator-chat и сырой
 * telegram webhook.
 */

import { callAIFast } from '@/lib/ai/providers';
import type { ChatMessage } from '@/lib/ai/prompts';

const COMPACTION_SYSTEM = `Сожми фрагмент диалога туриста с Кузьмичом (Хранителем Камчатки) в 1-2 предложения — только устойчивые факты: что турист уже спрашивал или решил, что ему уже сообщили по безопасности/статусу мест (открыто/закрыто, опасности, алерты), его планы и предпочтения. Не выдумывай ничего сверх сказанного. Если ничего важного для дальнейшего разговора нет — ответь ровно "нет".`;

/** Собирает транскрипт отброшенных реплик для судьи-суммаризатора. Чистая функция, тестируема без сети. */
export function buildCompactionTranscript(dropped: ChatMessage[]): string {
  return dropped
    .filter(m => m.role !== 'system')
    .map(m => `${m.role === 'user' ? 'Турист' : 'Кузьмич'}: ${m.content.slice(0, 500)}`)
    .join('\n')
    .slice(0, 4000);
}

/**
 * Суммирует отброшенный по бюджету хвост истории. Fail-open: пустая строка
 * при пустом вводе, отказе судьи или сбое AI — не блокирует ответ Кузьмича.
 */
export async function summarizeDroppedTurns(dropped: ChatMessage[]): Promise<string> {
  const transcript = buildCompactionTranscript(dropped);
  if (!transcript) return '';
  try {
    const raw = await callAIFast([
      { role: 'system', content: COMPACTION_SYSTEM },
      { role: 'user', content: transcript },
    ]);
    const trimmed = raw?.trim() ?? '';
    if (!trimmed || /^нет\.?$/i.test(trimmed)) return '';
    return trimmed.slice(0, 500);
  } catch {
    return '';
  }
}
