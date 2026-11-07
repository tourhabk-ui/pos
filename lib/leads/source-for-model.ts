/**
 * Что из `leads.source_data` видит модель-квалификатор заявки.
 *
 * Ревью безопасности PR #3104: обработчик заявок отдавал зарубежной модели
 * `redactPII(JSON.stringify(lead.source_data))`, а redactPII режет только
 * телефоны и почту. В заявке из Telegram там лежат `telegram_user_id` и
 * `telegram_username`, из MAX — `max_chat_id`, из публичной формы — любые
 * ключи, какие прислал сайт. Всё это — идентификаторы человека (152-ФЗ).
 *
 * Поэтому — перечень полей о поездке, а не запрет знакомых идентификаторов:
 * запрет обходится следующим ключом формы. Вложенные объекты не идут вовсе,
 * строки — сквозь redactPII (телефон, вписанный в поле, режется).
 * Квалификатору этого хватает: числа заявки сверяются с source_data отдельно,
 * без модели (lib/leads/intent-grounding).
 */
import { redactPII } from '@/lib/security/pii-redact';

export const MODEL_SOURCE_KEYS = [
  'source', 'tool', 'interests', 'activity', 'activity_type',
  'date', 'dates', 'date_from', 'date_to', 'duration_days',
  'participants', 'group_size', 'adults', 'children', 'budget_rub', 'budget',
  'tour_id', 'trip_days',
] as const;

type Plain = string | number | boolean;

function plain(v: unknown): Plain | Plain[] | undefined {
  if (typeof v === 'string') return redactPII(v);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) {
    const items = v.filter((x): x is Plain => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean');
    return items.map((x) => (typeof x === 'string' ? redactPII(x) : x));
  }
  return undefined;
}

export function sourceDataForModel(data: Record<string, unknown> | null | undefined): Record<string, Plain | Plain[]> {
  const out: Record<string, Plain | Plain[]> = {};
  if (!data) return out;
  for (const key of MODEL_SOURCE_KEYS) {
    const v = plain(data[key]);
    if (v !== undefined && v !== '') out[key] = v;
  }
  return out;
}
