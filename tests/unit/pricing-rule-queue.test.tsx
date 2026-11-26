/**
 * Очередь скидок и наценок у администратора (миграция 1514; слово владельца
 * 23.11: «Наценки тоже показываются в модерации: цена тура меняется только
 * через одну дверь»).
 *
 * Здесь — слова правила вызовом, карточка очереди рендером и сообщение
 * владельцу о решении. Очередь и решение на схеме прода судит
 * tests/integration/pricing-rule-moderation.pg.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

import {
  ruleChangeWords, ruleConditionWords, ruleExamplePrice, ruleNoun, ruleWords, type PendingPricingRule,
} from '@/lib/tours/pricing-rule-words';
import { pricingRuleSeenToken } from '@/lib/tours/pricing-rule-review';
import { PricingRuleQueue } from '@/components/admin/PricingRuleQueue';
import { editDecisionText } from '@/lib/notifications/partner-edit-notify';

afterEach(cleanup);

describe('правило цены словами', () => {
  it('род — существительным; незнакомый род виден как записан', () => {
    expect(ruleNoun('last_minute')).toBe('Скидка на последние места');
    expect(ruleNoun('weekend_sat_sun')).toBe('Наценка на выходные (сб, вс)');
    expect(ruleNoun('group_discount')).toBe('Скидка группе');
    expect(ruleNoun('новый_род')).toBe('правило «новый_род»');
  });

  it('на сколько меняет цену: скидка, наценка, «цену не меняет»; непрочитанный множитель — не «0%»', () => {
    expect(ruleChangeWords(0.85)).toBe('−15%');
    expect(ruleChangeWords('0.850')).toBe('−15%');
    expect(ruleChangeWords(1.1)).toBe('+10%');
    expect(ruleChangeWords(1)).toBe('цену не меняет');
    for (const bad of ['', 'abc', 0, -1, Number.NaN]) expect(ruleChangeWords(bad as number), String(bad)).toBe('множитель не прочитан');
  });

  it('когда срабатывает: дни до выезда, размер группы, заполнение, даты; условий нет — null', () => {
    const base = { rule_type: 'x', multiplier: 0.9 };
    expect(ruleConditionWords({ ...base, days_before_min: 0, days_before_max: 3 })).toBe('когда до выезда 3 дн. и меньше');
    expect(ruleConditionWords({ ...base, days_before_max: 3 })).toBe('когда до выезда 3 дн. и меньше');
    expect(ruleConditionWords({ ...base, days_before_min: 5, days_before_max: 10 })).toBe('когда до выезда от 5 до 10 дн.');
    expect(ruleConditionWords({ ...base, days_before_min: 30 })).toBe('когда до выезда 30 дн. и больше');
    expect(ruleConditionWords({ ...base, guests_min: 4 })).toBe('от 4 чел.');
    expect(ruleConditionWords({ ...base, occupancy_min: 70 })).toBe('при заполнении даты от 70%');
    expect(ruleConditionWords({ ...base, date_from: '2027-07-01', date_to: '2027-08-31' })).toBe('с 1 июля 2027 г. по 31 августа 2027 г.');
    expect(ruleConditionWords({ ...base, date_from: '2027-07-01', guests_min: 2 })).toBe('с 1 июля 2027 г., от 2 чел.');
    expect(ruleConditionWords(base)).toBeNull();
    // Ноль дней «и больше» — не условие.
    expect(ruleConditionWords({ ...base, days_before_min: 0 })).toBeNull();
  });

  it('правило одной строкой и цена в день, когда оно срабатывает', () => {
    expect(ruleWords({ rule_type: 'last_minute', multiplier: '0.850', days_before_min: 0, days_before_max: 3 }))
      .toBe('Скидка на последние места: −15%, когда до выезда 3 дн. и меньше');
    expect(ruleWords({ rule_type: 'weekend_sat_sun', multiplier: 1.15 })).toBe('Наценка на выходные (сб, вс): +15%');
    expect(ruleExamplePrice(12950, 1.1)).toBe(14245);
    expect(ruleExamplePrice('20000.00', '0.850')).toBe(17000);
    // Не прочитали цену или множитель — пример не выдумывается.
    for (const [price, m] of [[null, 0.9], ['', 0.9], [0, 0.9], [20000, 'x'], [20000, 0]] as const) {
      expect(ruleExamplePrice(price, m as number)).toBeNull();
    }
  });

  it('отпечаток карточки меняется от любой перемены правила и от рода решения', () => {
    const rule = { id: '7', rule_type: 'last_minute', multiplier: '0.850', days_before_min: 0, days_before_max: 3, guests_min: null };
    const seen = pricingRuleSeenToken(rule, 'new');
    expect(seen).toMatch(/^[0-9a-f]{64}$/);
    // Запись множителя из базы и из формы — одно значение.
    expect(pricingRuleSeenToken({ ...rule, multiplier: 0.85 }, 'new')).toBe(seen);
    for (const changed of [
      { ...rule, multiplier: '0.800' }, { ...rule, days_before_max: 5 }, { ...rule, guests_min: 4 },
      { ...rule, rule_type: 'group_discount' }, { ...rule, id: '8' }, { ...rule, date_from: '2027-07-01' },
    ]) {
      expect(pricingRuleSeenToken(changed, 'new')).not.toBe(seen);
    }
    expect(pricingRuleSeenToken(rule, 'removal')).not.toBe(seen);
  });
});

const CARD: PendingPricingRule = {
  id: '41', kind: 'new', tourId: '85', tourTitle: 'Вулкан Горелый', partnerId: 'p1', partnerName: 'Оператор', partnerCategory: 'operator',
  tourOnSite: true,
  words: 'Скидка на последние места: −20%, когда до выезда 7 дн. и меньше',
  replaces: 'Скидка на последние места: −10%, когда до выезда 7 дн. и меньше',
  basePrice: 20000, priceUnit: 'per_person', priceNow: 18000, priceAfter: 16000,
  seen: 'a'.repeat(64), since: '2026-11-23T10:00:00.000Z',
};

function show(rules: PendingPricingRule[], over: Partial<React.ComponentProps<typeof PricingRuleQueue>> = {}) {
  const onApprove = vi.fn();
  const onReject = vi.fn();
  const onRetry = vi.fn();
  render(
    <PricingRuleQueue
      loading={false} error="" rules={rules} actingId={null} actionError=""
      onRetry={onRetry} onApprove={onApprove} onReject={onReject} {...over}
    />,
  );
  return { onApprove, onReject, onRetry };
}
const sp = (s: string | null | undefined) => (s ?? '').replace(/[  ]/g, ' ');

describe('карточка очереди наценок', () => {
  it('новое правило: слова, что заменит, как изменится цена, ссылка на тур; отклонить нельзя без причины', () => {
    const { onApprove, onReject } = show([CARD]);
    const card = screen.getByTestId('pricing-rule');
    expect(card.getAttribute('aria-label')).toBe('Новое правило цены: Вулкан Горелый');
    expect(within(card).getByTestId('pricing-rule-words').textContent).toBe(CARD.words);
    expect(within(card).getByTestId('pricing-rule-replaces').textContent).toBe(CARD.replaces);
    expect(sp(within(card).getByTestId('pricing-rule-price').textContent))
      .toBe('сейчас 18 000 ₽ → после решения 16 000 ₽ (цена владельца — 20 000 ₽)');
    expect(within(card).getByText('Туроператор: Оператор')).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'тур на сайте' }).getAttribute('href')).toBe('/catalog/tours/85');

    const reject = within(card).getByRole('button', { name: 'Отклонить' }) as HTMLButtonElement;
    expect(reject.disabled).toBe(true);
    fireEvent.change(within(card).getByLabelText('Причина отказа'), { target: { value: '  Скидка слишком велика  ' } });
    expect(reject.disabled).toBe(false);
    fireEvent.click(reject);
    expect(onReject).toHaveBeenCalledWith('41', 'Скидка слишком велика');
    fireEvent.click(within(card).getByRole('button', { name: 'Одобрить' }));
    expect(onApprove).toHaveBeenCalledWith('41');
  });

  it('просьба снять правило: свои слова на кнопках, «заменит» нет; тура нет на сайте — так и сказано', () => {
    show([{ ...CARD, kind: 'removal', replaces: null, tourOnSite: false, priceNow: 16000, priceAfter: 20000 }]);
    const card = screen.getByTestId('pricing-rule');
    expect(card.getAttribute('aria-label')).toBe('Снять правило цены: Вулкан Горелый');
    expect(within(card).getByText('Владелец просит снять правило')).toBeTruthy();
    expect(within(card).queryByTestId('pricing-rule-replaces')).toBeNull();
    expect(within(card).getByRole('button', { name: 'Снять правило' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Оставить правило' })).toBeTruthy();
    expect(within(card).queryByRole('link', { name: 'тур на сайте' })).toBeNull();
    expect(card.textContent).toContain('тура на сайте сейчас нет');
  });

  it('цена не прочитана — так и сказано, ноль не выдумывается', () => {
    show([{ ...CARD, basePrice: null, priceNow: null, priceAfter: null }]);
    const price = screen.getByTestId('pricing-rule-price').textContent ?? '';
    expect(price).toContain('сейчас цена не прочитана → после решения цена не прочитана');
    expect(price).not.toMatch(/0 ₽/);
  });

  it('три состояния списка: загрузка, сбой с повтором, пусто — разные слова', () => {
    const failed = show([], { error: 'HTTP 503' });
    expect(screen.getByText(/Не смог загрузить скидки и наценки\. HTTP 503/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(failed.onRetry).toHaveBeenCalled();
    cleanup();
    show([]);
    expect(screen.getByText('Скидок и наценок на проверке нет.')).toBeTruthy();
    cleanup();
    show([CARD], { loading: true });
    expect(screen.queryByTestId('pricing-rule')).toBeNull();
    expect(screen.queryByText('Скидок и наценок на проверке нет.')).toBeNull();
  });

  it('идёт запись решения — кнопки этой карточки заперты; отказ сервера показан', () => {
    show([CARD, { ...CARD, id: '42', tourTitle: 'Сплав' }], { actingId: '41', actionError: 'Не смог записать решение. Цена не изменена.' });
    const [first, second] = screen.getAllByTestId('pricing-rule');
    expect((within(first).getByRole('button', { name: 'Одобрить' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(second).getByRole('button', { name: 'Одобрить' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('alert').textContent).toBe('Не смог записать решение. Цена не изменена.');
  });
});

describe('сообщение владельцу о решении по правилу цены', () => {
  const base = { partnerId: 'p', subject: 'pricing_rule' as const, label: 'Вулкан <Горелый>', ruleWords: 'Скидка группе: −10%, от 4 чел.' };

  it('четыре исхода — четыре текста; сказано, что стало с ценой', () => {
    expect(editDecisionText({ ...base, ruleKind: 'new', outcome: 'approved', reason: null }).split('\n')).toEqual([
      '<b>Скидка или наценка одобрена</b>', '«Вулкан &lt;Горелый&gt;»: Скидка группе: −10%, от 4 чел. — действует на сайте.',
    ]);
    expect(editDecisionText({ ...base, ruleKind: 'new', outcome: 'rejected', reason: 'Слишком <много>' }).split('\n')).toEqual([
      '<b>Скидка или наценка отклонена</b>',
      '«Вулкан &lt;Горелый&gt;»: Скидка группе: −10%, от 4 чел. — цена на сайте прежняя.',
      'Причина: Слишком &lt;много&gt;',
      'Изменить и отправить на проверку ещё раз можно в кабинете на сайте.',
    ]);
    expect(editDecisionText({ ...base, ruleKind: 'removal', outcome: 'approved', reason: null }).split('\n')).toEqual([
      '<b>Правило цены снято</b>', '«Вулкан &lt;Горелый&gt;»: Скидка группе: −10%, от 4 чел. — больше не действует.',
    ]);
    expect(editDecisionText({ ...base, ruleKind: 'removal', outcome: 'rejected', reason: null }).split('\n')).toEqual([
      '<b>В снятии правила цены отказано</b>',
      '«Вулкан &lt;Горелый&gt;»: Скидка группе: −10%, от 4 чел. — продолжает действовать.',
      'Причина не записана.',
    ]);
  });

  it('слова правила в разметку как есть не идут; правила нет в сообщении — названо «правило цены»', () => {
    expect(editDecisionText({ ...base, ruleWords: 'правило «<b>x</b>»', ruleKind: 'new', outcome: 'approved', reason: null }))
      .toContain('правило «&lt;b&gt;x&lt;/b&gt;» — действует на сайте.');
    expect(editDecisionText({ ...base, ruleWords: undefined, ruleKind: 'new', outcome: 'approved', reason: null }))
      .toContain('»: правило цены — действует на сайте.');
  });
});
