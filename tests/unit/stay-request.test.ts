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
import { stayRequestTexts, nightsBetween, ruDate, MAX_REQUEST_NIGHTS } from '@/lib/stay/stay-request';
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
  it('ПД — в тексте для MAX, в заглушке для Telegram их нет', () => {
    const { text, stub } = stayRequestTexts(msg);
    expect(text).toContain('+7 900 111-22-33');
    expect(stub).not.toContain('+7 900 111-22-33');
    expect(stub).not.toContain('Иван');
    expect(stub).toMatch(/Имя и телефон гостя — в MAX/);
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
    expect(SERVICE).not.toMatch(/UPDATE stay_requests/);
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
    expect(SERVICE).toMatch(/sendPdAlert\(\{ text, stub, buttons, to: \{ maxChatId: obj\.max_chat_id, telegramChatId: obj\.telegram_chat_id \} \}\)/);
    expect(SERVICE).toMatch(/const adminRes = await sendPdAlert\(\{ text, stub, buttons \}\)/);
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
