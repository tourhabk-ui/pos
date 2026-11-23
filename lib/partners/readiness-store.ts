/**
 * Готовность партнёра: чтение фактов из базы (план готовности 23.11, этап 3c).
 *
 * Правило и слова — lib/partners/readiness.ts. Здесь три независимых чтения:
 * карточка, канал, содержимое. Отказ одного не роняет остальные и не выдаётся
 * за «нет»: пункт получает «не удалось проверить», причина — в логе с именем
 * чтения и SQLSTATE (§4.0). ПД в ответе нет по построению: только флаги и числа.
 */
import { pool } from '@/lib/db-pool';
import { publicPartnerSql } from '@/lib/partners/test-profile';
import { publicGuideWhere } from '@/lib/guides/visibility';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { publicAccommodationSql } from '@/lib/stay/moderation';
import { publicGearSql } from '@/lib/gear/moderation';
import { reachForPartner, requestsChannelStatus } from '@/lib/partners/reach';
import { isRentalPilotSlug } from '@/lib/rental/operator-pilot';
import {
  buildReadiness,
  type CardFacts, type ContentFacts, type PartnerReadiness, type ReadinessCategory,
} from '@/lib/partners/readiness';

interface Queryable {
  query: typeof pool.query;
}

function sqlstate(err: unknown): string {
  return (err as { code?: string })?.code ?? 'нет SQLSTATE';
}

interface CardRow {
  profile_status: string | null;
  onboarding_completed: boolean | null;
  is_test: boolean | null;
  on_storefront: boolean | null;
  slug: string | null;
}

/** Карточка: статус заявки, настройка, витрина — условием витрины своей роли. */
async function readCard(
  db: Queryable, partnerId: string, category: ReadinessCategory,
): Promise<{ card: CardFacts; slug: string | null } | null> {
  // Гид на витрине — это реестр гидов, и у него условие строже
  // (одобренный профиль, не приостановлен): lib/guides/visibility.
  const storefront = category === 'guide' ? publicGuideWhere('p') : publicPartnerSql('p');
  try {
    const { rows } = await db.query<CardRow>(
      `SELECT p.profile_status, p.onboarding_completed, p.is_test, p.slug,
              (${storefront}) AS on_storefront
         FROM partners p
        WHERE p.id = $1`,
      [partnerId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      card: {
        profileStatus: row.profile_status ?? 'none',
        onboardingCompleted: row.onboarding_completed === true,
        isTest: row.is_test === true,
        onStorefront: row.on_storefront === true,
      },
      slug: row.slug,
    };
  } catch (err) {
    console.error('[readiness] карточка партнёра не прочитана, SQLSTATE', sqlstate(err));
    return null;
  }
}

interface CountRow {
  total: number | string | null;
  live: number | string | null;
  pending: number | string | null;
}

const CONTENT_SQL: Record<ReadinessCategory, string> = {
  // Туры: «всего» — без удалённых; «на сайте» — шлюз витрины туров. Очереди
  // проверки у туров пока нет (этап 4 плана), поэтому pending = 0.
  operator: `
    SELECT COUNT(*) FILTER (WHERE ot.deleted_at IS NULL)::int AS total,
           COUNT(*) FILTER (WHERE ${publicTourSql('ot')})::int AS live,
           0::int AS pending
      FROM operator_tours ot
     WHERE ot.operator_id = $1`,
  // Свои туры гида лежат там же: operator_id — карточка гида (миграция 1338).
  guide: `
    SELECT COUNT(*) FILTER (WHERE ot.deleted_at IS NULL)::int AS total,
           COUNT(*) FILTER (WHERE ${publicTourSql('ot')})::int AS live,
           0::int AS pending
      FROM operator_tours ot
     WHERE ot.operator_id = $1`,
  stay: `
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE ${publicAccommodationSql('a')})::int AS live,
           COUNT(*) FILTER (WHERE a.moderation_status = 'pending')::int AS pending
      FROM accommodations a
     WHERE a.partner_id = $1`,
  gear: `
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE ${publicGearSql('gi')})::int AS live,
           COUNT(*) FILTER (WHERE gi.moderation_status = 'pending')::int AS pending
      FROM gear_items gi
     WHERE gi.partner_id = $1`,
  // Перевозчик на сайте — живая строка прайса на машину; у «Лагуны» рядом
  // прайс проката (тот же партнёр), он считается тоже. «На проверке» — новые
  // строки прайса, ждущие одобрения (черновик без price_id, миграция 1355).
  transfer: `
    SELECT (live.n + pending.n)::int AS total, live.n::int AS live, pending.n::int AS pending
      FROM (SELECT (SELECT COUNT(*) FROM transfer_charter_prices c WHERE c.partner_id = $1 AND c.is_active)
                 + (SELECT COUNT(*) FROM car_rental_offers o WHERE o.partner_id = $1 AND o.is_active) AS n) live,
           (SELECT COUNT(*) AS n FROM transfer_charter_price_edits e
             WHERE e.partner_id = $1 AND e.moderation_status = 'pending' AND e.price_id IS NULL) pending`,
  // Прокат: черновик правит только существующую строку (offer_id NOT NULL,
  // миграция 1327), новых строк из кабинета не бывает — pending = 0.
  cars: `
    SELECT COUNT(*) FILTER (WHERE o.is_active)::int AS total,
           COUNT(*) FILTER (WHERE o.is_active)::int AS live,
           0::int AS pending
      FROM car_rental_offers o
     WHERE o.partner_id = $1`,
};

async function readContent(db: Queryable, partnerId: string, category: ReadinessCategory): Promise<ContentFacts | null> {
  try {
    const { rows } = await db.query<CountRow>(CONTENT_SQL[category], [partnerId]);
    const row = rows[0];
    if (!row) return null;
    const n = (v: number | string | null) => Number(v ?? 0);
    return { total: n(row.total), live: n(row.live), pending: n(row.pending) };
  } catch (err) {
    console.error(`[readiness] содержимое (${category}) не прочитано, SQLSTATE`, sqlstate(err));
    return null;
  }
}

/**
 * Готовность партнёра по его карточке. Три чтения идут параллельно; ни одно
 * не бросает — «не прочитано» доходит до пункта словами.
 */
export async function readPartnerReadiness(
  ctx: { partnerId: string; category: ReadinessCategory; viewer: 'owner' | 'manager' },
  db: Queryable = pool,
): Promise<PartnerReadiness> {
  const [cardRead, reach, content] = await Promise.all([
    readCard(db, ctx.partnerId, ctx.category),
    reachForPartner(ctx.partnerId),
    readContent(db, ctx.partnerId, ctx.category),
  ]);
  return buildReadiness({
    category: ctx.category,
    viewer: ctx.viewer,
    card: cardRead?.card ?? null,
    channel: requestsChannelStatus(reach),
    content,
    canEditRental: isRentalPilotSlug(cardRead?.slug ?? null),
  });
}
