/**
 * Правка цены и описания проката: черновик, не живая строка.
 *
 * Число берётся из фразы прокатчика. Ноль совпадений и несколько — разные
 * ответы, чужая машина не выбирается. Пока правку не одобрили, UPDATE
 * car_rental_offers нет. Витрина эту таблицу не читает.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { draftMayApply } from '@/lib/moderation/gate';
import {
  isOfferEditAsk, offerEditSavedText, parseOfferEdit,
} from '@/lib/rental/offer-edit';

const query = vi.fn();
const callToolsWaterfall = vi.fn();
const callAIWaterfallOrNull = vi.fn();
const saveMsg = vi.fn(async () => undefined);
const getHistory = vi.fn(async () => []);

vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('@/lib/ai/providers', () => ({
  callToolsWaterfall: (...a: unknown[]) => callToolsWaterfall(...a),
  callAIWaterfallOrNull: (...a: unknown[]) => callAIWaterfallOrNull(...a),
}));
vi.mock('@/lib/kuzmich/core', () => ({
  saveMsg: (...a: unknown[]) => saveMsg(...(a as [])),
  getHistory: (...a: unknown[]) => getHistory(...(a as [])),
}));

const OFFER = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';

function offerRow(over: Record<string, unknown> = {}) {
  return {
    id: OFFER, title: 'Suzuki Jimny', price_rub_per_day: 7000, price_is_from: false, conditions: null, ...over,
  };
}

beforeEach(() => {
  query.mockReset();
  callToolsWaterfall.mockReset();
  callAIWaterfallOrNull.mockReset();
  saveMsg.mockClear();
  vi.stubEnv('RENTAL_OPERATOR_PILOT_SLUGS', 'laguna-prokat');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  callToolsWaterfall.mockResolvedValue({ content: 'модель', tool_calls: [] });
});

describe('разбор фразы', () => {
  it('цена и описание разбираются, чужая фраза — нет', () => {
    expect(isOfferEditAsk('покажи машины')).toBe(false);
    expect(isOfferEditAsk('Беру')).toBe(false);
    expect(isOfferEditAsk('Цена на Jimny какая?')).toBe(false);
    expect(isOfferEditAsk('описание Tank-300?')).toBe(false);
    expect(isOfferEditAsk('описание Tank-300: едет ли на Мутновку?')).toBe(true);
    expect(isOfferEditAsk('цена Jimny')).toBe(true);
    expect(parseOfferEdit('цена Suzuki Jimny 8500')).toEqual({
      ok: true, command: { kind: 'price', title: 'Suzuki Jimny', priceRub: 8500 },
    });
    expect(parseOfferEdit('Цену Tank-300 16000')).toEqual({
      ok: true, command: { kind: 'price', title: 'Tank-300', priceRub: 16000 },
    });
    expect(parseOfferEdit('описание Suzuki Jimny: без лимита по асфальту')).toEqual({
      ok: true, command: { kind: 'conditions', title: 'Suzuki Jimny', conditions: 'без лимита по асфальту' },
    });
    expect(parseOfferEdit('цена 8500').ok).toBe(false);
    expect(parseOfferEdit('цена Jimny 0')).toMatchObject({ ok: false, reason: 'bad_price' });
    // «8 500» читается и как машина «Jimny 8» с ценой 500: оба прочтения
    // уходят дальше, выбирает прайс, не форма фразы.
    expect(parseOfferEdit('цена Jimny 8 500')).toEqual({
      ok: true,
      command: { kind: 'price', title: 'Jimny 8', priceRub: 500, alsoReadsAs: { title: 'Jimny', spacedPrice: '8 500' } },
    });
    expect(parseOfferEdit('цена Toyota Land Cruiser 200 15000')).toEqual({
      ok: true, command: { kind: 'price', title: 'Toyota Land Cruiser 200', priceRub: 15000 },
    });
    expect(parseOfferEdit('цена Jimny 2020 8500')).toEqual({
      ok: true, command: { kind: 'price', title: 'Jimny 2020', priceRub: 8500 },
    });
    expect(parseOfferEdit('описание Jimny:').ok).toBe(false);
    expect(parseOfferEdit(`описание Jimny: ${'а'.repeat(2001)}`)).toMatchObject({ ok: false, reason: 'too_long' });
  });

  it('подсказка для MAX не содержит угловых скобок: канал шлёт HTML', async () => {
    const { offerEditFormatHint } = await import('@/lib/rental/offer-edit');
    expect(offerEditFormatHint()).not.toContain('<');
    expect(offerEditFormatHint()).toContain('одним числом');
  });

  it('ответ экранирует название и текст и не обещает, что сайт уже изменён', () => {
    const text = offerEditSavedText({
      title: 'Jimny <b>',
      kind: 'conditions',
      livePrice: 7000,
      priceIsFrom: true,
      liveConditions: null,
      draftPrice: null,
      draftConditions: 'текст <i>',
    });
    expect(text).toContain('Jimny &lt;b&gt;');
    expect(text).toContain('текст &lt;i&gt;');
    expect(text).toContain('пока прежняя строка');
    expect(text).not.toContain('Jimny <b>');
    expect(text).not.toContain('+7');
  });
});

describe('черновик не является витриной', () => {
  it('применяется только одобренное', () => {
    expect(draftMayApply('approved')).toBe(true);
    expect(draftMayApply('pending')).toBe(false);
    expect(draftMayApply('rejected')).toBe(false);
    expect(draftMayApply('published')).toBe(false);
  });

  it('публичные читатели прайса черновик не читают', () => {
    for (const file of [
      'lib/rental/rental.ts',
      'lib/kuzmich/car-rental-search.ts',
      'components/rental/RentalOfferList.tsx',
      'lib/kuzmich/operator-rental-fleet.ts',
    ]) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('rental_offer_edits');
    }
  });
});

describe('запись черновика', () => {
  it('пилоту сохраняет цену и не обновляет живую строку', async () => {
    query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (/INSERT INTO rental_offer_edits/.test(sql)) {
        return { rows: [{ price_rub_per_day: params[2], conditions: params[3] }] };
      }
      if (/FROM car_rental_offers/.test(sql)) return { rows: [offerRow()] };
      return { rows: [] };
    });
    const { handleRentalOfferEdit } = await import('@/lib/rental/offer-edit-flow');
    const text = await handleRentalOfferEdit({
      partnerId: PARTNER, slug: 'laguna-prokat', text: 'цена Suzuki Jimny 8500',
    });
    expect(text).toContain('Черновик записан');
    expect(text).toContain('8 500');
    const insert = query.mock.calls.find((c) => /INSERT INTO rental_offer_edits/.test(String(c[0])));
    expect(insert?.[1]).toEqual([OFFER, PARTNER, 8500, null]);
    expect(query.mock.calls.some((c) => /UPDATE car_rental_offers/.test(String(c[0])))).toBe(false);
  });

  /** Прайс прокатчика: FIND_SQL сравнивает название целиком, без регистра. */
  function priceList(titles: string[]) {
    query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (/INSERT INTO rental_offer_edits/.test(sql)) {
        return { rows: [{ price_rub_per_day: params[2], conditions: params[3] }] };
      }
      if (/FROM car_rental_offers/.test(sql)) {
        const asked = String(params[1]).trim().toLowerCase();
        return { rows: titles.filter((t) => t.toLowerCase() === asked).map((title) => offerRow({ title })) };
      }
      return { rows: [] };
    });
  }

  it('машина с числом на конце названия получает черновик', async () => {
    priceList(['Toyota Land Cruiser 200', 'УАЗ 469']);
    const { handleRentalOfferEdit } = await import('@/lib/rental/offer-edit-flow');
    const text = await handleRentalOfferEdit({
      partnerId: PARTNER, slug: 'laguna-prokat', text: 'цена Toyota Land Cruiser 200 15000',
    });
    expect(text).toContain('Черновик записан');
    expect(text).toContain('Toyota Land Cruiser 200');
    const insert = query.mock.calls.find((c) => /INSERT INTO rental_offer_edits/.test(String(c[0])));
    expect(insert?.[1]).toEqual([OFFER, PARTNER, 15000, null]);

    query.mockClear();
    expect(await handleRentalOfferEdit({
      partnerId: PARTNER, slug: 'laguna-prokat', text: 'цена УАЗ 469 5000',
    })).toContain('Черновик записан');
  });

  it('в прайсе «Mazda» и «Mazda 6»: «цена Mazda 6 7000» — черновик для «Mazda 6»', async () => {
    priceList(['Mazda', 'Mazda 6']);
    const { handleRentalOfferEdit } = await import('@/lib/rental/offer-edit-flow');
    const text = await handleRentalOfferEdit({
      partnerId: PARTNER, slug: 'laguna-prokat', text: 'цена Mazda 6 7000',
    });
    expect(text).toContain('Черновик записан: «Mazda 6»');
    const insert = query.mock.calls.find((c) => /INSERT INTO rental_offer_edits/.test(String(c[0])));
    expect(insert?.[1]?.[2]).toBe(7000);
  });

  it('«цена Suzuki Jimny 8 500» — цена с пробелом: черновик не пишет и просит число целиком', async () => {
    priceList(['Suzuki Jimny']);
    const { handleRentalOfferEdit } = await import('@/lib/rental/offer-edit-flow');
    const text = await handleRentalOfferEdit({
      partnerId: PARTNER, slug: 'laguna-prokat', text: 'цена Suzuki Jimny 8 500',
    });
    expect(text).toContain('одним числом без пробела');
    expect(text).toContain('«8 500»');
    expect(text).not.toContain('Черновик записан');
    expect(query.mock.calls.some((c) => /INSERT INTO rental_offer_edits/.test(String(c[0])))).toBe(false);
  });

  it('две машины с одним названием не выбирает и ничего не пишет', async () => {
    query.mockResolvedValue({ rows: [offerRow(), offerRow({ id: '33333333-3333-4333-8333-333333333333', title: 'suzuki jimny' })] });
    const { handleRentalOfferEdit } = await import('@/lib/rental/offer-edit-flow');
    const text = await handleRentalOfferEdit({
      partnerId: PARTNER, slug: 'laguna-prokat', text: 'цена suzuki jimny 9000',
    });
    expect(text).toContain('Не выбираю');
    expect(query.mock.calls.some((c) => /INSERT INTO rental_offer_edits/.test(String(c[0])))).toBe(false);
  });

  it('чужой slug и обычная фраза черновик не пишут', async () => {
    const { handleRentalOfferEdit } = await import('@/lib/rental/offer-edit-flow');
    expect(await handleRentalOfferEdit({
      partnerId: PARTNER, slug: 'fishing', text: 'цена Suzuki Jimny 8500',
    })).toBeNull();
    expect(await handleRentalOfferEdit({
      partnerId: PARTNER, slug: 'laguna-prokat', text: 'покажи машины',
    })).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('отказ базы — «не смог», а не «записано»', async () => {
    query.mockRejectedValue(Object.assign(new Error('x'), { code: '57P01' }));
    const { handleRentalOfferEdit } = await import('@/lib/rental/offer-edit-flow');
    const text = await handleRentalOfferEdit({
      partnerId: PARTNER, slug: 'laguna-prokat', text: 'цена Suzuki Jimny 8500',
    });
    expect(text).toContain('Не смог записать');
    expect(text).not.toContain('Черновик записан');
  });
});

describe('чат пилота не отдаёт правку модели', () => {
  const pilot = {
    partnerId: PARTNER, partnerName: 'Лагуна Прокат', slug: 'laguna-prokat',
    category: 'transfer', crmCategory: 'transfer' as const, userId: null,
  };

  it('«цена …» отвечает черновиком и модель не зовёт', async () => {
    query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (/INSERT INTO rental_offer_edits/.test(sql)) {
        return { rows: [{ price_rub_per_day: params[2], conditions: params[3] }] };
      }
      if (/FROM car_rental_offers/.test(sql)) return { rows: [offerRow({ title: 'Jimny <b>' })] };
      return { rows: [] };
    });
    const { processPartnerMessage } = await import('@/lib/kuzmich/operator-chat');
    const reply = vi.fn(async () => undefined);
    await processPartnerMessage({
      chatId: 7, text: 'цена Jimny <b> 8500', fromName: null, partner: pilot, reply,
    });
    expect(callToolsWaterfall).not.toHaveBeenCalled();
    expect(callAIWaterfallOrNull).not.toHaveBeenCalled();
    const sent = String(reply.mock.calls[0]?.[1]);
    expect(sent).toContain('Черновик записан');
    expect(sent).toContain('Jimny &lt;b&gt;');
    expect(sent).not.toContain('Jimny <b>');
    expect(sent).not.toMatch(/\+7|телефон/);
  });

  it('вопрос «Цена на Jimny какая?» отвечает помощник по прайсу, а не подсказка формата', async () => {
    query.mockResolvedValue({ rows: [] });
    callToolsWaterfall.mockResolvedValue({ content: 'Jimny по прайсу — 7 000 ₽ в сутки.', tool_calls: [] });
    const { processPartnerMessage } = await import('@/lib/kuzmich/operator-chat');
    const reply = vi.fn(async () => undefined);
    await processPartnerMessage({
      chatId: 7, text: 'Цена на Jimny какая?', fromName: null, partner: pilot, reply,
    });
    expect(callToolsWaterfall).toHaveBeenCalled();
    const sent = String(reply.mock.calls[0]?.[1]);
    expect(sent).toContain('по прайсу');
    expect(sent).not.toContain('Напишите отдельным сообщением');
    expect(query.mock.calls.some((c) => /rental_offer_edits/.test(String(c[0])))).toBe(false);
  });
});
