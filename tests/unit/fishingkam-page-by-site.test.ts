/**
 * «Камчатская рыбалка» на Ведаре — по данным их сайта (владелец 29.09:
 * «у нас тоже поменяй ссылки на тг, вацап и мах», «переделать отдельную
 * страницу», «приведи всё в соответствие с их данными», «заведи зимние туры»).
 *
 * Что держит сторож:
 *  - контакты партнёра — объект: на массиве карточка тура не видела их вовсе
 *    (toContactsRecord → null), фиды отдавали operator_phone NULL;
 *  - Telegram по номеру (t.me/+7…) понимают и карточка, и страница оператора;
 *    MAX — только ссылка на профиль, по номеру её не бывает;
 *  - на странице оператора есть его туры (до 29.09 их не было вовсе);
 *  - миграция 1106 не возвращает уволившегося, берёт точку базы владельца
 *    (756) и закрывает даты вне сезона только без броней.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractContacts, telegramContactHref, maxProfileHref } from '@/lib/operators/profile-parse';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const MIG = read('migrations/1106_fishingkam_profile_tours_by_partner_site.sql');

/** Контакты ровно в той форме, что пишет 1106. */
const CONTACTS_1106 = {
  phone: '+79147822222',
  admin_name: 'Анатолий',
  phone_hours: 'Пн–Пт 09:00–19:00 по Камчатке (00:00–10:00 МСК)',
  whatsapp: '+79147822222',
  telegram_contact: '+79147822222',
  telegram: '+79147822222',
  telegram_channel: 'https://t.me/KamFishing_41',
  tiktok: 'kamfishing41',
  email: 'fishingkam@yandex.ru',
  website: 'https://fishingkam.ru',
  address: 'Камчатский край, г. Елизово, ул. Гагарина, д. 4',
};

describe('Telegram и MAX', () => {
  it('Telegram: ник или номер телефона', () => {
    expect(telegramContactHref('labanalex')).toBe('https://t.me/labanalex');
    expect(telegramContactHref('@labanalex')).toBe('https://t.me/labanalex');
    expect(telegramContactHref('+79147822222')).toBe('https://t.me/+79147822222');
    expect(telegramContactHref('+7 (914) 782-22-22')).toBe('https://t.me/+79147822222');
  });
  it('Telegram: цифры без плюса ссылкой не становятся (t.me/7914… — битая)', () => {
    expect(telegramContactHref('79147822222')).toBe('');
    expect(telegramContactHref('')).toBe('');
    expect(telegramContactHref(null)).toBe('');
  });
  it('MAX — только адрес max.ru, из номера ссылка не собирается', () => {
    expect(maxProfileHref('https://max.ru/u/f9LHodD0cOKrxbaHh')).toBe('https://max.ru/u/f9LHodD0cOKrxbaHh');
    expect(maxProfileHref('+79147822222')).toBe('');
    expect(maxProfileHref('https://evil.example/max')).toBe('');
  });
});

describe('страница оператора: контакты объектом', () => {
  const out = extractContacts(CONTACTS_1106);
  it('Анатолий с часами звонков', () => {
    expect(out).toContainEqual(expect.objectContaining({ name: 'Анатолий', phone: '+79147822222', note: CONTACTS_1106.phone_hours }));
  });
  it('WhatsApp, Telegram по номеру, канал, TikTok, почта, сайт', () => {
    const hrefs = out.map(c => c.href).filter(Boolean);
    expect(hrefs).toEqual(expect.arrayContaining([
      'https://wa.me/79147822222',
      'https://t.me/+79147822222',
      'https://t.me/KamFishing_41',
      'https://www.tiktok.com/@kamfishing41',
      'mailto:fishingkam@yandex.ru',
      'https://fishingkam.ru',
    ]));
  });
  it('MAX появляется, только когда в данных есть ссылка на профиль', () => {
    expect(out.some(c => c.label === 'Написать в MAX')).toBe(false);
    const withMax = extractContacts({ ...CONTACTS_1106, max: 'https://max.ru/u/abc123' });
    expect(withMax).toContainEqual({ label: 'Написать в MAX', href: 'https://max.ru/u/abc123' });
  });
  it('карточка тура строит Telegram тем же разборщиком', () => {
    const card = read('app/marketplace/tours/[id]/_TourDetailClient.tsx');
    expect(card).toMatch(/telegramContactHref\(o\.telegram_contact\)/);
  });
  it('планер читает телефон общим разборщиком, а не только из массива', () => {
    const planner = read('app/planner/_PlannerClient.tsx');
    expect(planner).toMatch(/extractContacts\(p\.contacts\)/);
    expect(planner).not.toMatch(/Array\.isArray\(p\.contacts\)/);
  });
});

describe('страница оператора: туры', () => {
  const page = read('app/operators/[slug]/page.tsx');
  it('туры берутся через общий шлюз витрины и ведут на карточку тура', () => {
    expect(page).toMatch(/publicTourSql\('ot'\)/);
    expect(page).toMatch(/href=\{tourPath\(t\)\}/);
  });
  it('нет цены — «Цена по запросу», а не 0 ₽', () => {
    expect(page).toMatch(/'Цена по запросу'/);
  });
});

describe('миграция 1106', () => {
  it('контакты — объект, присваиваются целиком и только поверх массива', () => {
    expect(MIG).toMatch(/SET contacts = jsonb_build_object\(/);
    expect(MIG).toMatch(/AND jsonb_typeof\(contacts\) = 'array'/);
  });
  it('уволившийся, номер офиса и личный Telegram не возвращаются', () => {
    // В присваиваемых значениях — только в комментариях-объяснениях их нет тоже.
    const code = MIG.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    expect(code).not.toMatch(/79992997007|79247808011|labanalex|Александр/);
  });
  it('точка базы — владельца (756), а не точка без источника', () => {
    expect(MIG).toMatch(/55\.433459, 159\.422728/);
    expect(MIG).toMatch(/latitude = 55\.433459, longitude = 159\.422728/);
  });
  it('три зимних тура — цены карточек сайта, суточная ставка, вставка идемпотентна', () => {
    expect(MIG).toMatch(/'zimnyaya-rybalka-noyabr-yanvar'[\s\S]*?22000::numeric, DATE '2026-11-15', DATE '2027-01-15'/);
    expect(MIG).toMatch(/'zimnyaya-rybalka-yanvar-mart'[\s\S]*?18000::numeric, DATE '2027-01-15', DATE '2027-03-20'/);
    expect(MIG).toMatch(/'zimnyaya-rybalka-fevral-aprel'[\s\S]*?22000::numeric, DATE '2027-02-20', DATE '2027-04-18'/);
    expect(MIG).toMatch(/'per_day_per_person', 5, 10/);
    expect(MIG).toMatch(/AND NOT EXISTS \([\s\S]*?t\.slug = v\.slug/);
  });
  it('даты вне сезона закрываются только без броней', () => {
    expect(MIG).toMatch(/SET is_cancelled = true[\s\S]*?AND COALESCE\(ta\.booked_slots, 0\) = 0/);
    expect(MIG).toMatch(/ON CONFLICT \(operator_tour_id, date\) DO NOTHING/);
  });
  it('цены существующих туров миграция не трогает', () => {
    expect(MIG).not.toMatch(/SET[^;]*base_price\s*=/);
  });
});
