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
import type { CharterCarrier, CharterClip, CharterLegal, CharterPhoto, CharterVehicleKind } from '@/lib/transfers/charter-format';

export * from '@/lib/transfers/charter-format';

interface PartnerRow {
  id: string;
  slug: string;
  name: string;
  short_description: string | null;
  hero_image: string | null;
  gallery: unknown;
  video_url: string | null;
  video_poster_url: string | null;
  gallery_credits: unknown;
  video_clips: unknown;
  company_name: string | null;
  legal_info: unknown;
  contacts: unknown;
}

interface PriceRow {
  partner_id: string;
  vehicle_kind: CharterVehicleKind;
  line_kind: 'destination' | 'extra_day';
  from_text: string | null;
  to_text: string | null;
  price_rub: number;
  price_note: string | null;
  conditions: string | null;
  valid_year: number | null;
}

interface VehicleRow {
  partner_id: string;
  kind: CharterVehicleKind;
  title: string;
  seats: number;
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
 * Исполнитель по договору. Название — из company_name, запасное — из
 * legal_info.companyName; нет названия — реквизитов для показа нет вовсе (один
 * ИНН без имени человеку ничего не говорит). ИНН — только по форме (10 или 12
 * цифр): мусор в колонке не должен выглядеть реквизитом.
 */
export function parseLegal(companyName: string | null, legalInfo: unknown): CharterLegal | null {
  const rec = asRecord(legalInfo);
  const fromInfo = rec && typeof rec.companyName === 'string' ? rec.companyName.trim() : '';
  const name = (companyName ?? '').trim() || fromInfo;
  if (!name) return null;
  const rawInn = rec && typeof rec.inn === 'string' ? rec.inn.replace(/\s/g, '') : '';
  return { name, inn: /^(\d{10}|\d{12})$/.test(rawInn) ? rawInn : null };
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

/** Перевозчики с живым прайсом; partnerId — только один из них. */
export async function loadCharterCarriers(opts: { partnerId?: string } = {}): Promise<CharterCarrier[]> {
  const partners = await query<PartnerRow>(
    `SELECT p.id::text AS id, p.slug, p.name, p.short_description, p.hero_image, p.gallery, p.video_url, p.video_poster_url, p.gallery_credits, p.video_clips, p.company_name, p.legal_info, p.contacts
       FROM partners p
      WHERE p.is_public = TRUE
        AND p.slug IS NOT NULL
        AND ($1::text IS NULL OR p.id::text = $1::text)
        AND EXISTS (
          SELECT 1 FROM transfer_charter_prices c WHERE c.partner_id = p.id AND c.is_active
        )
      ORDER BY p.name`,
    [opts.partnerId ?? null],
  );
  if (partners.rows.length === 0) return [];

  const ids = partners.rows.map((p) => p.id);
  const [prices, vehicles] = await Promise.all([
    query<PriceRow>(
      `SELECT partner_id::text AS partner_id, vehicle_kind, line_kind, from_text, to_text,
              price_rub, price_note, conditions, valid_year
         FROM transfer_charter_prices
        WHERE is_active AND partner_id::text = ANY($1::text[])
        ORDER BY sort_order, to_text`,
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

  return partners.rows.map((p): CharterCarrier => {
    const mine = prices.rows.filter((r) => r.partner_id === p.id);
    const extra = mine.find((r) => r.line_kind === 'extra_day');
    const photos = [p.hero_image, ...extractGallery(p.gallery)].filter(
      (u, i, all): u is string => typeof u === 'string' && u.length > 0 && all.indexOf(u) === i,
    );
    return {
      partnerId: p.id,
      slug: p.slug,
      name: p.name,
      shortDescription: p.short_description,
      vehicles: vehicles.rows
        .filter((v) => v.partner_id === p.id)
        .map((v) => ({ kind: v.kind, title: v.title, seats: v.seats })),
      destinations: mine
        .filter((r) => r.line_kind === 'destination' && r.from_text && r.to_text)
        .map((r) => ({
          from: r.from_text as string,
          to: r.to_text as string,
          priceRub: r.price_rub,
          note: r.price_note,
          conditions: r.conditions,
          validYear: r.valid_year,
        })),
      extraDay: extra
        ? { priceRub: extra.price_rub, note: extra.price_note, conditions: extra.conditions, validYear: extra.valid_year }
        : null,
      photos: parsePhotos(photos, p.gallery_credits),
      // В базе — пути /video/...; файлы с 09.10 в хранилище, и страница
      // получает адрес объекта там (lib/media/video-url), а не круг через
      // переадресацию /video/[...path].
      clips: parseClips(p.video_clips, `Видео: ${p.name}`)
        .map((c) => ({ ...c, url: videoSrc(c.url), poster: videoSrc(c.poster) })),
      legal: parseLegal(p.company_name, p.legal_info),
      // Ролик без обложки не показывается: база такого не допускает (CHECK
      // partners_video_shape), но экран не должен верить только базе.
      video: p.video_url && p.video_poster_url
        ? { url: videoSrc(p.video_url), poster: videoSrc(p.video_poster_url) }
        : null,
      ...charterContacts(p.contacts),
    };
  });
}
