import { describe, it, expect, vi } from 'vitest';
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/lib/crm/price-preview', async (orig) => ({ ...(await orig<any>()), previewPriceChange: vi.fn() }));
vi.mock('@/lib/crm/price-change', () => ({ createPendingChange: vi.fn(async () => '11111111-2222-3333-4444-555555555555'), confirmUrl: (id: string) => `https://vedarai.ru/hub/operator/pricing/confirm?id=${id}` }));
import { readFileSync } from 'node:fs';
import { parsePriceChangePhrase, handlePriceChangePhrase } from '@/lib/kuzmich/price-change-phrase';
import { previewPriceChange } from '@/lib/crm/price-preview';

const W = (percent: number | null) => ({ change: { kind: 'weekend_markup', percent, tourIds: 'all' } });
const B = (percent: number) => ({ change: { kind: 'base_price', percent, tourIds: 'all' } });

// 20 диалогов: фраза партнёра → как понял Кузьмич (план K.ai B4: «20/20»).
const DIALOGS: [string, unknown][] = [
  ['подними всё на 10%', B(10)],
  ['Подними все цены на 10 %', B(10)],
  ['повысь цены на туры на 5 процентов', B(5)],
  ['снизь цены на 7%', B(-7)],
  ['сделай туры дешевле на 3%', B(-3)],
  ['наценка на выходные 15%', W(15)],
  ['поставь наценку на субботу и воскресенье 20%', W(20)],
  ['подними цены на выходные на 10%', W(10)],
  ['надбавка сб вс 30%', W(30)],
  ['убери наценку на выходные', W(null)],
  ['сними наценку выходного дня', W(null)],
  ['наценка на выходные 35%', { problem: expect.stringContaining('от 1 до 30%') }],
  ['подними всё на 40%', { problem: expect.stringContaining('30%') }],
  ['подними цены на 2,5%', { problem: expect.stringContaining('целое число') }],
  ['снизь цены на выходные на 10%', { problem: expect.stringContaining('только наценку') }],
  ['поставь скидку 10% на последние места', null],
  ['сколько у меня броней за неделю?', null],
  ['подними цены', null],
  ['конверсия выросла на 10%', null],
  ['запиши звонок Анне, просит скидку 5%', null],
];

describe('Кузьмич: фраза об изменении цены — K.ai B4', () => {
  it.each(DIALOGS)('%s', (text, want) => {
    expect(parsePriceChangePhrase(text)).toEqual(want);
  });
  it('20/20', () => expect(DIALOGS).toHaveLength(20));

  it('ответ: «Понял так», предпросмотр, ссылка; цены не пишет', async () => {
    (previewPriceChange as any).mockResolvedValue({ change: B(10).change, sampleDate: '2026-11-07',
      tours: [{ tourId: 7, title: 'Вулкан Мутновский', baseBefore: 12950, baseAfter: 14245, saturdayBefore: 12950, saturdayAfter: 14245, tiersOverride: false }] });
    const t = await handlePriceChangePhrase({ partnerId: 'op', sellsTours: true, text: 'подними всё на 10%', nowMs: Date.parse('2026-11-03T08:00:00Z') });
    expect(t).toBe([
      'Понял так: Базовая цена: +10%',
      '• Вулкан Мутновский · база 12 950 ₽ → 14 245 ₽ · сб 07.11: 12 950 ₽ → 14 245 ₽',
      'Уже оформленные брони не меняются.',
      '',
      'Я цены не меняю. Проверьте и подтвердите на сайте (нужен вход, ссылка одноразовая, действует 24 часа):',
      'https://vedarai.ru/hub/operator/pricing/confirm?id=11111111-2222-3333-4444-555555555555',
    ].join('\n'));
  });
  it('не продаёт туры — не наш путь', async () => {
    expect(await handlePriceChangePhrase({ partnerId: 'op', sellsTours: false, text: 'подними всё на 10%', nowMs: 0 })).toBeNull();
  });
  it('в модуле нет записи цен', () => {
    const src = readFileSync('lib/kuzmich/price-change-phrase.ts', 'utf8');
    expect(src).not.toMatch(/UPDATE|INSERT|setWeekendMarkup|confirmPendingChange/);
  });
});
