/**
 * lib/leads/entry-context.ts — вход и инструмент вызова, которые доходят до
 * записи заявки (createLeadDetailed) без протаскивания через каждый
 * исполнитель (разбор 08.11).
 *
 * Вход знает только граница вызова — runPublicTool: MCP, A2A (`via: 'a2a'`)
 * или чат Кузьмича (согласие из чата, `consentFrom`). Заявку пишут шесть
 * исполнителей и два сервиса (машина, прокат), и каждый собирал свой
 * `source_data` с `source: 'mcp'`. Контекст ставится один раз на вызов
 * инструмента, а createLeadDetailed дописывает `entry` и `tool`, если их нет.
 * Тот же приём, что у подписи расхода моделей (lib/ai/usage-context).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChatConsentSource } from '@/lib/legal/pd-consent';
import type { LeadEntry } from '@/lib/leads/entry-values';

export interface LeadEntryContext {
  entry: LeadEntry;
  /** Инструмент вызова: create_booking_request, create_trip_request и т. п. */
  tool: string;
}

const store = new AsyncLocalStorage<LeadEntryContext>();

export function withLeadEntry<T>(ctx: LeadEntryContext, fn: () => Promise<T>): Promise<T> {
  return store.run(ctx, fn);
}

/** Вход текущего вызова инструмента; null — заявка создаётся не инструментом. */
export function currentLeadEntry(): LeadEntryContext | null {
  return store.getStore() ?? null;
}

/**
 * Вход по признакам вызова. Согласие из чата Кузьмича — это чат, каким бы
 * путём его ни звали; `via: 'a2a'` ставит только A2A; остальное — MCP.
 */
export function leadEntryOf(call: { consentFrom?: { source: ChatConsentSource }; via?: 'a2a' }): LeadEntry {
  if (call.consentFrom) return call.consentFrom.source;
  if (call.via === 'a2a') return 'a2a';
  return 'mcp';
}
