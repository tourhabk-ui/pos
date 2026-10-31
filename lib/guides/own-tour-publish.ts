/**
 * Гид сам выводит свой тур на сайт и снимает его — одна функция для кнопок
 * раздела «Свои туры» на сайте и «Мои туры» в чате кабинета (слово владельца
 * 31.10: гид создаёт свои туры сам; правки тура идут на витрину сразу по
 * кнопке, «гид должен полностью управлять своей ролью из MAX»).
 *
 * ── Витринный гейт: одно правило, в SQL ──────────────────────────────────
 *
 * Каталог видит тур по шлюзу `publicTourSql` (lib/tours/public-visibility):
 * три флага — включён, опубликован, не удалён. Флаги ставит эта функция, и
 * результат она сверяет ответом самого шлюза на этой же строке
 * (`RETURNING publicTourSql(...)`): «опубликовал» говорится, только если
 * шлюз каталога сказал «на витрине».
 *
 * Флаги — не содержание. Чтобы турист не увидел пустую карточку или тур гида,
 * которого платформа не одобрила, у публикации своего тура гидом есть
 * условия (`PUBLISH_BLOCKERS`). Каждое — SQL-предикат здесь, и один и тот же
 * текст судит везде: перечень «чего не хватает» в чате и на сайте
 * (`publishBlockersSql` в SELECT) и сама публикация (тот же предикат в WHERE
 * её UPDATE). Копии в TypeScript нет — расходиться нечему.
 *
 *  - description — нет описания: карточка без текста о поездке (1338:
 *    «тур из одной строки — выдумка программы», такие туры шли черновиками);
 *  - base_price — нет цены (у старых черновиков схема её допускает);
 *  - guide_not_public — анкету гида платформа не одобрила или приостановила
 *    (`publicGuideWhere`, lib/guides/visibility): гид, которого нет в
 *    реестре, не попадает к туристу и своими турами.
 *
 * Чего гейт НЕ требует, сказано честно: фото, длительность, подвоз, условия
 * отмены, координаты — карточка их просто не показывает, пока не записаны;
 * это правило готовности к ЧУЖИМ витринам (lib/tours/readiness), не к своей.
 *
 * Владение — в самих UPDATE (`operator_id = ownerId`); чужой и удалённый тур
 * — `not_found`, ни строки не тронуто. Снять с сайта — `is_published = FALSE`
 * (черновик), условий нет. После COMMIT — пинг IndexNow, как у правки тура
 * оператором (`pingTourChanged`); перевод на китайский крон `zh-translate`
 * берёт сам по шлюзу каталога.
 */

import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import { transaction } from '@/lib/database';
import { pingTourChanged } from '@/lib/seo/indexnow';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { publicGuideWhere } from '@/lib/guides/visibility';
import { PUBLISH_BLOCKERS, type PublishBlocker } from '@/lib/guides/own-tour-words';

export { PUBLISH_BLOCKERS, PUBLISH_BLOCKER_LABELS, publishBlockerLabel, type PublishBlocker } from '@/lib/guides/own-tour-words';


/** Предикаты гейта: true — условие НЕ выполнено. Алиасы: `ot` — тур, `p` — карточка владельца. */
const BLOCKER_SQL: Readonly<Record<PublishBlocker, string>> = {
  description: `(ot.description IS NULL OR length(btrim(ot.description)) = 0)`,
  base_price: `(ot.base_price IS NULL OR ot.base_price <= 0)`,
  guide_not_public: `(NOT COALESCE((${publicGuideWhere('p')}), FALSE))`,
};

/**
 * SQL-выражение `text[]` — чего не хватает туру `ot` владельца `p` до сайта.
 * Пустой массив — гейт пройден. Его же зовёт чтение раздела «Свои туры»
 * (lib/guides/own-tours) и экран тура в чате.
 */
export function publishBlockersSql(): string {
  return `ARRAY_REMOVE(ARRAY[${PUBLISH_BLOCKERS.map((b) => `CASE WHEN ${BLOCKER_SQL[b]} THEN '${b}' END`).join(', ')}]::text[], NULL)`;
}

function blockersOf(raw: unknown): PublishBlocker[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((b): b is PublishBlocker => (PUBLISH_BLOCKERS as readonly string[]).includes(String(b)));
}

function sqlstate(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
}

// ── Чтение ──────────────────────────────────────────────────────────────────

export type PublishGate =
  | { outcome: 'ok'; onStorefront: boolean; blockers: PublishBlocker[] }
  | { outcome: 'not_found' }
  | { outcome: 'db_error' };

/** Гейт одного своего тура: на сайте ли он и чего не хватает. */
export async function readPublishGate(
  ownerId: string,
  tourId: string,
  db: Pick<PoolClient, 'query'> = pool,
): Promise<PublishGate> {
  try {
    const { rows } = await db.query<{ on_storefront: boolean; blockers: unknown }>(
      `SELECT ${publicTourSql('ot')} AS on_storefront, ${publishBlockersSql()} AS blockers
         FROM operator_tours ot
         JOIN partners p ON p.id = ot.operator_id
        WHERE ot.id = $2::bigint AND ot.operator_id = $1::uuid AND ot.deleted_at IS NULL`,
      [ownerId, tourId],
    );
    const r = rows[0];
    if (!r) return { outcome: 'not_found' };
    return { outcome: 'ok', onStorefront: r.on_storefront === true, blockers: blockersOf(r.blockers) };
  } catch (err) {
    console.error(`[own-tour-publish] гейт тура — отказ, SQLSTATE ${sqlstate(err)}`);
    return { outcome: 'db_error' };
  }
}

// ── Запись ──────────────────────────────────────────────────────────────────

export type PublishResult =
  | { outcome: 'published'; title: string; slug: string | null }
  /** Гейт не пройден — ничего не записано; тур остался черновиком. */
  | { outcome: 'blocked'; title: string; blockers: PublishBlocker[] }
  | { outcome: 'already_on'; title: string; slug: string | null }
  | { outcome: 'not_found' };

export type UnpublishResult =
  | { outcome: 'unpublished'; title: string }
  | { outcome: 'already_off'; title: string }
  | { outcome: 'not_found' };

interface LockedRow { title: string; slug: string | null; on_storefront: boolean; blockers: unknown }

async function lockOwn(c: Pick<PoolClient, 'query'>, ownerId: string, tourId: string): Promise<LockedRow | null> {
  const { rows } = await c.query<LockedRow>(
    `SELECT ot.title, NULLIF(btrim(ot.slug), '') AS slug,
            ${publicTourSql('ot')} AS on_storefront, ${publishBlockersSql()} AS blockers
       FROM operator_tours ot
       JOIN partners p ON p.id = ot.operator_id
      WHERE ot.id = $2::bigint AND ot.operator_id = $1::uuid AND ot.deleted_at IS NULL
      FOR UPDATE OF ot`,
    [ownerId, tourId],
  );
  return rows[0] ?? null;
}

/**
 * Опубликовать: гейт на заблокированной строке; пройден — флаги ставит UPDATE
 * с тем же гейтом в WHERE, и ответ шлюза каталога из RETURNING обязан быть
 * «на витрине». Транзакцию даёт вызывающий.
 */
export async function publishOwnTour(
  c: Pick<PoolClient, 'query'>,
  opts: { ownerId: string; tourId: string },
): Promise<PublishResult> {
  const row = await lockOwn(c, opts.ownerId, opts.tourId);
  if (!row) return { outcome: 'not_found' };
  if (row.on_storefront === true) return { outcome: 'already_on', title: row.title, slug: row.slug };
  const blockers = blockersOf(row.blockers);
  if (blockers.length > 0) return { outcome: 'blocked', title: row.title, blockers };
  const { rows } = await c.query<{ title: string; slug: string | null; on_storefront: boolean }>(
    `UPDATE operator_tours ot SET is_active = TRUE, is_published = TRUE, updated_at = NOW()
       FROM partners p
      WHERE ot.id = $2::bigint AND ot.operator_id = $1::uuid AND ot.deleted_at IS NULL
        AND p.id = ot.operator_id
        AND cardinality(${publishBlockersSql()}) = 0
      RETURNING ot.title, NULLIF(btrim(ot.slug), '') AS slug, ${publicTourSql('ot')} AS on_storefront`,
    [opts.ownerId, opts.tourId],
  );
  const done = rows[0];
  // Строка под блокировкой и гейт пройден строкой выше: сюда не доходит. Но
  // «опубликовал» без слова шлюза каталога не говорим — откат у вызывающего.
  if (!done || done.on_storefront !== true) throw new Error('публикация не подтверждена шлюзом каталога');
  return { outcome: 'published', title: done.title, slug: done.slug };
}

/** Снять с сайта — тур становится черновиком. Транзакцию даёт вызывающий. */
export async function unpublishOwnTour(
  c: Pick<PoolClient, 'query'>,
  opts: { ownerId: string; tourId: string },
): Promise<UnpublishResult> {
  const row = await lockOwn(c, opts.ownerId, opts.tourId);
  if (!row) return { outcome: 'not_found' };
  if (row.on_storefront !== true) return { outcome: 'already_off', title: row.title };
  const { rows } = await c.query<{ title: string; on_storefront: boolean }>(
    `UPDATE operator_tours ot SET is_published = FALSE, updated_at = NOW()
      WHERE ot.id = $2::bigint AND ot.operator_id = $1::uuid AND ot.deleted_at IS NULL
      RETURNING ot.title, ${publicTourSql('ot')} AS on_storefront`,
    [opts.ownerId, opts.tourId],
  );
  const done = rows[0];
  if (!done || done.on_storefront !== false) throw new Error('снятие не подтверждено шлюзом каталога');
  return { outcome: 'unpublished', title: done.title };
}

export type SetOnSite =
  | PublishResult
  | UnpublishResult
  | { outcome: 'db_error' };

/**
 * Кнопка «Опубликовать» / «Снять с сайта» — сайт и чат зовут ЭТУ функцию:
 * транзакция, запись, после COMMIT — пинг IndexNow. Отказ базы — свой исход,
 * в лог — шаг и SQLSTATE, без текста тура.
 */
export async function setOwnTourOnSite(opts: { ownerId: string; tourId: string; publish: boolean }): Promise<SetOnSite> {
  let out: PublishResult | UnpublishResult;
  try {
    out = await transaction<PublishResult | UnpublishResult>((c) => (opts.publish
      ? publishOwnTour(c, { ownerId: opts.ownerId, tourId: opts.tourId })
      : unpublishOwnTour(c, { ownerId: opts.ownerId, tourId: opts.tourId })));
  } catch (err) {
    console.error(`[own-tour-publish] ${opts.publish ? 'публикация' : 'снятие'} тура — отказ, SQLSTATE ${sqlstate(err)}`);
    return { outcome: 'db_error' };
  }
  if (out.outcome === 'published' || out.outcome === 'unpublished') pingTourChanged(opts.tourId);
  return out;
}
