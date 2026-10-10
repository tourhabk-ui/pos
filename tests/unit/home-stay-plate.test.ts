/**
 * Сторож: жильё на главной (решение владельца 10.10: «нужно добавить в ленту,
 * где туры и трансферы, и кнопку на главную — жильё; голубую лагуну пока
 * спрячем») и баня по часам у «Кутхи» (миграция 1208).
 *
 * - карточка жилья — только с ценой и фото; цена «от» нижней за сутки;
 * - место в ленте: тур, тур, трансфер, тур, тур, жильё; без туров её нет;
 * - подключена в оба дерева: лента телефона и «Можно поехать» на десктопе;
 * - кнопка «Жильё» ведёт на /accommodations на телефоне и на десктопе;
 * - «Голубая лагуна» скрыта флагом, а не удалена; «Кутха» — баня по часам.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { toStayPlate, withStayPlate, isStayPlate, type StayPlate } from '@/lib/home/stay-plate';
import { withTransferPlate, type TransferPlate } from '@/lib/home/transfer-plate';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const row = {
  id: '3b2551c7-ed5c-47c8-bb93-41ca6a278c1e', name: 'Кутха',
  short_description: 'Дом целиком: 8 мест и 2 раскладушки, баня, крытый бассейн',
  address: 'пос. Пионерский', price_from: '24000.00', image_url: '/images/kutha/kutha-01.jpg',
};

describe('карточка жилья', () => {
  it('цена «от» нижней за сутки, ссылка на объект', () => {
    const p = toStayPlate(row) as StayPlate;
    expect(p.price).toMatch(/^от 24\s000\s₽ за сутки$/);
    expect(p.href).toBe(`/accommodations/${row.id}`);
    expect(p.kind).toBe('stay');
    expect(isStayPlate(p)).toBe(true);
  });

  it('без цены или без фото карточки нет', () => {
    expect(toStayPlate({ ...row, price_from: null })).toBeNull();
    expect(toStayPlate({ ...row, price_from: '0' })).toBeNull();
    expect(toStayPlate({ ...row, image_url: null })).toBeNull();
  });
});

describe('место в ленте', () => {
  const stay = toStayPlate(row) as StayPlate;
  const transfer = { kind: 'transfer', id: 't' } as TransferPlate;
  const tag = (x: unknown) => (isStayPlate(x) ? 'S' : (x as { kind?: string }).kind === 'transfer' ? 'T' : x);

  it('тур, тур, трансфер, тур, тур, жильё', () => {
    const cards = withStayPlate(withTransferPlate(['a', 'b', 'c', 'd', 'e'], transfer), stay, true);
    expect(cards.map(tag)).toEqual(['a', 'b', 'T', 'c', 'd', 'S', 'e']);
  });

  it('туров мало — в конец; туров нет — карточки нет; жилья нет — лента как была', () => {
    expect(withStayPlate(withTransferPlate(['a'], transfer), stay, true).map(tag)).toEqual(['a', 'T', 'S']);
    expect(withStayPlate([], stay, false)).toEqual([]);
    expect(withStayPlate(['a', 'b'], null, true)).toEqual(['a', 'b']);
  });
});

describe('подключено в оба дерева', () => {
  it('телефон: лента собирается с жильём, у жилья своя ветка и подпись', () => {
    const c = read('app/_home/_HomeV8Client.tsx');
    expect(c).toMatch(/const cards = withStayPlate\(withTransferPlate\(tours, data\.transfer\), data\.stay, tours\.length > 0\);/);
    expect(c).toMatch(/if \(isStayPlate\(p\)\)/);
    expect(c).toContain('Смотреть жильё');
  });

  it('данные главной и десктоп берут один сбор карточки', () => {
    const data = read('app/_home/data.ts');
    expect(data).toMatch(/fetchStayPlate\(\)/);
    expect(data).toMatch(/publicAccommodationSql\('a'\)/);
    expect(data).toMatch(/ORDER BY \$\{STAY_PHOTO_ORDER_SQL\} LIMIT 1/);
    expect(data).toMatch(/console\.error\('\[home\] карточка жилья не собрана/);
    const page = read('app/page.tsx');
    expect(page).toMatch(/fetchStayPlate\(\)/);
    expect(page).toMatch(/<DeskTours plates=\{plates\} transfer=\{transfer\} stay=\{stay\}/);
    const desk = read('components/homepage/desk/DeskTours.tsx');
    expect(desk).toMatch(/withStayPlate\(withTransferPlate\(plates\.slice\(0, 4\), transfer\), stay, plates\.length > 0\)/);
    expect(desk).toMatch(/isStayPlate\(p\) \? <StayRow/);
  });
});

describe('кнопка «Жильё»', () => {
  it('телефон: третья дверь ряда после «Трансфера», ведёт на /accommodations', () => {
    const c = read('app/_home/_HomeV8Client.tsx');
    const nav = c.slice(c.indexOf('className="qtools qt-top"'), c.indexOf('</nav>', c.indexOf('className="qtools qt-top"')));
    expect(nav).toMatch(/<Link href="\/accommodations" className="qt qt-stay"/);
    expect(nav).toContain('<BedDouble');
  });

  it('десктоп: ссылка «Жильё» в шапке «Можно поехать»', () => {
    const d = read('components/homepage/desk/DeskTours.tsx');
    expect(d).toMatch(/href="\/accommodations"[\s\S]{0,260}Жильё/);
  });
});

describe('миграция 1208', () => {
  const sql = read('migrations/1208_kutha_banya_hours_hide_lagoon.sql').replace(/--[^\n]*/g, '');

  it('«Голубая лагуна» скрыта флагом, строка не удаляется', () => {
    expect(sql).toMatch(/SET is_active = FALSE[\s\S]{0,120}WHERE LOWER\(name\) IN \('голубая лагуна', 'лагуна'\)/);
    expect(sql).not.toMatch(/DELETE FROM accommodations/);
  });

  it('«Кутха»: баня по часам и оплата — поверх текста 1205, один раз', () => {
    expect(sql).toMatch(/до 4 человек — 2 000 ₽, до 8 — 3 000 ₽, до 12 — 4 000 ₽ в час/);
    expect(sql).toMatch(/Дубовый веник — 500 ₽/);
    expect(sql).toMatch(/наличными или переводом на карту/);
    expect(sql).toMatch(/description LIKE '%28 000 ₽ с двумя раскладушками%'/);
    expect(sql).toMatch(/description NOT LIKE '%по часам%'/);
  });

  it('снимок доски: файл, sha256 и размер от него, без EXIF', () => {
    const path = join(process.cwd(), 'public/images/kutha/kutha-22.jpg');
    expect(existsSync(path)).toBe(true);
    const buf = readFileSync(path);
    expect(sql).toContain(createHash('sha256').update(buf).digest('hex'));
    expect(sql).toContain(String(buf.length));
    expect(buf.includes(Buffer.from('Exif\0\0'))).toBe(false);
  });
});
