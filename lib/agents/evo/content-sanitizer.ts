/**
 * Санитар контента — ступень 4 эволюции: система находит и откатывает МУСОР
 * в собственных AI-описаниях сама.
 *
 * Детекция ДЕТЕРМИНИРОВАННАЯ (сигнатуры, без LLM) — иначе авто-откат ловил бы
 * флакинес модели. Сигнатуры выбраны так, что реальное описание камчатского
 * объекта их не содержит: сырой Verbalized Sampling JSON, мета-отговорки
 * модели, заглушки waterfall. «Откат» = NULL описания → Editor регенерирует
 * чисто на том же прогоне (findRoutesNeedingDescription берёт IS NULL).
 *
 * Описания — НЕ safety-данные (безопасность в location_safety_profile /
 * external_alerts / sos_events), поэтому это правильное место для первого
 * автономного актуатора: малый радиус, только NULL, регенерируемо.
 *
 * Чистый модуль детекции (garbageSignature) — тестируется на фикстурах.
 */

import { pool } from '@/lib/db-pool';

// Сырой VS-JSON: начинается с '[' и несёт ключи probability+text (баг «Большой
// Калыгирь»: обрезанный массив сохранялся как описание).
const VS_JSON = { probFloor: /"probability"\s*:/, text: /"text"\s*:/ };
// Мета-отговорки модели — реальная проза места их не содержит.
const MODEL_META = /как (?:языковая модель|искусственный интеллект|ии\b)|я не могу (?:предоставить|выполнить|ответить|дать)|не предоставлен[а-я]* для анализа|as an ai\b|i (?:cannot|can't|am unable|'m unable)/i;
// Заглушка waterfall, когда все fast-провайдеры отказали.
const STUB = /сервис (?:временно )?недоступ|service (?:temporarily )?unavailable/i;

/**
 * Возвращает КОД причины, почему описание — мусор, или null если оно чистое.
 * Коды: 'verbalized_json' | 'model_meta' | 'stub'.
 */
export function garbageSignature(description: string | null): string | null {
  if (!description) return null;
  const d = description.trim();
  if (!d) return null;
  if (d.startsWith('[') && VS_JSON.probFloor.test(d) && VS_JSON.text.test(d)) return 'verbalized_json';
  if (MODEL_META.test(d)) return 'model_meta';
  if (STUB.test(d)) return 'stub';
  return null;
}

export interface SanitizeResult {
  cleared: number;
  byReason: Record<string, number>;
}

// Мастер-таблицы с колонкой description (§4.1). Литералы из union — не ввод
// пользователя, инъекции нет.
type DescTable = 'places' | 'kamchatka_routes';

async function sanitizeTable(table: DescTable, limit: number): Promise<SanitizeResult> {
  // Дешёвый префильтр в SQL, точное подтверждение — в JS (та же garbageSignature,
  // что покрыта тестами), чтобы не разъехались правила детекции.
  const { rows } = await pool.query<{ id: string; description: string }>(
    `SELECT id, description
     FROM ${table}
     WHERE description IS NOT NULL
       AND (
         description ~ '^\\s*\\['
         OR description ILIKE '%не предоставл%'
         OR description ILIKE '%языковая модель%'
         OR description ILIKE '%искусственный интеллект%'
         OR description ILIKE '%сервис временно недоступ%'
         OR description ILIKE '%сервис недоступ%'
         OR description ILIKE '%as an ai%'
         OR description ILIKE '%i cannot%'
         OR description ILIKE '%я не могу%'
       )
     LIMIT $1`,
    [limit],
  );

  const byReason: Record<string, number> = {};
  const ids: string[] = [];
  for (const r of rows) {
    const reason = garbageSignature(r.description);
    if (!reason) continue;
    ids.push(r.id);
    byReason[reason] = (byReason[reason] ?? 0) + 1;
  }

  if (ids.length > 0) {
    await pool.query(
      `UPDATE ${table} SET description = NULL WHERE id = ANY($1::uuid[])`,
      [ids],
    );
  }

  return { cleared: ids.length, byReason };
}

/**
 * Откатывает (NULL-ит) описания-мусор в мастер-таблицах, чтобы Editor
 * регенерировал их чисто. Cap на прогон — чтобы битая сигнатура (если такая
 * когда-то появится) не могла обнулить всё разом. Ошибка одной таблицы не
 * валит другую.
 */
export async function sanitizeGarbageDescriptions(limitPerTable = 100): Promise<SanitizeResult> {
  const merged: SanitizeResult = { cleared: 0, byReason: {} };
  for (const table of ['places', 'kamchatka_routes'] as const) {
    try {
      const r = await sanitizeTable(table, limitPerTable);
      merged.cleared += r.cleared;
      for (const [k, v] of Object.entries(r.byReason)) {
        merged.byReason[k] = (merged.byReason[k] ?? 0) + v;
      }
    } catch {
      // одна таблица упала — вторую всё равно чистим
    }
  }
  return merged;
}
