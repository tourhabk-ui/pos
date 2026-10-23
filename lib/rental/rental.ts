/**
 * Прокат автомобилей: прайс за сутки за машину без водителя (схема 1317,
 * решение владельца 23.10 «пока берем аренду автомобилей и трансфер»).
 *
 * Единственное место, где читается прайс проката: витрина /car-rental,
 * страница прокатчика, планер («Машина напрокат»), сайтмап берут цены отсюда
 * и больше ниоткуда. Второй экземпляр цены разошёлся бы с первым — так уже
 * было с карточкой тура (§11).
 *
 * Прокатчик — тот, у кого есть живая строка прайса проката, а не тот, у кого
 * `category = 'cars'`: «Лагуна Прокат» заведена перевозчиком (category
 * `transfer`) и стоит на двух витринах — машина с водителем целиком и машина
 * без водителя за сутки. Род товара здесь задаёт таблица, не карточка.
 *
 * Читатель различает три исхода: нашли (массив с элементами), искали и никого
 * нет (пустой массив), не смогли проверить (исключение — его ловит вызывающий
 * и говорит об этом вслух, §4.0).
 */
import { query } from '@/lib/database';
import { extractGallery } from '@/lib/operators/profile-parse';
import { charterContacts, parseLegal, parsePhotos } from '@/lib/transfers/charter';
import type {
  RentalBodyKind, RentalCompany, RentalCompanyProfile, RentalDrive, RentalDriver, RentalOffer, RentalTerms,
  RentalTransmission,
} from '@/lib/rental/rental-format';

export * from '@/lib/rental/rental-format';

interface PartnerRow {
  id: string;
  slug: string;
  name: string;
  short_description: string | null;
  hero_image: string | null;
  gallery: unknown;
  gallery_credits: unknown;
  contacts: unknown;
}

const PARTNER_COLUMNS = `p.id::text AS id, p.slug, p.name, p.short_description, p.hero_image, p.gallery, p.gallery_credits, p.contacts`;

/** Живой прайс проката у партнёра — один предикат на витрину, страницу и сайтмап. */
export const HAS_ACTIVE_RENTAL_OFFERS_SQL = (alias: string) =>
  `EXISTS (SELECT 1 FROM car_rental_offers o WHERE o.partner_id = ${alias}.id AND o.is_active)`;

interface OfferRow {
  id: string;
  partner_id: string;
  title: string;
  body_kind: RentalBodyKind;
  seats: number | null;
  transmission: RentalTransmission | null;
  drive: RentalDrive | null;
  engine_hp: number | null;
  price_rub_per_day: number;
  price_is_from: boolean;
  deposit_rub: number | null;
  driver: RentalDriver;
  conditions: string | null;
  source_url: string | null;
  /** DATE отдаётся текстом (::text), чтобы не зависеть от часового пояса драйвера. */
  prices_seen_on: string | null;
}

interface TermsRow {
  items: string[] | null;
  source_url: string | null;
  seen_on: string | null;
}

async function loadOffers(ids: string[]): Promise<OfferRow[]> {
  const { rows } = await query<OfferRow>(
    `SELECT o.id::text AS id, o.partner_id::text AS partner_id, o.title, o.body_kind, o.seats, o.transmission,
            o.drive, o.engine_hp, o.price_rub_per_day, o.price_is_from, o.deposit_rub, o.driver, o.conditions,
            o.source_url, o.prices_seen_on::text AS prices_seen_on
       FROM car_rental_offers o
      WHERE o.is_active AND o.partner_id::text = ANY($1::text[])
      ORDER BY o.sort_order, o.price_rub_per_day, o.title`,
    [ids],
  );
  return rows;
}

function toOffer(r: OfferRow): RentalOffer {
  return {
    id: r.id,
    title: r.title,
    bodyKind: r.body_kind,
    seats: r.seats,
    transmission: r.transmission,
    drive: r.drive,
    engineHp: r.engine_hp,
    priceRubPerDay: r.price_rub_per_day,
    priceIsFrom: r.price_is_from === true,
    depositRub: r.deposit_rub,
    driver: r.driver,
    conditions: r.conditions,
    sourceUrl: r.source_url,
    pricesSeenOn: r.prices_seen_on,
  };
}

/** Строка партнёра + его прайс → прокатчик. Один разбор на все экраны. */
function toRentalCompany(p: PartnerRow, offers: OfferRow[]): RentalCompany {
  const photos = [p.hero_image, ...extractGallery(p.gallery)].filter(
    (u, i, all): u is string => typeof u === 'string' && u.length > 0 && all.indexOf(u) === i,
  );
  const contacts = charterContacts(p.contacts);
  return {
    partnerId: p.id,
    slug: p.slug,
    name: p.name,
    shortDescription: p.short_description,
    photos: parsePhotos(photos, p.gallery_credits),
    offers: offers.filter((o) => o.partner_id === p.id).map(toOffer),
    phone: contacts.phone,
    telegramHref: contacts.telegramHref,
  };
}

/**
 * Прокатчики с живым прайсом. Порядок — по алфавиту, тем же правилом, что
 * список компаний и перевозчиков (`lower(name)`, затем id для устойчивости):
 * общая витрина, и правило названо на ней словами (§0).
 */
export async function loadRentalCompanies(): Promise<RentalCompany[]> {
  const partners = await query<PartnerRow>(
    `SELECT ${PARTNER_COLUMNS}
       FROM partners p
      WHERE p.is_public = TRUE
        AND p.slug IS NOT NULL
        AND ${HAS_ACTIVE_RENTAL_OFFERS_SQL('p')}
      ORDER BY lower(p.name), p.id`,
  );
  if (partners.rows.length === 0) return [];
  const offers = await loadOffers(partners.rows.map((p) => p.id));
  return partners.rows.map((p) => toRentalCompany(p, offers));
}

/** Условия проката из строки базы: пустой или кривой массив — «не записаны». */
export function parseTerms(row: TermsRow | undefined): RentalTerms | null {
  if (!row || !Array.isArray(row.items)) return null;
  const items = row.items.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim());
  if (items.length === 0) return null;
  return {
    items,
    sourceUrl: row.source_url,
    seenOn: row.seen_on && /^\d{4}-\d{2}-\d{2}$/.test(row.seen_on) ? row.seen_on : null,
  };
}

/**
 * Прокатчик для страницы /car-rental/[slug]: публичный партнёр со slug и живым
 * прайсом проката — тот же предикат, что у витрины. null — такого прокатчика
 * нет (страница отвечает 404); отказ базы — исключение, его ловит страница и
 * говорит вслух (§4.0).
 */
export async function loadRentalCompanyBySlug(slug: string): Promise<RentalCompanyProfile | null> {
  const partner = await query<PartnerRow & {
    is_verified: boolean | null;
    description: string | null;
    legal_info: unknown;
    terms_items: string[] | null;
    terms_source_url: string | null;
    terms_seen_on: string | null;
    also_carrier: boolean | null;
  }>(
    `SELECT ${PARTNER_COLUMNS}, p.is_verified, p.description, p.legal_info,
            t.items AS terms_items, t.source_url AS terms_source_url, t.seen_on::text AS terms_seen_on,
            EXISTS (
              SELECT 1 FROM transfer_charter_prices c WHERE c.partner_id = p.id AND c.is_active
            ) AS also_carrier
       FROM partners p
       LEFT JOIN car_rental_terms t ON t.partner_id = p.id
      WHERE p.slug = $1
        AND p.is_public = TRUE
        AND ${HAS_ACTIVE_RENTAL_OFFERS_SQL('p')}
      LIMIT 1`,
    [slug],
  );
  const p = partner.rows[0];
  if (!p) return null;
  const offers = await loadOffers([p.id]);
  return {
    ...toRentalCompany(p, offers),
    description: p.description,
    verified: p.is_verified === true,
    legal: parseLegal(p.legal_info),
    terms: parseTerms({ items: p.terms_items, source_url: p.terms_source_url, seen_on: p.terms_seen_on }),
    alsoCarrier: p.also_carrier === true,
  };
}

/**
 * Есть ли у партнёра живой прайс проката — для страницы перевозчика: ссылка
 * «машины без водителя у этого партнёра». Три исхода у вызывающего: есть / нет /
 * не смогли (исключение).
 */
export async function partnerHasRentalOffers(partnerId: string): Promise<boolean> {
  const { rows } = await query<{ has: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM car_rental_offers o WHERE o.partner_id::text = $1 AND o.is_active) AS has`,
    [partnerId],
  );
  return rows[0]?.has === true;
}
