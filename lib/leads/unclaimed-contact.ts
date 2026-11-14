/**
 * Заявка без адресата: имя и контакты — после взятия (слово владельца 14.11
 * «скрывать до взятия»).
 *
 * Заявку без адресата видят все компании на витрине (§23 CLAUDE.md,
 * `lib/leads/ownership`). До 14.11 каждая из них читала имя, телефон, почту и
 * свободный текст человека ещё до того, как решила с заявкой работать. Теперь
 * компания видит, что просят: даты, состав, интересы, откуда пришла заявка.
 * Кто просит, она узнаёт, когда возьмёт заявку себе: тогда заявку не видит
 * больше никто.
 *
 * Маска одна на список, карточку и доску (`hideUnclaimedContact`). Действия,
 * которые читают контакт или пишут человеку (предложение, PDF, отправка,
 * разбор), заявку без взятия не принимают: `leadAccess` в
 * `lib/leads/ownership`.
 */
import type { LeadScope } from '@/lib/leads/ownership';
import { redactChatPD } from '@/lib/security/pii-redact';

/** Что видит компания вместо имени и контактов. */
export const CONTACT_HIDDEN_NOTE =
  'Имя и контакты человека откроются, когда возьмёте заявку. Взятую заявку видит только ваша компания.';

/**
 * Ответ на действие с не взятой заявкой (предложение, PDF, отправка, разбор,
 * бронь из заявки). Модуль клиентский: текст показывает и форма брони.
 */
export const CLAIM_FIRST_TEXT =
  'Сначала возьмите заявку: имя и контакты человека, предложение и разбор открываются взявшей её компании.';

/** Подпись на месте имени у не взятой заявки. */
export const HIDDEN_NAME = 'Имя — после взятия заявки';

/**
 * Ключи `source_data`, которые называют человека или его чат: имена,
 * телефоны, почта, ники, id чатов и аккаунтов мессенджеров. Поиск по имени
 * ключа, а не по списку: источники заявок пишут свои поля (Telegram, MAX,
 * формы), и новый ключ с идентификатором не должен пройти молча.
 */
const IDENTIFYING_KEY = /(^|_)(name|names|phone|phones|email|emails|username|chat_id|user_id|contact|contacts)$|telegram|^max_/i;

function scrubSourceData(value: unknown, names: ReadonlyArray<string | null | undefined>): unknown {
  if (Array.isArray(value)) return value.map((v) => scrubSourceData(v, names));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (IDENTIFYING_KEY.test(k)) continue;
      out[k] = scrubSourceData(v, names);
    }
    return out;
  }
  if (typeof value === 'string') return redactChatPD(value, names);
  return value;
}

/** Скрывать ли контакт этой заявки от этого кабинета. */
export function contactHidden(scope: LeadScope, operatorId: string | null | undefined): boolean {
  return scope.kind === 'owner' && (operatorId ?? null) === null;
}

export interface LeadContactFields {
  operator_id?: string | null;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  comment?: string | null;
  notes?: string | null;
  ai_summary?: string | null;
  source_data?: unknown;
}

/**
 * Строка заявки для кабинета: у не взятой заявки без адресата — без имени,
 * телефона, почты и идентификаторов в `source_data`; свободный текст —
 * через маску переписки (телефоны, почта, ссылки, ники, представившееся имя и
 * имя из заявки). `contact_hidden` говорит экрану, что показать вместо них.
 */
export function hideUnclaimedContact<T extends object>(scope: LeadScope, lead: T): T & { contact_hidden: boolean } {
  const row = lead as T & LeadContactFields;
  if (!contactHidden(scope, row.operator_id)) return { ...row, contact_hidden: false };
  const names = [row.name];
  return {
    ...row,
    name: HIDDEN_NAME,
    phone: '',
    email: null,
    comment: row.comment == null ? row.comment : redactChatPD(row.comment, names),
    notes: row.notes == null ? row.notes : redactChatPD(row.notes, names),
    ai_summary: row.ai_summary == null ? row.ai_summary : redactChatPD(row.ai_summary, names),
    source_data: row.source_data == null ? row.source_data : scrubSourceData(row.source_data, names),
    contact_hidden: true,
  };
}
