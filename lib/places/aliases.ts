/**
 * lib/places/aliases.ts — у места одно имя и много псевдонимов.
 *
 * ── Почему это вообще понадобилось ─────────────────────────────────────────
 *
 * Слово владельца 14.08: «в разных источниках одно и то же место называется
 * по-разному, из-за этого и путаница». Проверка подтвердила буквально: у
 * `places` есть `source_name` — ОДИН источник на строку, и класть второе имя
 * того же вулкана было некуда. Поэтому второй источник заводил вторую строку:
 * дубли были не сбоем импорта, а единственным способом хранить второе имя.
 *
 * ── Три правила, которые здесь собраны в одно место ────────────────────────
 *
 * 1. ЧТО ЗНАЧИТ «место совпало по имени» — теперь и по псевдониму тоже.
 *    Иначе поиск «Авачинский вулкан» не находит «Вулкан Авачинский», хотя это
 *    один и тот же вулкан.
 * 2. ЧТО ЗНАЧИТ «живое место» — не слитое. Публичные чтения этого не знали
 *    вовсе: `merged_into_id` уважали только админка и кроны дедупа, поэтому
 *    27 слитых записей продолжали находиться и открываться как отдельные
 *    места (админка при этом писала «скрыто из публички» — неправда,
 *    `is_visible` слияние не трогает).
 * 3. ЧТО ПРОИСХОДИТ С ИМЕНЕМ ПРИ СЛИЯНИИ — оно становится псевдонимом, а не
 *    пропадает. 14.08 слияние пяти пар унесло «Авачинский вулкан», «Гора
 *    Шишель», «Вулкан Шивелуч», «Кутхины Баты» — живые названия, которыми
 *    люди пользуются.
 *
 * Правила лежат рядом намеренно: в этом репозитории одно правило, размазанное
 * по трём файлам, уже трижды расходилось (стиль линии, сравнение секретов,
 * адрес формы МЧС).
 */

import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';

/** Живое место — не слитое в другое. */
export const NOT_MERGED = (p: string) => `${p}.merged_into_id IS NULL`;

/**
 * Совпадение по имени ИЛИ по псевдониму. `param` — плейсхолдер ($1, $2…),
 * подставляется дважды, поэтому передавать надо один и тот же.
 */
export const MATCHES_NAME_OR_ALIAS = (p: string, param: string) => `(
    ${p}.name ILIKE ${param}
    OR EXISTS (
      SELECT 1 FROM place_aliases pa
       WHERE pa.place_id = ${p}.id::text
         AND pa.alias ILIKE ${param}
    )
  )`;

/**
 * Записать псевдоним. Совпадающий с собственным именем места не пишется:
 * «Курильское озеро» → «Курильское озеро» это не второе название, а шум.
 */
export async function recordAlias(
  client: PoolClient,
  placeId: string,
  alias: string | null,
  sourceName: string | null,
): Promise<void> {
  if (!alias || !alias.trim()) return;
  await client.query(
    `INSERT INTO place_aliases (place_id, alias, source_name)
     SELECT $1, $2, $3
      WHERE NOT EXISTS (
        SELECT 1 FROM places p
         WHERE p.id::text = $1
           AND LOWER(TRIM(COALESCE(p.name, ''))) = LOWER(TRIM($2))
      )
     ON CONFLICT DO NOTHING`,
    [placeId, alias, sourceName],
  );
}

/**
 * Перевесить псевдонимы слитого места на оставшееся.
 *
 * Без этого цепочка теряет звенья: если у B уже был псевдоним «Бэ», а B слили
 * в A, то «Бэ» перестанет находить что-либо — имя было записано ради поиска и
 * пропало бы ровно в тот момент, когда стало нужнее.
 */
export async function moveAliases(
  client: PoolClient,
  fromPlaceId: string,
  toPlaceId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO place_aliases (place_id, alias, source_name)
     SELECT $2, pa.alias, pa.source_name
       FROM place_aliases pa
      WHERE pa.place_id = $1
     ON CONFLICT DO NOTHING`,
    [fromPlaceId, toPlaceId],
  );
  await client.query(`DELETE FROM place_aliases WHERE place_id = $1`, [fromPlaceId]);
}

export interface MergeTarget {
  /** Куда вести: slug, если он есть, иначе ark_id. */
  canonical: string;
  arkId: string | null;
  slug: string | null;
}

/**
 * Если по этому адресу лежит СЛИТОЕ место — куда вести вместо него.
 * `null` — вести никуда не надо (место живое, или его нет вовсе).
 *
 * Отдельная функция, а не условие внутри страницы: адресов у места три
 * (ark_id, id, slug), и повторять их разбор на каждой поверхности значит
 * заводить четвёртую версию правила.
 */
export async function resolveMergedTarget(idOrSlug: string): Promise<MergeTarget | null> {
  const { rows } = await pool.query<{
    ark_id: string | null;
    slug: string | null;
    merged: string | null;
  }>(
    `SELECT k.ark_id::text AS ark_id, k.slug, m.merged_into_id::text AS merged
       FROM places m
       JOIN places k ON k.id::text = m.merged_into_id::text
      WHERE (m.ark_id::text = $1 OR m.id::text = $1 OR m.slug = $1)
        AND m.merged_into_id IS NOT NULL
      LIMIT 1`,
    [idOrSlug],
  );
  const r = rows[0];
  if (!r) return null;
  const canonical = r.slug ?? r.ark_id;
  if (!canonical) return null;
  return { canonical, arkId: r.ark_id, slug: r.slug };
}
