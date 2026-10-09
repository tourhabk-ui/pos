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
  photos: [
    { url: '/images/shatun/shatun-01.jpg', credit: null },
    { url: '/images/shatun/shatun-16.jpg', credit: 'Сладченко Виктор Леонидович' },
  ],
  legal: { name: 'ИП Миронова Нина Васильевна', inn: '250302356113' },
  clips: [
    { url: '/video/shatun/clip-water-approach.mp4', poster: '/video/shatun/clip-water-approach.poster.jpg', label: 'Вахтовка идёт через воду' },
  ],
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

  it('ролик без звука (решение владельца 09.10): дорожки нет в файле, плеер muted', () => {
    // Звуковая дорожка в MP4 — trak с обработчиком 'soun' в hdlr; у видео — 'vide'.
    const bytes = readFileSync(mp4).toString('latin1');
    expect(bytes).toMatch(/hdlr\0{8}vide/);
    expect(bytes).not.toMatch(/hdlr\0{8}soun/);
    const card = readFileSync(join(ROOT, 'components/transfers/CharterCard.tsx'), 'utf8');
    expect(card).toMatch(/<video\s+controls\s+muted\b/);
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

  it('телефон, Telegram и WhatsApp — кнопками; фото подписаны каждое своим автором', () => {
    expect(html).toContain('href="tel:+79294560102"');
    expect(html).toContain('Позвонить +7 929 456-01-02');
    expect(html).toContain('https://t.me/+79294560102');
    expect(html).toContain('https://wa.me/79294560102');
    // у снимка без названного автора — имя перевозчика, у остальных — их автор
    expect(html).toContain('Фото: Шатун');
    expect(html).toContain('Фото: Сладченко Виктор Леонидович');
  });

  it('видео — плеер с кнопками и обложкой, без автозапуска и без предзагрузки (~3 МБ на мобильной сети)', () => {
    expect(html).toContain('<video');
    expect(html).toContain('controls');
    expect(html).toContain('preload="none"');
    expect(html).toContain('poster="/video/shatun/shatun-river-crossing.poster.jpg"');
    expect(html).toContain('src="/video/shatun/shatun-river-crossing.mp4"');
    // «Видео», а не «Видео целиком»: внизу с 09.10 другой ролик (медведи),
    // а не полная версия клипов над ним.
    expect(html).toContain('Видео: Шатун');
    expect(html).not.toContain('Видео целиком');
    expect(html).not.toMatch(/autoplay/i);
  });

  it('нет ролика — нет плеера', () => {
    expect(renderToStaticMarkup(createElement(CharterCard, { carrier: { ...CARRIER, video: null, clips: [] } }))).not.toContain('<video');
  });

  it('на странице самого перевозчика нет ссылки на себя и второй ленты фото, а видео остаётся', () => {
    const own = renderToStaticMarkup(createElement(CharterCard, { carrier: CARRIER, linkToProfile: false, showPhotos: false }));
    expect(own).not.toContain('/operators/shatun');
    expect(own).not.toContain('Фото: Сладченко');
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

describe('миграция 1186: подписи авторов и клипы', () => {
  const SQL6 = read('migrations/1186_partner_gallery_credits_and_clips.sql');
  const CODE6 = SQL6.replace(/--[^\n]*/g, '');

  it('автор назван у восьми снимков дикой природы (16..23), у снимков машины и салона — нет', () => {
    const credited = [...CODE6.matchAll(/'\/images\/shatun\/shatun-(\d{2})\.jpg', 'Сладченко Виктор Леонидович'/g)].map((m) => Number(m[1]));
    expect(credited).toEqual([16, 17, 18, 19, 20, 21, 22, 23]);
    expect(CODE6.match(/Сладченко Виктор Леонидович/g)).toHaveLength(8);
  });

  it('подписи ставятся только в пустую карту: правку администратора не затираем', () => {
    expect(CODE6).toMatch(/AND gallery_credits = '\{\}'::jsonb/);
    expect(CODE6).toMatch(/AND video_clips = '\[\]'::jsonb/);
  });

  it('форму колонок держит база; у остальных партнёров они пусты по умолчанию', () => {
    expect(CODE6).toMatch(/gallery_credits JSONB NOT NULL DEFAULT '\{\}'/);
    expect(CODE6).toMatch(/video_clips\s+JSONB NOT NULL DEFAULT '\[\]'/);
    expect(CODE6).toMatch(/jsonb_typeof\(gallery_credits\) = 'object'/);
    expect(CODE6).toMatch(/jsonb_typeof\(video_clips\) = 'array'/);
  });

  it('три клипа лежат в репозитории вместе с обложками и весят мало', () => {
    const urls = [...CODE6.matchAll(/'url', '(\/video\/shatun\/[a-z-]+\.mp4)'/g)].map((m) => m[1]);
    const posters = [...CODE6.matchAll(/'poster', '(\/video\/shatun\/[a-z.-]+\.jpg)'/g)].map((m) => m[1]);
    expect(urls).toHaveLength(3);
    expect(posters).toHaveLength(3);
    for (const u of urls) {
      expect(existsSync(join(ROOT, 'public', u)), u).toBe(true);
      expect(statSync(join(ROOT, 'public', u)).size, u).toBeLessThan(400 * 1024);
    }
    for (const p of posters) expect(existsSync(join(ROOT, 'public', p)), p).toBe(true);
  });

  it('подписи «где снято» у клипов нет: в присланном этого нет', () => {
    expect(CODE6).not.toMatch(/'label', '[^']*(Курильск|Толбачик|Озеро|озеро|река|Камчатк)/);
  });
});

describe('разбор подписей и клипов из базы', () => {
  it('подпись — только для снимка из галереи и только непустая строка', async () => {
    const { parsePhotos } = await import('@/lib/transfers/charter');
    expect(parsePhotos(['/a.jpg', '/b.jpg'], { '/a.jpg': ' Автор ', '/b.jpg': '', '/lишний.jpg': 'Чужой' })).toEqual([
      { url: '/a.jpg', credit: 'Автор' },
      { url: '/b.jpg', credit: null },
    ]);
    expect(parsePhotos(['/a.jpg'], null)).toEqual([{ url: '/a.jpg', credit: null }]);
    expect(parsePhotos(['/a.jpg'], ['мусор'])).toEqual([{ url: '/a.jpg', credit: null }]);
    expect(parsePhotos(['/a.jpg'], { '/a.jpg': 42 })).toEqual([{ url: '/a.jpg', credit: null }]);
  });

  it('клип без обложки или с чужим адресом не показывается; без подписи — запасная фраза, не выдумка', async () => {
    const { parseClips } = await import('@/lib/transfers/charter');
    const ok = { url: '/video/x/a.mp4', poster: '/video/x/a.poster.jpg', label: 'Подход' };
    expect(parseClips([ok, { ...ok, poster: '' }, { ...ok, url: 'https://evil.example/a.mp4' }, { ...ok, url: '/video/x/a.exe' }, 'мусор', null], 'Видео: X')).toEqual([ok]);
    expect(parseClips([{ ...ok, label: '  ' }], 'Видео: X')[0].label).toBe('Видео: X');
    expect(parseClips({ not: 'array' }, 'Видео: X')).toEqual([]);
    expect(parseClips(undefined, 'Видео: X')).toEqual([]);
  });
});

describe('карточка: клипы показываются лениво', () => {
  const html = renderToStaticMarkup(createElement(CharterCard, { carrier: CARRIER }));

  it('в разметке у клипа обложка и preload="none", но нет ни src, ни автоигры: файл ещё не качается', () => {
    const clip = html.slice(html.indexOf('Короткие видео'));
    expect(clip).toContain('poster="/video/shatun/clip-water-approach.poster.jpg"');
    const tag = clip.match(/<video[^>]*>/)![0];
    expect(tag).toContain('preload="none"');
    expect(tag).toContain('muted');
    expect(tag).toContain('loop');
    expect(tag).not.toContain('src=');
    expect(tag).not.toMatch(/autoplay/i);
    expect(html).toContain('Видео: Шатун');
  });

  it('нет клипов — нет полосы', () => {
    const none = renderToStaticMarkup(createElement(CharterCard, { carrier: { ...CARRIER, clips: [] } }));
    expect(none).not.toContain('Короткие видео');
  });
});

describe('миграция 1187: исполнитель — только названное владельцем', () => {
  const SQL7 = read('migrations/1187_shatun_executor_requisites.sql');
  const CODE7 = SQL7.replace(/--[^\n]*/g, '');

  it('имя, ИНН и слово «лицензия есть» — дословно; номера лицензии, адреса и ОГРНИП нет', () => {
    expect(CODE7).toMatch(/company_name = 'ИП Миронова Нина Васильевна'/);
    expect(CODE7).toMatch(/'inn',\s+'250302356113'/);
    expect(CODE7).toMatch(/'license',\s+'есть'/);
    expect(CODE7).not.toMatch(/'address'|'ogrn'|АК-\d|Петропавловск/i);
  });

  it('«проверено» не ставится, реестр не трогается; пишется только в пустое', () => {
    expect(CODE7).not.toMatch(/is_verified|registry_/);
    expect(CODE7).toMatch(/\(company_name IS NULL OR company_name = ''\)/);
    expect(CODE7).toMatch(/legal_info IS NULL OR legal_info = '\{\}'::jsonb/);
  });

  it('цены и условия чужой площадки в карточку не переносятся: прайс один', () => {
    expect(CODE7).not.toMatch(/price_rub|7000|70000|transfer_charter_prices/);
  });
});

describe('исполнитель в загрузчике и на карточке', () => {
  it('название из company_name, запасное — из legal_info; ИНН только по форме; без названия реквизитов нет', async () => {
    const { parseLegal } = await import('@/lib/transfers/charter');
    expect(parseLegal('ИП Миронова Нина Васильевна', { inn: '250302356113' })).toEqual({ name: 'ИП Миронова Нина Васильевна', inn: '250302356113' });
    expect(parseLegal(null, { companyName: ' ИП Иванов ', inn: '2503 023561 13' })).toEqual({ name: 'ИП Иванов', inn: '250302356113' });
    expect(parseLegal('ООО «Х»', { inn: '1234' })).toEqual({ name: 'ООО «Х»', inn: null });
    expect(parseLegal('ООО «Х»', null)).toEqual({ name: 'ООО «Х»', inn: null });
    expect(parseLegal(null, { inn: '250302356113' })).toBeNull();
    expect(parseLegal('  ', 'мусор')).toBeNull();
  });

  it('карточка называет исполнителя; нет реквизитов — строки нет', () => {
    const html = renderToStaticMarkup(createElement(CharterCard, { carrier: CARRIER }));
    expect(html).toContain('Исполнитель: ИП Миронова Нина Васильевна, ИНН 250302356113.');
    const none = renderToStaticMarkup(createElement(CharterCard, { carrier: { ...CARRIER, legal: null } }));
    expect(none).not.toContain('Исполнитель');
    const noInn = renderToStaticMarkup(createElement(CharterCard, { carrier: { ...CARRIER, legal: { name: 'ИП Иванов', inn: null } } }));
    expect(noInn).toContain('Исполнитель: ИП Иванов.');
    expect(noInn).not.toContain('ИНН');
  });
});

describe('нижний ролик — медведи, а не повтор клипов (владелец 09.10)', () => {
  // «видео дублируются, добавь нижним видео медведей»: клипы ленты нарезаны из
  // переправы, и та же переправа стояла ниже целиком.
  const mp4 = join(ROOT, 'public/video/shatun/shatun-bears.mp4');
  const poster = join(ROOT, 'public/video/shatun/shatun-bears.poster.jpg');
  const MIG = read('migrations/1189_shatun_video_bears.sql').replace(/--[^\n]*/g, '');

  it('файл и обложка в репозитории, ролик сжат (присланный был 15,6 МБ)', () => {
    expect(existsSync(mp4)).toBe(true);
    expect(existsSync(poster)).toBe(true);
    expect(statSync(mp4).size).toBeLessThan(4 * 1024 * 1024);
    expect(statSync(poster).size).toBeLessThan(100 * 1024);
  });

  it('без звука и без метаданных съёмки — как прежний ролик', () => {
    const bytes = readFileSync(mp4).toString('latin1');
    expect(bytes).toMatch(/hdlr\0{8}vide/);
    expect(bytes).not.toMatch(/hdlr\0{8}soun/);
    expect(bytes.slice(0, 4096)).not.toMatch(/©xyz|location|com\.apple|creation_time/i);
  });

  it('миграция меняет ролик только там, где ещё переправа, и в форме CHECK', () => {
    expect(MIG).toMatch(/SET video_url\s+= '\/video\/shatun\/shatun-bears\.mp4',\s+video_poster_url = '\/video\/shatun\/shatun-bears\.poster\.jpg'/);
    expect(MIG).toMatch(/WHERE slug = 'shatun'\s+AND video_url = '\/video\/shatun\/shatun-river-crossing\.mp4'/);
    expect(MIG).not.toMatch(/INSERT|DELETE/);
  });

  it('фото ленты открываются на весь экран, а не сырым файлом в новой вкладке', () => {
    const strip = read('components/transfers/CharterPhotos.tsx');
    expect(strip).toMatch(/PhotoLightbox/);
    expect(strip).not.toMatch(/target="_blank"/);
    expect(read('components/transfers/CharterCard.tsx')).toMatch(/<CharterPhotos name=\{carrier\.name\} photos=\{carrier\.photos\} \/>/);
  });
});
