/**
 * Сторож: заявка хозяину жилья без своей брони (миграция 1206, решение
 * владельца 10.10: «для броней нужна удобная форма для приложения MAX»).
 *
 * Держит связку целиком: форма на карточке → публичный роут → строка
 * stay_requests с согласием в той же вставке → сообщение хозяину в MAX
 * (ПД только там, в Telegram — заглушка) → честный итог гостю из трёх
 * исходов. И то, что согласие называет настоящего получателя — владельца
 * жилья, а не туроператора.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  stayRequestTexts, nightsBetween, ruDate, MAX_REQUEST_NIGHTS,
  STAY_REQUESTS_ADMIN_PATH, ownerDeliveryLabel, platformDeliveryLabel,
} from '@/lib/stay/stay-request';
import {
  consentWording, buildConsentRecord,
  PD_CONSENT_TEXT, PD_CONSENT_VERSION, PD_CONSENT_STAY_TEXT, PD_CONSENT_STAY_VERSION,
} from '@/lib/legal/pd-consent';
import { isPublicApiPath } from '@/lib/auth/public-api-routes';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const ROUTE = read('app/api/accommodations/[id]/request/route.ts');
// Запись и доставка — общий путь формы и MCP (create_stay_request).
const SERVICE = read('lib/stay/stay-request-service.ts');
const FORM = read('components/stay/StayRequestForm.tsx');
const CARD = read('app/accommodations/[id]/_AccommodationDetailClient.tsx');

const msg = {
  accommodationName: 'Кутха',
  checkIn: '2026-11-03', checkOut: '2026-11-05', nights: 2, guests: 9,
  guestName: 'Иван <b>И.</b>', guestPhone: '+7 900 111-22-33', comment: 'Будем к <i>вечеру</i>',
  priceFrom: 24000, priceTo: 28000,
};

describe('сообщение хозяину', () => {
  it('ПД — в тексте для MAX, в заглушках для Telegram их нет', () => {
    const { text, ownerStub, platformStub } = stayRequestTexts(msg);
    expect(text).toContain('+7 900 111-22-33');
    for (const stub of [ownerStub, platformStub]) {
      expect(stub).not.toContain('+7 900 111-22-33');
      expect(stub).not.toContain('Иван');
      expect(stub).toContain('Заявка на жильё с Ведара: Кутха');
    }
  });

  // 10.10: владелец получил заглушку «Имя и телефон гостя — в MAX», а в MAX
  // ничего не было — заглушка уходит ровно тогда, когда MAX не сработал.
  it('заглушка не обещает «в MAX»: платформе — путь в админку, хозяину — как подключиться', () => {
    const { ownerStub, platformStub } = stayRequestTexts(msg);
    for (const stub of [ownerStub, platformStub]) expect(stub).not.toMatch(/телефон гостя — в MAX/);
    expect(platformStub).toMatch(/в админке, Жильё → «Заявки гостей»/);
    expect(ownerStub).toMatch(/в Telegram не передаются[\s\S]*подключите MAX/);
    expect(STAY_REQUESTS_ADMIN_PATH).toBe('/hub/admin/accommodations#requests');
  });

  it('ввод гостя экранирован: текст уходит как HTML', () => {
    const { text } = stayRequestTexts(msg);
    expect(text).not.toContain('<b>И.</b>');
    expect(text).toContain('&lt;b&gt;');
    expect(text).not.toContain('<i>вечеру</i>');
  });

  it('даты, ночи, гости и цена «от–до»; это не бронь', () => {
    const { text } = stayRequestTexts(msg);
    expect(text).toContain('Заезд: 03.11.2026 · Выезд: 05.11.2026 · ночей: 2');
    expect(text).toContain('Гостей: 9');
    expect(text).toMatch(/24\s000–28\s000 ₽/);
    expect(text).toMatch(/даты и цену подтверждаете вы/);
    expect(text).not.toMatch(/забронирован/i);
    expect(stayRequestTexts({ ...msg, priceFrom: null, priceTo: null }).text).not.toMatch(/Цена/);
  });

  it('ночи считаются между датами; обратный порядок — не даты', () => {
    expect(nightsBetween('2026-11-03', '2026-11-05')).toBe(2);
    expect(nightsBetween('2026-11-05', '2026-11-05')).toBeNull();
    expect(nightsBetween('2026-11-05', '2026-11-03')).toBeNull();
    expect(nightsBetween('x', '2026-11-03')).toBeNull();
    expect(ruDate('2026-11-03')).toBe('03.11.2026');
    expect(MAX_REQUEST_NIGHTS).toBe(60);
  });
});

describe('согласие называет настоящего получателя', () => {
  it('для жилья — владельцу жилья, своя версия; для тура — прежний текст', () => {
    expect(PD_CONSENT_STAY_TEXT).toMatch(/передачу владельцу жилья/);
    expect(PD_CONSENT_STAY_VERSION).not.toBe(PD_CONSENT_VERSION);
    expect(consentWording('stay')).toEqual({ text: PD_CONSENT_STAY_TEXT, version: PD_CONSENT_STAY_VERSION });
    expect(consentWording()).toEqual({ text: PD_CONSENT_TEXT, version: PD_CONSENT_VERSION });
    expect(buildConsentRecord(true, '1.2.3.4', 'stay-request', 'stay')?.version).toBe(PD_CONSENT_STAY_VERSION);
    expect(buildConsentRecord(true, '1.2.3.4', 'web-form')?.version).toBe(PD_CONSENT_VERSION);
  });

  it('форма показывает вариант «жильё» и шлёт состояние галочки', () => {
    expect(FORM).toMatch(/<PdConsentCheckbox[^>]*purpose="stay"/);
    expect(FORM).toMatch(/pd_consent: pdConsent/);
    expect(FORM).not.toMatch(/pd_consent:\s*true/);
    expect(FORM).toMatch(/if \(!pdConsent\)/);
    expect(FORM).toMatch(/disabled=\{sending \|\| !pdConsent\}/);
  });

  it('роут записывает согласие варианта «жильё» в той же вставке', () => {
    expect(ROUTE).toMatch(/pd_consent: z\.literal\(true/);
    expect(ROUTE).toMatch(/buildConsentRecord\(true, ip, 'stay-request', 'stay'\)/);
    expect(ROUTE).toMatch(/submitStayRequest\(\{[\s\S]{0,300}consent,\s*door: 'form'/);
    expect(SERVICE).toMatch(/INSERT INTO stay_requests[\s\S]{0,300}pd_consent_at/);
    // Согласие пишется только вставкой; UPDATE (1213) трогает лишь исход доставки.
    const updates = SERVICE.match(/UPDATE stay_requests[\s\S]*?WHERE/g) ?? [];
    expect(updates).toHaveLength(1);
    expect(updates[0]).not.toMatch(/pd_consent/);
    expect(updates[0]).toMatch(/SET owner_channel = \$2, owner_reason = \$3,\s*platform_channel = \$4, platform_reason = \$5,\s*delivery_recorded_at = NOW\(\)/);
  });
});

describe('роут: кто может принять заявку и куда она уходит', () => {
  it('аноним пускается только на POST', () => {
    expect(isPublicApiPath('/api/accommodations/0b1e5f5e-0000-0000-0000-000000000000/request', 'POST')).toBe(true);
    expect(isPublicApiPath('/api/accommodations/0b1e5f5e-0000-0000-0000-000000000000/request', 'DELETE')).toBe(false);
    // Бронь номера по-прежнему за входом.
    expect(isPublicApiPath('/api/accommodations/0b1e5f5e-0000-0000-0000-000000000000/book', 'POST')).toBe(false);
  });

  it('только объект «через владельца»: опубликован, есть телефон, нет своей брони и номеров', () => {
    expect(SERVICE).toMatch(/\$\{publicAccommodationSql\(a\)\}\s*AND \$\{a\}\.contact_phone IS NOT NULL\s*AND \$\{a\}\.external_booking_url IS NULL\s*AND NOT EXISTS \(\s*SELECT 1 FROM accommodation_rooms r/);
    expect(SERVICE).toMatch(/WHERE a\.id = \$1\s*AND \$\{stayRequestEligibleSql\('a'\)\}/);
    expect(ROUTE).toMatch(/createRateLimiter\(\{ windowMs: 60_000, max: 5 \}\)/);
  });

  it('хозяину — строго в его адрес, оператору платформы — всегда; три исхода', () => {
    expect(SERVICE).toMatch(/sendPdAlert\(\{ text, stub: ownerStub, buttons: \[card\], to: \{ maxChatId: obj\.max_chat_id, telegramChatId: obj\.telegram_chat_id \} \}\)/);
    expect(SERVICE).toMatch(/const adminRes = await sendPdAlert\(\{\s*text,\s*stub: platformStub,\s*buttons: \[card, \{ text: 'Заявки гостей', url: `\$\{base\}\$\{STAY_REQUESTS_ADMIN_PATH\}` \}\],\s*\}\)/);
    expect(SERVICE).toMatch(/ownerDelivered \? 'owner' : adminRes\.delivered \? 'platform' : 'none'/);
    // «Не дошло никому» — не успех.
    expect(ROUTE).toMatch(/delivered === 'none'[\s\S]{0,300}status: 502/);
    // Отказ базы не глушится.
    expect(SERVICE).toMatch(/SQLSTATE=/);
  });

  it('гостю — честный итог: хозяин или оператор платформы, не «забронировано»', () => {
    expect(FORM).toMatch(/done === 'owner'/);
    expect(FORM).toMatch(/оператор платформы/);
    expect(FORM).toMatch(/Это заявка, а не бронь/);
    expect(FORM).not.toMatch(/Забронировано/);
  });

  it('карточка рисует форму только у объекта без своей брони и без номеров', () => {
    expect(CARD).toMatch(/\{!data\.externalBookingUrl && data\.rooms\.length === 0 && \(\s*<div[^>]*>\s*<StayRequestForm accommodationId=\{data\.id\}/);
  });
  // Гость спросил «где MAX?» (10.10): кнопки по номеру в MAX не бывает, форма
  // и есть путь в MAX. Обещание «в MAX» — только при подключённом хозяине.
  it('«придёт в MAX» — только когда хозяин подключён; адрес чата наружу не уходит', () => {
    expect(CARD).toMatch(/<StayRequestForm [^>]*ownerOnMax=\{data\.ownerOnMax\}/);
    expect(FORM).toMatch(/\{ownerOnMax && \(\s*<p[^>]*>\s*Придёт владельцу сообщением в MAX/);
    const detail = read('lib/stay/accommodation-detail.ts');
    expect(detail).toMatch(/\(p\.max_chat_id IS NOT NULL\) as owner_on_max/);
    expect(detail).toMatch(/ownerOnMax: accommodation\.owner_on_max === true/);
    expect(detail).not.toMatch(/p\.max_chat_id(::text)? as /i);
  });
});

describe('куда дошла заявка — видно администратору (1213)', () => {
  const sql = read('migrations/1213_stay_request_delivery.sql').replace(/--[^\n]*/g, '');
  const API = read('app/api/admin/stay-requests/route.ts');
  const SECTION = read('app/hub/admin/accommodations/_StayRequestsSection.tsx');
  const PAGE = read('app/hub/admin/accommodations/_AccommodationModerationClient.tsx');

  it('миграция: дверь и два исхода из закрытых списков; исход пишется целиком', () => {
    expect(sql).toMatch(/CHECK \(door IS NULL OR door IN \('form', 'mcp'\)\)/);
    expect(sql).toMatch(/CHECK \(owner_channel IS NULL OR owner_channel IN \('max', 'telegram-stub', 'none', 'no_address'\)\)/);
    expect(sql).toMatch(/CHECK \(platform_channel IS NULL OR platform_channel IN \('max', 'telegram-stub', 'none'\)\)/);
    expect(sql).toMatch(/delivery_recorded_at IS NULL AND owner_channel IS NULL AND platform_channel IS NULL\)\s*OR \(delivery_recorded_at IS NOT NULL AND owner_channel IS NOT NULL AND platform_channel IS NOT NULL/);
  });

  it('сервис: дверь — во вставке, исход — после обеих отправок, отказ записи слышен', () => {
    expect(SERVICE).toMatch(/pd_consent_version, door\)\s*VALUES \(\$1, [^)]*\$12\)/);
    expect(SERVICE).toMatch(/i\.consent\.version, i\.door,/);
    const send = SERVICE.indexOf('const adminRes = await sendPdAlert');
    const record = SERVICE.indexOf('await recordStayDelivery(requestId');
    expect(send).toBeGreaterThan(0);
    expect(record).toBeGreaterThan(send);
    expect(SERVICE).toMatch(/let ownerChannel: StayOwnerChannel = 'no_address'/);
    expect(SERVICE).toMatch(/исход доставки не записан:[\s\S]{0,120}SQLSTATE=/);
  });

  it('роут: только администратор, отказ базы — 503, а не пустой список', () => {
    expect(API).toMatch(/const authOrResponse = await requireAdmin\(request\)/);
    expect(API).toMatch(/FROM stay_requests r/);
    expect(API).toMatch(/status: 503/);
    expect(API).not.toMatch(/max_chat_id AS|max_chat_id::text/);
  });

  it('вкладка на странице жилья; ПД под Sensitive; не записанный исход — «не записан», не «не дошло»', () => {
    expect(PAGE).toMatch(/<StayRequestsSection \/>/);
    expect(SECTION).toMatch(/id="requests"/);
    expect(SECTION).toMatch(/<Sensitive className="text-\[var\(--text-primary\)\]">\{r\.guestName\}<\/Sensitive>/);
    expect(SECTION).toMatch(/<Sensitive>\{r\.guestPhone\}<\/Sensitive>/);
    expect(ownerDeliveryLabel(null)).toEqual({ text: 'Исход для хозяина не записан', ok: null });
    expect(platformDeliveryLabel(null).ok).toBeNull();
    expect(ownerDeliveryLabel('max').ok).toBe(true);
    expect(ownerDeliveryLabel('no_address').text).toMatch(/не подключён к боту/);
    expect(platformDeliveryLabel('telegram-stub').text).toMatch(/MAX не сработал/);
  });
});

describe('миграция 1206: партнёр «Кутха» и таблица заявок', () => {
  const sql = read('migrations/1206_stay_requests.sql').replace(/--[^\n]*/g, '');

  it('партнёр — жильё, не в публичном каталоге, без slug; только объекту без партнёра', () => {
    expect(sql).toMatch(/INSERT INTO partners \(name, category, contact, is_public, is_verified, rating\)/);
    expect(sql).toMatch(/'Кутха', 'stay', jsonb_build_object\('phone', a\.contact_phone\), FALSE, FALSE, NULL/);
    expect(sql).not.toMatch(/slug/);
    expect(sql).toMatch(/AND a\.partner_id IS NULL/);
  });

  it('согласие обязательно и рядом с заявкой; даты по порядку', () => {
    for (const col of ['pd_consent_at', 'pd_consent_ip', 'pd_consent_source', 'pd_consent_version']) {
      expect(sql).toMatch(new RegExp(`${col}\\s+\\S+(\\(\\d+\\))?\\s+NOT NULL`));
    }
    expect(sql).toMatch(/CHECK \(check_out_date > check_in_date\)/);
  });
});

describe('миграция 1207: снимок владельца платформы', () => {
  const sql = read('migrations/1207_kutha_owner_photo.sql');

  it('файл в репозитории, sha256 и размер от него, без EXIF, подпись автора', () => {
    const path = join(ROOT, 'public/images/kutha/kutha-21.jpg');
    expect(existsSync(path)).toBe(true);
    const buf = readFileSync(path);
    expect(sql).toContain(createHash('sha256').update(buf).digest('hex'));
    expect(sql).toContain(String(buf.length));
    expect(buf.includes(Buffer.from('Exif\0\0'))).toBe(false);
    expect(sql).toMatch(/Фото: Андрей/);
  });

  it('старая доска с ценами не попала: только один снимок', () => {
    expect(sql.match(/\/images\/kutha\/kutha-\d+\.jpg/g)?.every((u) => u === '/images/kutha/kutha-21.jpg')).toBe(true);
  });
});
