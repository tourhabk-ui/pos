// @vitest-environment node
/**
 * Перевозчик «Шатун» и вахтовки под заказ (миграция 1185, #2240).
 *
 * Держит связку целиком, а не её половину (§4, «объявленный исход без
 * источника»): у прайса есть производитель (миграция), потребители (экран
 * /transfers, карточка перевозчика, Кузьмич и MCP) и источник один — загрузчик
 * lib/transfers/charter. Цифры прайса — слово владельца 09.10, дословно; всё,
 * чего владелец не называл (дни поездки, «что входит», цена за место), не
 * должно появиться ни в базе, ни на экране.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import sharp from 'sharp';
import { vi } from 'vitest';

vi.mock('next/image', () => ({
  default: (p: { src: string; alt: string }) => createElement('img', { src: p.src, alt: p.alt }),
}));
vi.mock('next/link', () => ({
  default: (p: { href: string; children: unknown; className?: string }) =>
    createElement('a', { href: p.href, className: p.className }, p.children as never),
}));

import { CharterCard } from '@/components/transfers/CharterCard';
import { charterContacts } from '@/lib/transfers/charter';
import {
  charterFootnote, describeFleet, formatRub, type CharterCarrier,
} from '@/lib/transfers/charter-format';

const ROOT = process.cwd();
const read = (f: string) => readFileSync(join(ROOT, f), 'utf-8');
const SQL = read('migrations/1185_shatun_charter_carrier.sql');
const CODE = SQL.replace(/--[^\n]*/g, '');

const CARRIER: CharterCarrier = {
  partnerId: 'c1', slug: 'shatun', name: 'Шатун', shortDescription: null,
  vehicles: [
    { kind: 'vahtovka', title: 'синяя', seats: 26 },
    { kind: 'vahtovka', title: 'оранжевая', seats: 26 },
  ],
  destinations: [
    { from: 'Петропавловск-Камчатский', to: 'Вулкан Авачинский', priceRub: 65000, note: null, conditions: 'при расчёте наличными', validYear: 2026 },
    { from: 'Петропавловск-Камчатский', to: 'Курильское озеро', priceRub: 450000, note: 'плюс переправы', conditions: 'при расчёте наличными', validYear: 2026 },
  ],
  extraDay: { priceRub: 30000, note: 'при эксплуатации транспорта на местности', conditions: 'при расчёте наличными', validYear: 2026 },
  photos: ['/images/shatun/shatun-01.jpg', '/images/shatun/shatun-02.jpg'],
  video: { url: '/video/shatun/shatun-river-crossing.mp4', poster: '/video/shatun/shatun-river-crossing.poster.jpg' },
  phone: '+79294560102', telegramHref: 'https://t.me/+79294560102', whatsappHref: 'https://wa.me/79294560102',
};

describe('миграция 1185: прайс дословно по слову владельца', () => {
  it.each([
    ['Вулкан Авачинский', 65000],
    ['Вулкан Горелый', 75000],
    ['Вачкажец', 70000],
    ['Курильское озеро', 450000],
    ['Толбачик (Мёртвый лес)', 360000],
  ])('%s — %i ₽ за машину', (to, price) => {
    expect(CODE).toMatch(new RegExp(`\\('${to.replace(/[()]/g, '\\$&')}',\\s+${price},`));
  });

  it('«плюс переправы» — текстом у Курильского озера, числа за переправы нет', () => {
    expect(CODE).toMatch(/\('Курильское озеро',\s+450000,\s+'плюс переправы'/);
    expect(CODE.match(/'плюс переправы'/g)).toHaveLength(1);
  });

  it('30 000 ₽ в день — отдельная строка extra_day, а не прибавка к цене направления', () => {
    expect(CODE).toMatch(/'extra_day', 30000, 'при эксплуатации транспорта на местности'/);
  });

  it('условие «при расчёте наличными» и год 2026 записаны на каждой строке прайса', () => {
    expect(CODE.match(/'при расчёте наличными', 2026/g)?.length).toBe(2);
  });

  it('две вахтовки по 26 мест; телефон, WhatsApp и Telegram — по одному номеру', () => {
    expect(CODE).toMatch(/'vahtovka', v\.title, 26/);
    expect(CODE).toMatch(/Вахтовка на базе КамАЗ \(синяя кабина\)/);
    expect(CODE).toMatch(/Вахтовка на базе КамАЗ \(оранжевая кабина\)/);
    expect(CODE).toMatch(/'phone', '\+79294560102'/);
    expect(CODE).toMatch(/'telegram_contact', '\+79294560102'/);
    expect(CODE).toMatch(/'whatsapp', '79294560102'/);
    expect(CODE).not.toMatch(/'max'/);
  });

  it('чего владелец не называл, не записано: ни цены за место, ни дней, ни юрлица, ни «проверено»', () => {
    expect(CODE).not.toMatch(/price_per_seat/);
    expect(CODE).not.toMatch(/is_verified\s*=\s*TRUE/i);
    expect(CODE).not.toMatch(/legal_info|company_name|registry_/);
    expect(CODE).not.toMatch(/commission_current/);
    // рейтинг — 0 («не оценён», тире на экране), не NULL: DESC ставит NULL первым
    expect(CODE).toMatch(/0, 0, FALSE, TRUE, NOW\(\)/);
  });

  it('прайс живёт в одной таблице: в partners.services его второй копии нет', () => {
    expect(CODE).not.toMatch(/\bservices\b/);
    expect(CODE).toMatch(/CREATE TABLE IF NOT EXISTS transfer_charter_prices/);
    // форма строки держится базой, а не договорённостью
    expect(CODE).toMatch(/transfer_charter_prices_line_shape/);
    expect(CODE).toMatch(/price_rub\s+INTEGER NOT NULL CHECK \(price_rub > 0\)/);
  });

  it('идемпотентна: партнёр, машины и цены вставляются только если их ещё нет', () => {
    expect(CODE.match(/WHERE NOT EXISTS|AND NOT EXISTS/g)!.length).toBeGreaterThanOrEqual(4);
    expect(CODE).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_charter_prices_destination/);
  });
});

describe('23 снимка перевозчика', () => {
  const dir = join(ROOT, 'public/images/shatun');
  const jpgs = readdirSync(dir).filter((f) => /^shatun-\d{2}\.jpg$/.test(f)).sort();

  it('ровно 23, все лежат в репозитории и сжаты, оригиналов (raw) нет', () => {
    expect(jpgs).toHaveLength(23);
    expect(existsSync(join(dir, 'raw'))).toBe(false);
    for (const f of jpgs) expect(statSync(join(dir, f)).size, f).toBeLessThan(320 * 1024);
  });

  it('метаданных нет: в снимках с телефона бывает координата места съёмки', async () => {
    for (const f of jpgs) {
      const meta = await sharp(join(dir, f)).metadata();
      expect(meta.exif, f).toBeUndefined();
    }
  });

  it('герой — первый снимок, в галерее остальные 22: герой не повторяется рядом с собой', () => {
    expect(CODE).toMatch(/'\/images\/shatun\/shatun-01\.jpg',\s+jsonb_build_array/);
    const gallery = [...CODE.matchAll(/'\/images\/shatun\/(shatun-\d{2})\.jpg'/g)].map((m) => m[1]);
    expect(gallery).toHaveLength(23);
    expect(new Set(gallery).size).toBe(23);
    for (let i = 1; i <= 23; i++) {
      expect(gallery).toContain(`shatun-${String(i).padStart(2, '0')}`);
      expect(existsSync(join(dir, `shatun-${String(i).padStart(2, '0')}.jpg`))).toBe(true);
    }
  });
});

describe('ролик перевозчика', () => {
  const mp4 = join(ROOT, 'public/video/shatun/shatun-river-crossing.mp4');
  const poster = join(ROOT, 'public/video/shatun/shatun-river-crossing.poster.jpg');

  it('файл и обложка лежат в репозитории, ролик сжат (оригинал был 16,9 МБ)', () => {
    expect(existsSync(mp4)).toBe(true);
    expect(existsSync(poster)).toBe(true);
    expect(statSync(mp4).size).toBeLessThan(4 * 1024 * 1024);
    expect(statSync(poster).size).toBeLessThan(100 * 1024);
  });

  it('метаданные ролика сняты: в присланном с телефона бывают дата и место съёмки', () => {
    const head = readFileSync(mp4).subarray(0, 4096).toString('latin1');
    expect(head).toMatch(/ftyp/);
    expect(head).not.toMatch(/©xyz|location|com\.apple|creation_time/i);
  });

  it('база принимает ролик только с обложкой и только из /video/', () => {
    expect(CODE).toMatch(/ADD COLUMN IF NOT EXISTS video_url\s+TEXT/);
    expect(CODE).toMatch(/ADD COLUMN IF NOT EXISTS video_poster_url\s+TEXT/);
    expect(CODE).toMatch(/partners_video_shape/);
    expect(CODE).toMatch(/video_poster_url IS NOT NULL/);
    expect(CODE).toMatch(/'\/video\/shatun\/shatun-river-crossing\.mp4',\s+'\/video\/shatun\/shatun-river-crossing\.poster\.jpg'/);
  });

  it('подпись не говорит, где снято: в присланном этого нет', () => {
    expect(SQL).toMatch(/без подписи о том,\s+--\s+ГДЕ снято/);
    expect(read('components/transfers/CharterCard.tsx')).not.toMatch(/Курильск|Толбачик|паром|переправ/);
  });
});

describe('чистое форматирование прайса', () => {
  it('рубли с неразрывными пробелами и знаком валюты; одинаково на сервере и в браузере', () => {
    expect(formatRub(65000)).toBe('65 000 ₽');
    expect(formatRub(450000)).toBe('450 000 ₽');
    expect(formatRub(900)).toBe('900 ₽');
  });

  it('парк одной строкой; пустой парк — null, а не «0 машин»', () => {
    expect(describeFleet(CARRIER.vehicles)).toBe('2 × вахтовка, 26 мест');
    expect(describeFleet([{ kind: 'jeep', title: 'a', seats: 6 }, { kind: 'vahtovka', title: 'b', seats: 26 }]))
      .toBe('1 × джип, 6 мест; 1 × вахтовка, 26 мест');
    expect(describeFleet([])).toBeNull();
  });

  it('сноска называет год, отправление и условие один раз; различающиеся условия не склеивает в «для всех»', () => {
    expect(charterFootnote(CARRIER)).toBe('Прайс 2026 года, отправление — Петропавловск-Камчатский, при расчёте наличными.');
    const mixed: CharterCarrier = {
      ...CARRIER,
      destinations: [
        { ...CARRIER.destinations[0], conditions: 'при расчёте наличными' },
        { ...CARRIER.destinations[1], conditions: 'по безналу' },
      ],
    };
    expect(charterFootnote(mixed)).toContain('при расчёте наличными; по безналу');
  });

  it('нет ни года, ни условий — сноски нет; год «не записан» не превращается в «бессрочно»', () => {
    const bare: CharterCarrier = {
      ...CARRIER, extraDay: null,
      destinations: [{ from: 'Петропавловск-Камчатский', to: 'X', priceRub: 1, note: null, conditions: null, validYear: null }],
    };
    expect(charterFootnote(bare)).toBe('Отправление — Петропавловск-Камчатский.');
    expect(charterFootnote({ destinations: [], extraDay: null })).toBeNull();
  });
});

describe('каналы связи перевозчика', () => {
  it('телефон, Telegram по номеру и WhatsApp по цифрам', () => {
    expect(charterContacts({ phone: '+79294560102', telegram_contact: '+79294560102', whatsapp: '79294560102' })).toEqual({
      phone: '+79294560102',
      telegramHref: 'https://t.me/+79294560102',
      whatsappHref: 'https://wa.me/79294560102',
    });
  });

  it('нет поля — нет ссылки; мусор и чужая форма не становятся кнопкой', () => {
    expect(charterContacts({ phone: 'позвоните нам' })).toEqual({ phone: null, telegramHref: null, whatsappHref: null });
    expect(charterContacts(null)).toEqual({ phone: null, telegramHref: null, whatsappHref: null });
    expect(charterContacts([{ name: 'Иван', phone: '+79294560102' }])).toEqual({ phone: null, telegramHref: null, whatsappHref: null });
    expect(charterContacts({ whatsapp: '123' }).whatsappHref).toBeNull();
  });
});

describe('карточка перевозчика', () => {
  const html = renderToStaticMarkup(createElement(CharterCard, { carrier: CARRIER }));

  it('цены за машину, переправы и доплата за день — как в прайсе', () => {
    expect(html).toContain('65 000 ₽');
    expect(html).toContain('450 000 ₽');
    expect(html).toContain('плюс переправы');
    expect(html).toContain('+30 000 ₽ в день');
    expect(html).toContain('при эксплуатации транспорта на местности');
    expect(html).toContain('Цена — за машину целиком, не за место.');
    expect(html).toContain('2 × вахтовка, 26 мест');
  });

  it('о том, чего прайс не говорит, сказано прямо, а не додумано', () => {
    expect(html).toMatch(/Сколько дней в поездке и что входит\s+в цену — в прайсе не указано/);
    expect(html).not.toMatch(/туда-обратно|включено топливо|водитель входит/);
  });

  it('телефон, Telegram и WhatsApp — кнопками; фото подписаны «Фото: Шатун»', () => {
    expect(html).toContain('href="tel:+79294560102"');
    expect(html).toContain('Позвонить +7 929 456-01-02');
    expect(html).toContain('https://t.me/+79294560102');
    expect(html).toContain('https://wa.me/79294560102');
    expect(html).toContain('Фото: Шатун');
  });

  it('видео — плеер с кнопками и обложкой, без автозапуска и без предзагрузки (~3 МБ на мобильной сети)', () => {
    expect(html).toContain('<video');
    expect(html).toContain('controls');
    expect(html).toContain('preload="none"');
    expect(html).toContain('poster="/video/shatun/shatun-river-crossing.poster.jpg"');
    expect(html).toContain('src="/video/shatun/shatun-river-crossing.mp4"');
    expect(html).toContain('Видео: Шатун');
    expect(html).not.toMatch(/autoplay/i);
  });

  it('нет ролика — нет плеера', () => {
    expect(renderToStaticMarkup(createElement(CharterCard, { carrier: { ...CARRIER, video: null } }))).not.toContain('<video');
  });

  it('на странице самого перевозчика нет ссылки на себя и второй ленты фото, а видео остаётся', () => {
    const own = renderToStaticMarkup(createElement(CharterCard, { carrier: CARRIER, linkToProfile: false, showPhotos: false }));
    expect(own).not.toContain('/operators/shatun');
    expect(own).not.toContain('Фото: Шатун');
    expect(own).toContain('<video');
    expect(html).toContain('/operators/shatun');
  });

  it('нет ни одного канала связи — так и сказано, кнопок нет', () => {
    const mute = renderToStaticMarkup(createElement(CharterCard, {
      carrier: { ...CARRIER, phone: null, telegramHref: null, whatsappHref: null },
    }));
    expect(mute).toContain('Контакты перевозчика пока не записаны');
    expect(mute).not.toContain('tel:');
  });
});

describe('связка: производитель, читатель и экраны', () => {
  const loader = read('lib/transfers/charter.ts');

  it('загрузчик только читает, и только публичное и живое', () => {
    expect(loader).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(loader).toMatch(/p\.is_public = TRUE/);
    expect(loader).toMatch(/is_active/);
    expect(loader).not.toMatch(/db-pool/);
    // ролик без обложки экран не показывает, даже если база пропустила
    expect(loader).toMatch(/p\.video_url && p\.video_poster_url \? \{ url: p\.video_url, poster: p\.video_poster_url \} : null/);
  });

  it('форматирование отделено от базы: карточка не тянет драйвер БД в браузерный бандл', () => {
    const fmt = read('lib/transfers/charter-format.ts');
    expect(fmt).not.toMatch(/@\/lib\/database|db-pool|from 'pg'/);
    expect(read('components/transfers/CharterCard.tsx')).not.toMatch(/@\/lib\/transfers\/charter'/);
    expect(read('app/transfers/_TransfersClient.tsx')).not.toMatch(/@\/lib\/transfers\/charter'/);
  });

  it('/transfers: три исхода — нашли, искали и никого, не смогли проверить (говорит вслух)', () => {
    const page = read('app/transfers/page.tsx');
    expect(page).toMatch(/export const dynamic = 'force-dynamic'/);
    expect(page).toMatch(/charter = \{ state: 'failed' \}/);
    expect(page).toMatch(/console\.error\('\[transfers\/charter\]'/);
    const client = read('app/transfers/_TransfersClient.tsx');
    expect(client).toMatch(/charter\.state === 'failed'/);
    expect(client).toMatch(/Не смогли проверить вахтовки под заказ/);
    expect(client).toMatch(/Это не значит, что их нет/);
    expect(client).toMatch(/charter\.carriers\.length > 0/);
    expect(client).toMatch(/<CharterCard key=\{c\.partnerId\}/);
  });

  it('карточка /operators/[slug]: прайс только у категории transfer, отказ называется вслух', () => {
    const page = read('app/operators/[slug]/page.tsx');
    expect(page).toMatch(/profile\.category === 'transfer'/);
    expect(page).toMatch(/loadCharterCarriers\(\{ partnerId: profile\.id \}\)/);
    expect(page).toMatch(/Не смогли проверить прайс перевозчика/);
    expect(page).toMatch(/Перевозчик/);
  });

  it('Кузьмич и MCP читают тот же загрузчик и называют вахтовки под заказ в описании', () => {
    const src = read('lib/kuzmich/transfer-search.ts');
    expect(src).toMatch(/loadCharterCarriers/);
    expect(src).not.toMatch(/\.phone\b|telegramHref|whatsappHref/);
    expect(read('lib/kuzmich/tool-schemas.ts')).toMatch(/вахтовки под заказ целой машиной/);
    expect(read('lib/mcp/public-tools.ts')).toMatch(/whole-vehicle charter prices/);
    // критерий #2240: пустая выдача поездок названа нормой, а не ошибкой поиска, в обоих описаниях
    expect(read('lib/mcp/public-tools.ts')).toMatch(/No dated trips is normal, not an error/);
    expect(read('lib/kuzmich/tool-schemas.ts')).toMatch(/Пустая выдача поездок с датами — норма, а не ошибка поиска/);
  });
});
