/**
 * Перевозчики «под заказ»: прайс на целую машину (миграция 1185).
 *
 * Поездка (lib/transfers/service) — это машина, дата и места. У части
 * перевозчиков другое: дат нет, машина идёт целиком по прайсу, и направление с
 * днями задаёт заказчик. Этот модуль — единственное место, где читается такой
 * прайс: экран /transfers, карточка перевозчика /operators/[slug], Кузьмич и
 * MCP берут цены отсюда и больше ниоткуда. Второй экземпляр цены (в
 * `partners.services` или в тексте) разошёлся бы с первым — так уже было с
 * карточкой тура (§11).
 *
 * Цена — за МАШИНУ. «За место» здесь не считается нигде: делить на вместимость
 * значило бы придумать цифру, которой в прайсе нет (§4.0).
 *
 * Читатель, которому прайс нужен для ответа человеку, различает три исхода:
 * нашли (массив с элементами), искали и никого нет (пустой массив), не смогли
 * проверить (исключение — его ловит вызывающий и говорит об этом вслух).
 */
import { query } from '@/lib/database';
import { extractGallery, telegramContactHref } from '@/lib/operators/profile-parse';
import { normalizeContactPhone } from '@/lib/stay/contact-phone';
import { videoSrc } from '@/lib/media/video-url';
import { sortRates } from '@/lib/transfers/charter-format';
import type {
  CarrierLicense, CarrierProfile, CharterCarrier, CharterClip, CharterLegal, CharterPhoto, CharterVehicleKind,
} from '@/lib/transfers/charter-format';

export * from '@/lib/transfers/charter-format';

interface PartnerRow {
  id: string;
  slug: string;
  name: string;
  short_description: string | null;
  logo_image: string | null;
  hero_image: string | null;
  gallery: unknown;
  video_url: string | null;
  video_poster_url: string | null;
  gallery_credits: unknown;
  video_clips: unknown;
  legal_info: unknown;
  contacts: unknown;
  /** Вместимости парка без привязки к машине (1292); NULL — не записаны. */
  fleet_seat_classes: unknown;
}

/** Колонки партнёра, которые разбирает toCharterCarrier; один список на оба загрузчика. */
const PARTNER_COLUMNS = `p.id::text AS id, p.slug, p.name, p.short_description, p.logo_image, p.hero_image, p.gallery, p.video_url, p.video_poster_url, p.gallery_credits, p.video_clips, p.legal_info, p.contacts, p.fleet_seat_classes`;

interface PriceRow {
  partner_id: string;
  vehicle_kind: CharterVehicleKind;
  /** 'per_hour' / 'per_day' — цена за время работы машины без направления (1292). */
  line_kind: 'destination' | 'extra_day' | 'per_hour' | 'per_day';
  from_text: string | null;
  to_text: string | null;
  price_rub: number;
  price_note: string | null;
  conditions: string | null;
  valid_year: number | null;
  /** Связанное место (1232); null — не связано или скрыто. */
  place_id: string | null;
  place_slug: string | null;
  place_name: string | null;
}

interface VehicleRow {
  partner_id: string;
  kind: CharterVehicleKind;
  title: string;
  /** NULL — число мест не записано (1292). */
  seats: number | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const CLIP_URL = /^\/video\/[a-z0-9/._-]+\.(mp4|webm)$/;
const CLIP_POSTER = /^\/video\/[a-z0-9/._-]+\.(jpg|webp)$/;

/**
 * Снимки с подписями. Подпись берётся из карты только для снимка, который
 * есть в галерее, и только непустая строка: лишний ключ или мусор в карте —
 * не повод подписать чужим именем не тот кадр. Нет подписи — null, и экран
 * подписывает кадр самим перевозчиком, как раньше.
 */
export function parsePhotos(urls: string[], credits: unknown): CharterPhoto[] {
  const map = asRecord(credits) ?? {};
  return urls.map((url) => {
    const c = map[url];
    return { url, credit: typeof c === 'string' && c.trim() ? c.trim() : null };
  });
}

/**
 * Клипы: только с адресом из /video/ и обложкой оттуда же. Клип без обложки
 * не показывается — ленивый плеер без кадра на мобильной сети это чёрный
 * прямоугольник. Без подписи — подставляется имя перевозчика (скринридеру
 * нужно хоть что-то), но выдуманного описания не бывает.
 */
export function parseClips(raw: unknown, fallbackLabel: string): CharterClip[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): CharterClip[] => {
    const r = asRecord(item);
    if (!r) return [];
    const url = typeof r.url === 'string' ? r.url : '';
    const poster = typeof r.poster === 'string' ? r.poster : '';
    if (!CLIP_URL.test(url) || !CLIP_POSTER.test(poster)) return [];
    const label = typeof r.label === 'string' && r.label.trim() ? r.label.trim() : fallbackLabel;
    return [{ url, poster, label }];
  });
}

/**
 * Исполнитель по договору — по правилу карточки тура (lib/tours/tour-detail-query):
 * наименование ТОЛЬКО из legal_info.companyName. partners.company_name не
 * подходит: триггер 052 (sync_partner_company_name) держит его равным витринному
 * name, и «исполнителем» стала бы вывеска. Так 13.10 и вышло наоборот: миграция
 * 1187 записала «ИП Миронова» в company_name, триггер переименовал «Шатуна» в ИП,
 * а владелец попросил вывеску «Шатун» и ИП — исполнителем (миграция 1233).
 *
 * ИНН и ОГРН — только по форме (10/12 и 13/15 цифр): мусор в записи не должен
 * выглядеть реквизитом. Нет ни одного поля — null, и экран говорит «не
 * записаны», как карточка тура.
 */
export function parseLegal(legalInfo: unknown): CharterLegal | null {
  const rec = asRecord(legalInfo);
  if (!rec) return null;
  const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
  const name = text(rec.companyName).trim() || null;
  const rawInn = text(rec.inn).replace(/\s/g, '');
  const rawOgrn = text(rec.ogrn).replace(/\s/g, '');
  const inn = /^(\d{10}|\d{12})$/.test(rawInn) ? rawInn : null;
  const ogrn = /^(\d{13}|\d{15})$/.test(rawOgrn) ? rawOgrn : null;
  return name || inn || ogrn ? { name, inn, ogrn } : null;
}

/**
 * Лицензия из legal_info.license — двумя формами, как их пишут миграции:
 * объект выписки из реестра (1292: номер, дата, орган, статус на дату выписки)
 * или слово «есть» без номера (1187). Объект без номера — не лицензия по
 * выписке, а мусор: такой не показывается. Дата — только YYYY-MM-DD.
 */
export function parseLicense(legalInfo: unknown): CarrierLicense | null {
  const raw = asRecord(legalInfo)?.license;
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'есть' ? { kind: 'words' } : null;
  const rec = asRecord(raw);
  if (!rec) return null;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const date = (v: unknown): string | null => {
    const s = str(v);
    return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  };
  const number = str(rec.number);
  if (!number) return null;
  return {
    kind: 'registry',
    number,
    issuedOn: date(rec.issuedOn),
    authority: str(rec.authority),
    status: str(rec.registryStatus),
    checkedOn: date(rec.registryCheckedOn),
  };
}

/**
 * Вместимости парка без привязки к машине (partners.fleet_seat_classes, 1292):
 * «есть на 12 и на 24 места». Только целые больше нуля, без повторов, по
 * возрастанию; не массив или мусор — [] («не записаны»), а не выдуманная цифра.
 */
export function parseSeatClasses(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const seats = raw.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0);
  return [...new Set(seats)].sort((a, b) => a - b);
}

/**
 * Страхование пассажиров из legal_info.passengerInsurance. Записано только
 * «со слов перевозчика» (1292) — это и узнаётся; полиса с номером платформа
 * не видела, и другого исхода, кроме «не записано», здесь нет.
 */
export function parsePassengerInsurance(legalInfo: unknown): 'words' | null {
  const raw = asRecord(legalInfo)?.passengerInsurance;
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'со слов перевозчика' ? 'words' : null;
}

/**
 * Каналы перевозчика из `partners.contacts` (форма «объект каналов»). Телефон
 * проходит ту же проверку формата, что и номер жилья (один разбор номера на
 * платформу): мусор не станет tel:-ссылкой. WhatsApp — wa.me по цифрам; Telegram — как у оператора
 * (ник либо t.me/+номер). Нет поля — null, а не выдуманная ссылка.
 */
export function charterContacts(raw: unknown): { phone: string | null; telegramHref: string | null; whatsappHref: string | null } {
  const o = asRecord(raw);
  if (!o) return { phone: null, telegramHref: null, whatsappHref: null };
  const wa = typeof o.whatsapp === 'string' ? o.whatsapp.replace(/\D/g, '') : '';
  return {
    phone: normalizeContactPhone(o.phone),
    telegramHref: telegramContactHref(o.telegram_contact) || null,
    whatsappHref: /^\d{10,15}$/.test(wa) ? `https://wa.me/${wa}` : null,
  };
}

/** Прайс и парк для набора перевозчиков — один запрос на оба загрузчика. */
async function loadPricesAndFleet(ids: string[]): Promise<{ prices: PriceRow[]; vehicles: VehicleRow[] }> {
  const [prices, vehicles] = await Promise.all([
    // Место — только видимое: скрытое отвечает 404, и ссылка на него хуже,
    // чем направление словами.
    query<PriceRow>(
      `SELECT c.partner_id::text AS partner_id, c.vehicle_kind, c.line_kind, c.from_text, c.to_text,
              c.price_rub, c.price_note, c.conditions, c.valid_year,
              pl.id AS place_id, pl.slug AS place_slug, pl.name AS place_name
         FROM transfer_charter_prices c
         LEFT JOIN places pl ON pl.id = c.place_id AND pl.is_visible = TRUE
        WHERE c.is_active AND c.partner_id::text = ANY($1::text[])
        ORDER BY c.sort_order, c.to_text`,
      [ids],
    ),
    query<VehicleRow>(
      `SELECT partner_id::text AS partner_id, kind, title, seats
         FROM transfer_fleet_vehicles
        WHERE is_active AND partner_id::text = ANY($1::text[])
        ORDER BY title`,
      [ids],
    ),
  ]);
  return { prices: prices.rows, vehicles: vehicles.rows };
}

/** Строка партнёра + его прайс и парк → перевозчик. Один разбор на все экраны. */
function toCharterCarrier(p: PartnerRow, prices: PriceRow[], vehicles: VehicleRow[]): CharterCarrier {
  const mine = prices.filter((r) => r.partner_id === p.id);
  const extra = mine.find((r) => r.line_kind === 'extra_day');
  const photos = [p.hero_image, ...extractGallery(p.gallery)].filter(
    (u, i, all): u is string => typeof u === 'string' && u.length > 0 && all.indexOf(u) === i,
  );
  return {
    partnerId: p.id,
    slug: p.slug,
    name: p.name,
    shortDescription: p.short_description,
    logo: p.logo_image ? p.logo_image : null,
    vehicles: vehicles
      .filter((v) => v.partner_id === p.id)
      .map((v) => ({ kind: v.kind, title: v.title, seats: v.seats })),
    seatClasses: parseSeatClasses(p.fleet_seat_classes),
    destinations: mine
      .filter((r) => r.line_kind === 'destination' && r.from_text && r.to_text)
      .map((r) => ({
        from: r.from_text as string,
        to: r.to_text as string,
        priceRub: r.price_rub,
        note: r.price_note,
        conditions: r.conditions,
        validYear: r.valid_year,
        place: r.place_id && r.place_name
          ? { id: r.place_id, href: `/places/${r.place_slug ?? r.place_id}`, name: r.place_name }
          : null,
      })),
    extraDay: extra
      ? { priceRub: extra.price_rub, note: extra.price_note, conditions: extra.conditions, validYear: extra.valid_year }
      : null,
    rates: sortRates(mine.flatMap((r) => (r.line_kind === 'per_hour' || r.line_kind === 'per_day'
      ? [{
        unit: r.line_kind === 'per_hour' ? 'hour' as const : 'day' as const,
        vehicleKind: r.vehicle_kind,
        priceRub: r.price_rub,
        note: r.price_note,
        conditions: r.conditions,
        validYear: r.valid_year,
      }]
      : []))),
    photos: parsePhotos(photos, p.gallery_credits),
    // В базе — пути /video/...; файлы с 09.10 в хранилище, и страница
    // получает адрес объекта там (lib/media/video-url), а не круг через
    // переадресацию /video/[...path].
    clips: parseClips(p.video_clips, `Видео: ${p.name}`)
      .map((c) => ({ ...c, url: videoSrc(c.url), poster: videoSrc(c.poster) })),
    legal: parseLegal(p.legal_info),
    // Ролик без обложки не показывается: база такого не допускает (CHECK
    // partners_video_shape), но экран не должен верить только базе.
    video: p.video_url && p.video_poster_url
      ? { url: videoSrc(p.video_url), poster: videoSrc(p.video_poster_url) }
      : null,
    ...charterContacts(p.contacts),
  };
}

/**
 * Перевозчики с живым прайсом; partnerId — только один из них. Порядок — по
 * алфавиту, тем же правилом, что список компаний (`lower(name)`, затем id для
 * устойчивости): общая витрина, и правило названо на ней словами (§0).
 */
export async function loadCharterCarriers(opts: { partnerId?: string } = {}): Promise<CharterCarrier[]> {
  const partners = await query<PartnerRow>(
    `SELECT ${PARTNER_COLUMNS}
       FROM partners p
      WHERE p.is_public = TRUE
        AND p.slug IS NOT NULL
        AND ($1::text IS NULL OR p.id::text = $1::text)
        AND EXISTS (
          SELECT 1 FROM transfer_charter_prices c WHERE c.partner_id = p.id AND c.is_active
        )
      ORDER BY lower(p.name), p.id`,
    [opts.partnerId ?? null],
  );
  if (partners.rows.length === 0) return [];

  const { prices, vehicles } = await loadPricesAndFleet(partners.rows.map((p) => p.id));
  return partners.rows.map((p) => toCharterCarrier(p, prices, vehicles));
}

/**
 * Перевозчик для страницы /transfers/[slug]: публичный партнёр категории
 * transfer. Прайса может не быть — страница тогда честно без него. null —
 * такого перевозчика нет (страница отвечает 404); отказ базы — исключение,
 * его ловит страница и говорит вслух (§4.0).
 */
export async function loadCarrierBySlug(slug: string): Promise<CarrierProfile | null> {
  const partner = await query<PartnerRow & { is_verified: boolean | null; description: string | null }>(
    `SELECT ${PARTNER_COLUMNS}, p.is_verified, p.description
       FROM partners p
      WHERE p.slug = $1
        AND p.is_public = TRUE
        AND p.category = 'transfer'
      LIMIT 1`,
    [slug],
  );
  const p = partner.rows[0];
  if (!p) return null;
  const { prices, vehicles } = await loadPricesAndFleet([p.id]);
  return {
    ...toCharterCarrier(p, prices, vehicles),
    verified: p.is_verified === true,
    description: p.description,
    license: parseLicense(p.legal_info),
    passengerInsurance: parsePassengerInsurance(p.legal_info),
  };
}
