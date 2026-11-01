import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitPrefillId } from '@/lib/booking/request-prefill';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf-8');

describe('предзаполнение заявки на сервере (агенты без JS, 01.11)', () => {
  it('splitPrefillId: без «~» — id как был', () => {
    expect(splitPrefillId('zaporozhets-kurilskoe-ozero-3-dnya')).toEqual({ id: 'zaporozhets-kurilskoe-ozero-3-dnya', prefill: {} });
  });
  it('splitPrefillId: «slug~date=..&guests=..» разбирается, мусор отбрасывается', () => {
    const r = splitPrefillId(encodeURIComponent('tur~date=2027-07-15&guests=3'));
    expect(r.id).toBe('tur');
    expect(r.prefill).toMatchObject({ date: '2027-07-15', guests: 3 });
    expect(splitPrefillId('tur~date=bad&guests=-1').prefill).toEqual({});
  });
  it('rewrite ведёт ?date/?guests на динамический двойник, двойник noindex', () => {
    expect(read('next.config.js')).toMatch(/destination: '\/catalog\/tours\/:id\/request'/);
    const twin = read('app/catalog/tours/[id]/request/page.tsx');
    expect(twin).toMatch(/force-dynamic/);
    expect(twin).toMatch(/index: false/);
  });
  it('у формы видно «Заявка — не бронь», id/slug тура в HTML, ReserveAction в JSON-LD', () => {
    const card = read('app/catalog/tours/[id]/_TourDetailClient.tsx');
    expect(card).toMatch(/Заявка — не бронь/);
    expect(card).toMatch(/data-tour-id=\{tour\.id\}/);
    expect(read('app/catalog/tours/[id]/page.tsx')).toMatch(/'@type': 'ReserveAction'/);
  });
});
