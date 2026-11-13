// @vitest-environment node
/**
 * Нажатие «Беру» / «Не могу» на вопрос Ведара другой компании (этап 4б) —
 * вход общего обработчика кнопок оператора (MAX и Telegram зовут его одного).
 *
 * Держит: кнопка вопроса доходит до ответа у любой карточки, которой вопрос
 * мог быть задан, — туроператора и гида со своими турами (у остальных кнопок
 * кабинета гид получает «не выполняю»); кто отвечает — карточка, привязанная к
 * чату, а не то, что стоит в кнопке; чат без карточки и неразобранная кнопка —
 * отказ без записи; «не смогли проверить чат» не равно «чат не ваш».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findPartnerByChat, answerOfferAsk } = vi.hoisted(() => ({ findPartnerByChat: vi.fn(), answerOfferAsk: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('@/lib/kuzmich/operator-chat', () => ({ findPartnerByChat }));
vi.mock('@/lib/requests/offer-asks', () => ({ answerOfferAsk }));

import { isOperatorDeskPayload, operatorDeskPress } from '@/lib/telegram/operator-desk-press';
import { offerAskReplyText } from '@/lib/requests/offer-asks-text';

const partner = (category: string, over: Record<string, unknown> = {}) => ({
  outcome: 'found' as const,
  partner: { partnerId: 'p-1', partnerName: 'Компания', slug: 'kompaniya', category, crmCategory: null, userId: 'u-1', sellsTours: true, ...over },
});

beforeEach(() => {
  findPartnerByChat.mockReset();
  answerOfferAsk.mockReset();
  answerOfferAsk.mockResolvedValue({ state: 'declined' });
});

describe('кнопка вопроса в общем обработчике', () => {
  it('оба вебхука отдают её обработчику кабинета: префикс вопроса — его', () => {
    expect(isOperatorDeskPayload('oq:y:7')).toBe(true);
    expect(isOperatorDeskPayload('oq:n:7')).toBe(true);
    // Прежние кнопки на месте.
    for (const p of ['ia:a:l:1', 'sh:x', 'ss:y:1', 'opd:tours', 'sup:new']) expect(isOperatorDeskPayload(p)).toBe(true);
    expect(isOperatorDeskPayload('cb:i')).toBe(false);
  });

  it('туроператор и гид со своими турами отвечают; отвечает карточка чата, канал — тот, где нажали', async () => {
    for (const [category, channel] of [['operator', 'max'], ['guide', 'telegram']] as const) {
      findPartnerByChat.mockResolvedValue(partner(category));
      answerOfferAsk.mockResolvedValue({ state: 'declined' });
      const r = await operatorDeskPress({ channel, chatId: 802, payload: 'oq:n:15' });
      expect(r?.text, category).toBe(offerAskReplyText({ state: 'declined' }));
      expect(answerOfferAsk).toHaveBeenLastCalledWith({ partnerId: 'p-1', askId: '15', answer: 'decline', via: channel });
      expect(findPartnerByChat).toHaveBeenLastCalledWith(channel, 802);
    }
    // У гида остальные кнопки кабинета туроператора по-прежнему не выполняются.
    findPartnerByChat.mockResolvedValue(partner('guide'));
    expect((await operatorDeskPress({ channel: 'max', chatId: 802, payload: 'opd:tours' }))?.text).toContain('кабинет туроператора');
  });

  it('«Беру» — исход ответа словами компании', async () => {
    findPartnerByChat.mockResolvedValue(partner('operator'));
    answerOfferAsk.mockResolvedValue({ state: 'took', told: 'max', date: '2027-01-15', tourTitle: 'К кратеру' });
    const r = await operatorDeskPress({ channel: 'max', chatId: 802, payload: 'oq:y:15' });
    expect(answerOfferAsk).toHaveBeenCalledWith({ partnerId: 'p-1', askId: '15', answer: 'take', via: 'max' });
    expect(r?.text).toContain('Записал: «Беру». Человеку сообщено в MAX');
  });

  it('чат без карточки и неразобранная кнопка — «вопрос не ваш», записи нет', async () => {
    findPartnerByChat.mockResolvedValue({ outcome: 'none' });
    expect((await operatorDeskPress({ channel: 'max', chatId: 1, payload: 'oq:y:15' }))?.text).toBe(offerAskReplyText({ state: 'not_yours' }));
    findPartnerByChat.mockResolvedValue(partner('operator'));
    for (const bad of ['oq:y:', 'oq:x:15', 'oq:y:15:1', 'oq:y:abc']) {
      expect((await operatorDeskPress({ channel: 'max', chatId: 1, payload: bad }))?.text, bad).toBe(offerAskReplyText({ state: 'not_yours' }));
    }
    expect(answerOfferAsk).not.toHaveBeenCalled();
  });

  it('чат проверить не удалось — так и сказано, ответ не записан', async () => {
    findPartnerByChat.mockResolvedValue({ outcome: 'unavailable' });
    const r = await operatorDeskPress({ channel: 'telegram', chatId: 1, payload: 'oq:y:15' });
    expect(r?.text).toContain('Не удалось проверить, чей это чат');
    expect(answerOfferAsk).not.toHaveBeenCalled();
  });
});
