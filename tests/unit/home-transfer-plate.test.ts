// @vitest-environment node
/**
 * Трансфер в ленте туров и дополнительная кнопка на главной (владелец 09.10:
 * «в ленте туров пусть будет трансфер и доп кнопка на главной»).
 *
 * Карточка трансфера — не тур: у вахтовки под заказ нет дат и мест, цена за
 * МАШИНУ. Сторож держит три вещи: карточка не врёт про единицу цены и адрес,
 * лента не растёт и не остаётся с одной вахтовкой, а кнопка и карточка ведут
 * туда, куда обещают, на обоих деревьях главной.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PLATES_LIMIT, TRANSFER_PLATE_POSITION, plateFacts, plateHref, withTransferPlate,
} from '@/lib/home/plate-facts';
import type { CharterCarrier } from '@/lib/transfers/charter-format';

// data.ts тянет БД; чистую сборку карточки берём из исходника через динамический импорт с заглушкой.
import { vi } from 'vitest';
vi.mock('@/lib/database', () => ({ query: vi.fn() }));

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf-8');

const CARRIER: CharterCarrier = {
  partnerId: 'c1', slug: 'shatun', name: 'Шатун', shortDescription: null,
  vehicles: [
    { kind: 'vahtovka', title: 'a', seats: 26 },
    { kind: 'vahtovka', title: 'b', seats: 26 },
  ],
  destinations: [
    { from: 'Петропавловск-Камчатский', to: 'Вулкан Горелый', priceRub: 75000, note: null, conditions: null, validYear: 2026 },
    { from: 'Петропавловск-Камчатский', to: 'Вулкан Авачинский', priceRub: 65000, note: null, conditions: null, validYear: 2026 },
    { from: 'Петропавловск-Камчатский', to: 'Курильское озеро', priceRub: 450000, note: 'плюс переправы', conditions: null, validYear: 2026 },
  ],
  extraDay: null,
  photos: [{ url: '/images/shatun/shatun-01.jpg', credit: null }],
  clips: [], legal: null, video: null,
  phone: null, telegramHref: null, whatsappHref: null,
};

describe('адрес карточки ленты', () => {
  it('тур — своя страница, трансфер — /transfers, остальное — маршрут', () => {
    expect(plateHref({ kind: 'tour', id: '5', slug: 'rafting' })).toBe('/catalog/tours/rafting');
    expect(plateHref({ kind: 'tour', id: '5', slug: null })).toBe('/catalog/tours/5');
    expect(plateHref({ kind: 'transfer', id: 'c1', slug: 'shatun' })).toBe('/transfers');
    expect(plateHref({ kind: 'route', id: 'r1', slug: null })).toBe('/routes/r1');
  });
});

describe('цена трансфера называется за машину', () => {
  const base = { priceFrom: 65000, priceUnit: null, durationType: null, multiDayCount: null, durationHours: null, operatorName: 'Шатун' };
  it('«от 65 000 ₽ за машину», а у тура с той же цифрой — «/чел.»', () => {
    expect(plateFacts({ ...base, kind: 'transfer' }).price).toBe(`от ${(65000).toLocaleString('ru-RU')} ₽ за машину`);
    expect(plateFacts({ ...base, kind: 'tour' }).price).toMatch(/\/чел\./);
    expect(plateFacts({ ...base, kind: 'transfer' }).price).not.toMatch(/чел/);
  });
  it('цены нет — null, а не «от 0»', () => {
    expect(plateFacts({ ...base, priceFrom: null, kind: 'transfer' }).price).toBeNull();
  });
});

describe('вставка в ленту', () => {
  const tours = Array.from({ length: PLATES_LIMIT }, (_, i) => `тур${i}`);

  it('третьим, а лента не растёт: вытесняется последний тур', () => {
    const out = withTransferPlate(tours, 'ТРАНСФЕР');
    expect(out).toHaveLength(PLATES_LIMIT);
    expect(out[TRANSFER_PLATE_POSITION]).toBe('ТРАНСФЕР');
    expect(out.slice(0, TRANSFER_PLATE_POSITION)).toEqual(tours.slice(0, TRANSFER_PLATE_POSITION));
    expect(out).not.toContain(`тур${PLATES_LIMIT - 1}`);
  });

  it('туров мало — в конец, ничего не теряется', () => {
    expect(withTransferPlate(['тур0'], 'ТРАНСФЕР')).toEqual(['тур0', 'ТРАНСФЕР']);
    expect(withTransferPlate(['тур0', 'тур1'], 'ТРАНСФЕР')).toEqual(['тур0', 'тур1', 'ТРАНСФЕР']);
  });

  it('туров нет — лента из одной вахтовки под заголовком «Туры сезона» не рисуется', () => {
    expect(withTransferPlate([], 'ТРАНСФЕР')).toEqual([]);
  });

  it('карточки нет (перевозчиков нет или не прочитали) — лента как была', () => {
    expect(withTransferPlate(tours, null)).toEqual(tours);
  });
});

describe('карточка трансфера собирается из прайса', () => {
  it('цена «от» — наименьшая из направлений, парк и «цена за машину» в описании, имя перевозчика, первый кадр', async () => {
    const { transferPlateFrom } = await import('@/app/_home/data');
    const p = transferPlateFrom(CARRIER)!;
    expect(p.kind).toBe('transfer');
    expect(p.priceFrom).toBe(65000);
    expect(p.description).toBe('2 × вахтовка, 26 мест. цена за машину целиком');
    expect(p.operatorName).toBe('Шатун');
    expect(p.imageUrl).toBe('/images/shatun/shatun-01.jpg');
    expect(p.slug).toBe('shatun');
    // дат нет по природе: честный исход «даты по запросу», а не выдуманный «есть даты»
    expect(p.availability).toBe('on_request');
    expect(p.cancellationPolicy).toBeNull();
  });

  it('нет перевозчика или нет цен — карточки нет', async () => {
    const { transferPlateFrom } = await import('@/app/_home/data');
    expect(transferPlateFrom(undefined)).toBeNull();
    expect(transferPlateFrom({ ...CARRIER, destinations: [] })).toBeNull();
  });

  it('нет фото — null, а не чужой кадр', async () => {
    const { transferPlateFrom } = await import('@/app/_home/data');
    expect(transferPlateFrom({ ...CARRIER, photos: [] })!.imageUrl).toBeNull();
  });
});

describe('связка в исходниках', () => {
  it('отказ карточки трансфера не роняет ленту туров и пишется в лог', () => {
    const data = read('app/_home/data.ts');
    const fn = data.slice(data.indexOf('async function fetchTransferPlate'), data.indexOf('/** Витрина туров'));
    expect(fn).toMatch(/catch \(err\)/);
    expect(fn).toMatch(/console\.error\('\[home\] карточка трансфера не получена'/);
    expect(fn).toMatch(/return null;/);
  });

  it('телефон: плитка «Трансфер» ведёт на /transfers, занимает обе колонки; карточка ленты открывает прайс', () => {
    const c = read('app/_home/_HomeV8Client.tsx');
    expect(c).toMatch(/<Link href="\/transfers" className="qt qt-transfer"/);
    expect(c).toMatch(/\.v7 \.qt-transfer\{grid-column:1 \/ -1/);
    expect(c).toMatch(/const href = plateHref\(p\)/);
    expect(c).toMatch(/p\.kind === 'transfer' \? 'Смотреть прайс'/);
  });

  it('десктоп: карточка ленты идёт по plateHref, в шапке «Можно поехать» есть ссылка «Трансфер»', () => {
    const d = read('components/homepage/desk/DeskTours.tsx');
    expect(d.match(/href=\{plateHref\(p\)\}/g)).toHaveLength(2);
    expect(d).toMatch(/href="\/transfers"[\s\S]{0,200}Трансфер/);
    expect(d).not.toMatch(/tourPath\(/);
  });
});
