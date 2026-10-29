// @vitest-environment jsdom
/**
 * Курс ЦБ для «≈ юани» на китайских страницах (lib/currency/cbr-rate) —
 * вызовом и рендером.
 *
 * Пересчёт — подсказка, а не цена: он называет дату курса и что цена в
 * рублях. Нет курса — только рубли; прошлый курс без пометки не берётся.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import {
  parseCbrRate, loadCnyRate, resetCnyRateCache, approxYuan, CBR_DAILY_URL, type CbrRate,
} from '@/lib/currency/cbr-rate';
import { priceZh } from '@/lib/zh/entry';
import { ZhTourList } from '@/components/zh/ZhTourList';
import type { ZhTourRow } from '@/lib/zh/entry';

const XML = `<?xml version="1.0" encoding="windows-1251"?>
<ValCurs Date="30.10.2026" name="Foreign Currency Market">
<Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal><Name>Доллар США</Name><Value>81,2500</Value></Valute>
<Valute ID="R01375"><NumCode>156</NumCode><CharCode>CNY</CharCode><Nominal>1</Nominal><Name>Китайский юань</Name><Value>11,2000</Value></Valute>
<Valute ID="R01820"><NumCode>392</NumCode><CharCode>JPY</CharCode><Nominal>100</Nominal><Name>Японских иен</Name><Value>53,1000</Value></Valute>
</ValCurs>`;

/** Ответ ЦБ в его кодировке: windows-1251, как отдаёт cbr.ru. */
function cp1251(text: string): ArrayBuffer {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    bytes[i] = c < 128 ? c : c >= 0x410 && c <= 0x44f ? c - 0x350 : 0x3f;
  }
  return bytes.buffer;
}

const CNY: CbrRate = { code: 'CNY', rubPerUnit: 11.2, date: '30.10.2026' };

describe('parseCbrRate', () => {
  it('курс за единицу с учётом номинала, дата из ответа', () => {
    expect(parseCbrRate(XML, 'CNY')).toEqual(CNY);
    expect(parseCbrRate(XML, 'JPY')?.rubPerUnit).toBeCloseTo(0.531);
  });
  it('нет валюты или даты — null', () => {
    expect(parseCbrRate(XML, 'KZT')).toBeNull();
    expect(parseCbrRate(XML.replace(' Date="30.10.2026"', ''), 'CNY')).toBeNull();
    expect(parseCbrRate('<html>blocked</html>', 'CNY')).toBeNull();
  });
});

describe('loadCnyRate', () => {
  beforeEach(() => resetCnyRateCache());
  afterEach(() => vi.restoreAllMocks());

  it('читает ответ в windows-1251, спрашивает своим агентом, помнит шесть часов', async () => {
    const f = vi.fn(async () => new Response(cp1251(XML), { status: 200 })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const now = new Date('2026-10-29T03:00:00Z');
    expect(await loadCnyRate(now, f)).toEqual(CNY);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CBR_DAILY_URL);
    expect((init.headers as Record<string, string>)['user-agent']).toMatch(/VedarBot/);
    await loadCnyRate(new Date(now.getTime() + 5 * 3600_000), f);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('отказ без прошлого курса — null; отказ после удачи — курс с его датой, пока ему меньше суток', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const down = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    const now = new Date('2026-10-29T03:00:00Z');
    expect(await loadCnyRate(now, down)).toBeNull();

    resetCnyRateCache();
    const ok = vi.fn(async () => new Response(cp1251(XML), { status: 200 })) as unknown as typeof fetch;
    await loadCnyRate(now, ok);
    // Отказ ЦБ через 7 часов не затирает курс: дата курса показывается рядом с суммой.
    expect(await loadCnyRate(new Date(now.getTime() + 7 * 3600_000), down)).toEqual(CNY);
    // Через сутки и больше — только рубли.
    expect(await loadCnyRate(new Date(now.getTime() + 25 * 3600_000), down)).toBeNull();
  });

  it('одновременные заходы ждут один запрос к ЦБ', async () => {
    let release: (r: Response) => void = () => {};
    const f = vi.fn(() => new Promise<Response>((r) => { release = r; })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const now = new Date('2026-10-29T03:00:00Z');
    const a = loadCnyRate(now, f);
    const b = loadCnyRate(now, f);
    release(new Response(cp1251(XML), { status: 200 }));
    expect(await Promise.all([a, b])).toEqual([CNY, CNY]);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('цена по-китайски', () => {
  afterEach(cleanup);

  it('округление честно грубое: до сотни от тысячи, до десятка ниже', () => {
    expect(approxYuan(105_000, CNY)).toBe('约 9,400 元');
    expect(approxYuan(3_000, CNY)).toBe('约 270 元');
    expect(approxYuan(0, CNY)).toBeNull();
  });

  it('с курсом — юани, дата курса и «цена в рублях»; без курса — только рубли', () => {
    const t = { base_price: '105000', price_unit: 'per_person' };
    expect(priceZh(t, CNY)).toBe('105,000 卢布 每人（约 9,400 元，按俄罗斯央行 2026-10-30 汇率估算，以卢布计价）');
    expect(priceZh(t, null)).toBe('105,000 卢布 每人');
    expect(priceZh(t)).toBe('105,000 卢布 每人');
    expect(priceZh({ base_price: '0', price_unit: null }, CNY)).toBeNull();
  });

  it('список туров показывает пересчёт, когда курс есть', () => {
    const tour = {
      id: 't1', slug: 'tour-1', title: 'Тур', title_zh: null, base_price: '105000', price_unit: 'per_person',
      duration_hours: null, operator_name: 'Оператор', operator_slug: null, operator_public: false,
    } as unknown as ZhTourRow;
    const withRate = render(<ZhTourList tours={[tour]} cny={CNY} />);
    expect(withRate.container.textContent).toContain('约 9,400 元，按俄罗斯央行 2026-10-30 汇率估算');
    cleanup();
    const without = render(<ZhTourList tours={[tour]} />);
    expect(without.container.textContent).not.toContain('元');
  });
});
