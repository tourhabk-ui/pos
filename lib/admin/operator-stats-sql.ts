/**
 * Заполненность карточек туроператоров для GET /api/admin/operator-stats.
 *
 * До 22.10 оба запроса сравнивали `partners.contact` (jsonb NOT NULL) с пустой
 * строкой: PostgreSQL приводит '' к jsonb и отвечает 22P02, то есть роут падал
 * на каждом вызове (находка отчёта судьи #1428). «Контакт заполнен» для jsonb —
 * не пустой объект и не JSON-null; website и description — текст.
 *
 * Сам контакт (телефон, почта) из базы не выбирается: экрану нужен только
 * признак «заполнено», а не ПД партнёра. Проверено на настоящем PostgreSQL:
 * tests/integration/operator-screens.pg.test.ts.
 */

const CONTACT_FILLED = `(contact IS NOT NULL AND contact <> '{}'::jsonb AND jsonb_typeof(contact) <> 'null')`;
const TEXT_FILLED = (col: 'website' | 'description') => `(${col} IS NOT NULL AND btrim(${col}) <> '')`;

export const OPERATOR_DATA_QUALITY_SQL = `
  SELECT
    COUNT(*)::int                                         AS total,
    COUNT(*) FILTER (WHERE ${CONTACT_FILLED})::int        AS contact_filled,
    COUNT(*) FILTER (WHERE ${TEXT_FILLED('website')})::int     AS website_filled,
    COUNT(*) FILTER (WHERE ${TEXT_FILLED('description')})::int AS description_filled
  FROM partners
  WHERE category = 'operator'`;

export const OPERATOR_INCOMPLETE_SQL = `
  SELECT id, name,
         NOT ${CONTACT_FILLED}                AS contact_missing,
         NOT ${TEXT_FILLED('website')}        AS website_missing,
         NOT ${TEXT_FILLED('description')}    AS description_missing
  FROM partners
  WHERE category = 'operator'
  ORDER BY
    ((NOT ${CONTACT_FILLED})::int + (NOT ${TEXT_FILLED('website')})::int + (NOT ${TEXT_FILLED('description')})::int) DESC,
    id
  LIMIT 10`;

export interface OperatorDataQualityRow {
  total: number;
  contact_filled: number;
  website_filled: number;
  description_filled: number;
}

export interface OperatorIncompleteRow {
  id: string;
  name: string;
  contact_missing: boolean;
  website_missing: boolean;
  description_missing: boolean;
}
