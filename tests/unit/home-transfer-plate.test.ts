/**
 * Сторож: карточка трансфера в ленте туров главной (решение владельца 09.10:
 * «между турами в ленту — карточку трансфера»).
 *
 * - цена — за МАШИНУ, «от» наименьшей строки прайса; на место не делится;
 * - перевозчик без прайса карточки не получает;
 * - карточка стоит МЕЖДУ турами (после второго), без туров её в ленте нет;
 * - подключена в оба дерева: лента телефона и «Можно поехать» на десктопе.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toTransferPlate, withTransferPlate, isTransferPlate, type TransferPlate } from '@/lib/home/transfer-plate';
import type { CharterCarrier, CharterPriceLine } from '@/lib/transfers/charter-format';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const line = (to: string, priceRub: number): CharterPriceLine => ({
  from: 'Петропавловск-Камчатский', to, priceRub, note: null, conditions: null, validYear: 2026,
});

const carrier = (over: Partial<CharterCarrier> = {}): CharterCarrier => ({
  partnerId: 'p1', slug: 'shatun', name: 'Шатун', shortDescription: null,
  vehicles: [{ kind: 'vahtovka', title: 'Вахтовка', seats: 26 }, { kind: 'vahtovka', title: 'Вахтовка 2', seats: 26 }],
  destinations: [line('Мутновский', 90000), line('Вилючинский перевал', 65000), line('Мутновский', 95000), line('Налычево', 120000)],
  extraDay: null, photos: [{ url: '/images/shatun.jpg', credit: null }], clips: [], legal: null, video: null,
  phone: '+79000000000', telegramHref: null, whatsappHref: null,
  ...over,
});

describe('карточка из прайса перевозчика', () => {
  it('цена — «от» наименьшей строки и за машину', () => {
    const t = toTransferPlate(carrier());
    expect(t?.price).toMatch(/^от 65\s000\s₽ за машину$/);
    expect(t?.price).not.toMatch(/мест|человек/);
  });

  it('направления без повторов, не больше трёх; ссылка — на перевозчика', () => {
    const t = toTransferPlate(carrier());
    expect(t?.destinations).toEqual(['Мутновский', 'Вилючинский перевал', 'Налычево']);
    expect(t?.href).toBe('/operators/shatun');
    expect(t?.fleet).toBe('2 × вахтовка, 26 мест');
  });

  it('без прайса карточки нет', () => {
    expect(toTransferPlate(carrier({ destinations: [] }))).toBeNull();
  });

  it('контакты перевозчика в карточку не уходят', () => {
    expect(JSON.stringify(toTransferPlate(carrier()))).not.toContain('+79000000000');
  });
});

describe('место в ленте', () => {
  const t = toTransferPlate(carrier()) as TransferPlate;

  it('после второго тура', () => {
    const r = withTransferPlate(['a', 'b', 'c'], t);
    expect(r.map((x) => (isTransferPlate(x) ? 'T' : x))).toEqual(['a', 'b', 'T', 'c']);
  });

  it('один тур — после него; туров нет — карточки нет; трансфера нет — лента как была', () => {
    expect(withTransferPlate(['a'], t).map((x) => (isTransferPlate(x) ? 'T' : x))).toEqual(['a', 'T']);
    expect(withTransferPlate([], t)).toEqual([]);
    expect(withTransferPlate(['a', 'b'], null)).toEqual(['a', 'b']);
  });
});

describe('подключена в оба дерева', () => {
  it('телефон: лента «Туров сезона» строится из туров с трансфером, у трансфера своя ветка', () => {
    const src = read('app/_home/_HomeV8Client.tsx');
    expect(src).toMatch(/const cards = withTransferPlate\(tours, data\.transfer\);/);
    expect(src).toMatch(/if \(isTransferPlate\(p\)\)/);
    expect(src).toContain('Смотреть перевозчика');
  });

  it('данные главной и десктоп берут один и тот же сбор карточки', () => {
    const data = read('app/_home/data.ts');
    expect(data).toMatch(/fetchTransferPlate\(\)/);
    expect(data).toMatch(/console\.error\('\[home\] карточка трансфера не собрана/);
    const page = read('app/page.tsx');
    expect(page).toMatch(/fetchTransferPlate\(\)/);
    expect(page).toMatch(/<DeskTours plates=\{plates\} transfer=\{transfer\}/);
    const desk = read('components/homepage/desk/DeskTours.tsx');
    expect(desk).toMatch(/withTransferPlate\(plates\.slice\(0, 4\), transfer\)/);
    expect(desk).toMatch(/isTransferPlate\(p\) \? <TransferRow/);
  });
});
