/**
 * Скидки и наценки глазами владельца тура (слово владельца 23.11: «Наценки
 * тоже показываются в модерации: цена тура меняется только через одну дверь»).
 *
 * Правило меняет цену на сайте только после проверки, поэтому экран не может
 * говорить «сохранено»: он обязан показать раздельно, что действует сейчас, о
 * чём владелец попросил и чем кончилась прошлая просьба. Здесь — рендер того,
 * что видит человек, и запросы, которые уходят с экрана. Двери на схеме прода
 * судит tests/integration/pricing-rule-moderation.pg.test.ts.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

import { PricingRuleStatus } from '@/components/operator/PricingRuleStatus';
import PricingClient, { discountWords, groupRows } from '@/app/hub/operator/pricing/_PricingClient';
import WeekendMarkup, { markupWords } from '@/app/hub/operator/pricing/_WeekendMarkup';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

type Call = { url: string; method: string; body: unknown };
/** Подложенный сервер: ответы по «МЕТОД адрес», вызовы — в список. */
function stubServer(answers: Record<string, () => unknown>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const path = url.split('?')[0];
    const answer = answers[`${method} ${path}`];
    if (!answer) return { ok: false, status: 500, json: async () => ({ success: false, error: `нет ответа на ${method} ${path}` }) };
    const body = answer() as { status?: number };
    return { ok: (body.status ?? 200) < 400, status: body.status ?? 200, json: async () => body };
  }));
  return calls;
}

describe('состояние правила — три разных, а не одно «сохранено»', () => {
  const base = { noun: 'скидка' as const, busy: false, onWithdraw: () => {} };
  const state = () => [...screen.getByTestId('pricing-rule-status').querySelectorAll('[data-state]')].map((n) => n.getAttribute('data-state'));

  it('ничего нет — «не назначена», и ни одной кнопки', () => {
    render(<PricingRuleStatus {...base} live={null} removalAsked={false} request={null} />);
    expect(state()).toEqual(['none']);
    expect(screen.getByText('Скидка не назначена')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('действует — сказано, что именно на сайте', () => {
    render(<PricingRuleStatus {...base} live="−10% за 7 дн. до выезда" removalAsked={false} request={null} />);
    expect(state()).toEqual(['live']);
    expect(screen.getByText('Действует на сайте: −10% за 7 дн. до выезда.')).toBeTruthy();
  });

  it('действующее просят снять — до решения оно действует, и это сказано', () => {
    render(<PricingRuleStatus {...base} live="−10% за 7 дн. до выезда" removalAsked request={null} />);
    expect(screen.getByTestId('pricing-rule-status').textContent)
      .toBe('Действует на сайте: −10% за 7 дн. до выезда. Вы просили снять — до решения администратора скидка действует.');
  });

  it('просьба ждёт проверки: туристы её не видят, на сайте — цена без скидки; просьбу можно отозвать', () => {
    const onWithdraw = vi.fn();
    render(<PricingRuleStatus {...base} onWithdraw={onWithdraw} live={null} removalAsked={false}
      request={{ words: '−15% за 7 дн. до выезда', status: 'pending', reason: null }} />);
    expect(state()).toEqual(['pending']);
    expect(screen.getByTestId('pricing-rule-status').textContent).toContain(
      'На проверке: −15% за 7 дн. до выезда. Туристы увидят после одобрения администратором; сейчас на сайте — цена без скидки.');
    // «Не назначена» рядом с просьбой не пишется: просьба есть.
    expect(screen.queryByText('Скидка не назначена')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Отозвать просьбу' }));
    expect(onWithdraw).toHaveBeenCalledTimes(1);
  });

  it('просьба рядом с действующей: видны обе, на сайте — прежняя', () => {
    render(<PricingRuleStatus {...base} noun="наценка" live="+10% в субботу и воскресенье" removalAsked={false}
      request={{ words: '+20% в субботу и воскресенье', status: 'pending', reason: null }} />);
    expect(state()).toEqual(['live', 'pending']);
    expect(screen.getByTestId('pricing-rule-status').textContent).toContain('сейчас на сайте — прежняя наценка.');
  });

  it('отказ: причина видна, сказано, что на сайте; без причины — так и написано', () => {
    const { rerender } = render(<PricingRuleStatus {...base} noun="наценка" live={null} removalAsked={false}
      request={{ words: '+30% в субботу и воскресенье', status: 'rejected', reason: 'Наценка 30% без объяснения.' }} />);
    expect(state()).toEqual(['rejected']);
    const text = screen.getByTestId('pricing-rule-status').textContent ?? '';
    expect(text).toContain('Наценка отклонена: +30% в субботу и воскресенье. Причина: Наценка 30% без объяснения.');
    expect(text).toContain('На сайте — цена без наценки. Измените и отправьте на проверку ещё раз.');
    expect(screen.getByRole('button', { name: 'Убрать' })).toBeTruthy();
    rerender(<PricingRuleStatus {...base} noun="наценка" live={null} removalAsked={false}
      request={{ words: '+30% в субботу и воскресенье', status: 'rejected', reason: null }} />);
    expect(screen.getByTestId('pricing-rule-status').textContent).toContain('Причина не записана.');
  });

  it('пока идёт запрос, кнопка не нажимается второй раз', () => {
    render(<PricingRuleStatus {...base} busy live={null} removalAsked={false}
      request={{ words: '−15%', status: 'pending', reason: null }} />);
    expect((screen.getByRole('button', { name: 'Отозвать просьбу' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('строки сервера → действующее правило и просьба', () => {
  const row = (o: Record<string, unknown>) => ({
    tour_id: '7', title: 'Вулкан', base_price: '20000', price_unit: 'per_person',
    rule_id: null, rule_type: null, multiplier: null, days_before_max: null, guests_min: null, ...o,
  });

  it('у тура и рода — действующее и просьба раздельно; поздняя просьба заменяет раннюю', () => {
    const [tour] = groupRows([
      row({ rule_id: '1', rule_type: 'last_minute', multiplier: '0.900', days_before_max: 7, moderation_status: 'approved', removal_asked: true }),
      row({ rule_id: '2', rule_type: 'last_minute', multiplier: '0.800', days_before_max: 5, moderation_status: 'rejected', moderation_reason: 'Много.' }),
      row({ rule_id: '3', rule_type: 'last_minute', multiplier: '0.850', days_before_max: 3, moderation_status: 'pending' }),
      row({ rule_id: '4', rule_type: 'group_discount', multiplier: '0.950', guests_min: 4, moderation_status: 'rejected', moderation_reason: 'Уточните.' }),
    ] as never);
    expect(tour.rules.last_minute).toEqual({
      live: { id: '1', percent: 10, daysBefore: 7, guestsMin: null },
      removalAsked: true,
      request: { id: '3', percent: 15, daysBefore: 3, guestsMin: null, status: 'pending', reason: null },
    });
    expect(tour.rules.group_discount).toEqual({
      live: null, removalAsked: false,
      request: { id: '4', percent: 5, daysBefore: null, guestsMin: 4, status: 'rejected', reason: 'Уточните.' },
    });
  });

  it('статус не пришёл — правило не считается действующим молча', () => {
    const [tour] = groupRows([row({ rule_id: '1', rule_type: 'last_minute', multiplier: '0.900', days_before_max: 7 })] as never);
    expect(tour.rules.last_minute?.live).toBeNull();
    expect(tour.rules.last_minute?.request?.status).toBe('pending');
  });

  it('тур без правил — без слотов; правило чужого рода на экран скидок не попадает', () => {
    const tours = groupRows([
      row({}),
      row({ tour_id: '8', title: 'Сплав', rule_id: '9', rule_type: 'season_peak', multiplier: '1.200', moderation_status: 'approved' }),
    ] as never);
    expect(tours.map((t) => [t.tourId, Object.keys(t.rules)])).toEqual([['7', []], ['8', []]]);
  });

  it('правило словами владельца; непрочитанный процент — не «−0%»', () => {
    expect(discountWords('last_minute', { id: '1', percent: 15, daysBefore: 7, guestsMin: null })).toBe('−15% за 7 дн. до выезда');
    expect(discountWords('group_discount', { id: '1', percent: 10, daysBefore: null, guestsMin: 4 })).toBe('−10% от 4 чел.');
    expect(discountWords('last_minute', { id: '1', percent: null, daysBefore: null, guestsMin: null })).toBe('процент не прочитан за ? дн. до выезда');
    expect(markupWords(15)).toBe('+15% в субботу и воскресенье');
    expect(markupWords(null)).toBe('процент не прочитан');
  });
});

describe('экран «Скидки»: просьба уходит на проверку, и это видно', () => {
  const rules: Array<Record<string, unknown>> = [];
  const tourRow = (o: Record<string, unknown> = {}) => ({
    tour_id: '7', title: 'Вулкан Горелый', base_price: '20000', price_unit: 'per_person',
    rule_id: null, rule_type: null, multiplier: null, days_before_max: null, guests_min: null, ...o,
  });
  let calls: Call[] = [];
  beforeEach(() => {
    rules.length = 0;
    rules.push(tourRow());
    calls = stubServer({
      'GET /api/hub/operator/pricing-rules': () => ({ success: true, data: rules }),
      'POST /api/hub/operator/pricing-rules': () => {
        rules.length = 0;
        rules.push(tourRow({ rule_id: '31', rule_type: 'last_minute', multiplier: '0.850', days_before_max: 7, moderation_status: 'pending' }));
        return { success: true, state: 'pending', status: 201, message: 'Скидка отправлена на проверку. Туристы увидят её после одобрения администратором.' };
      },
      'DELETE /api/hub/operator/pricing-rules': () => {
        rules.length = 0;
        rules.push(tourRow());
        return { success: true, state: 'withdrawn', message: 'Скидка убрана: на цену она не влияла.' };
      },
      'GET /api/hub/operator/weekend-markup': () => ({ success: true, data: [] }),
    });
  });
  const lastMinute = () => screen.getAllByTestId('pricing-rule-status')[0];

  it('кнопка называется «Отправить на проверку»; после отправки — слова сервера и просьба «на проверке»', async () => {
    render(<PricingClient />);
    await screen.findByText('Вулкан Горелый');
    // Обещания «турист видит сразу» на экране нет.
    expect(screen.getByText(/Скидка начинает действовать после проверки администратором/)).toBeTruthy();
    expect(screen.queryByText(/видит цену со скидкой сразу/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^(Назначить|Изменить|Сохранить)$/ })).toBeNull();
    expect(within(lastMinute()).getByText('Скидка не назначена')).toBeTruthy();

    fireEvent.change(screen.getAllByLabelText(/процент$/)[0], { target: { value: '15' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Отправить на проверку' })[0]);
    await waitFor(() => expect(screen.getByTestId('pricing-saved').textContent)
      .toBe('Скидка отправлена на проверку. Туристы увидят её после одобрения администратором.'));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ tourId: 7, ruleType: 'last_minute', percent: 15, daysBefore: 7 });
    await waitFor(() => expect(lastMinute().textContent).toContain('На проверке: −15% за 7 дн. до выезда.'));
    expect(lastMinute().textContent).toContain('сейчас на сайте — цена без скидки');
    // Слова «сохранено» на экране нет: цена на сайте не изменилась.
    expect(screen.queryByText(/сохранено/i)).toBeNull();
  });

  it('отозвать просьбу — запрос с id просьбы; действующую скидку снимают просьбой, по её id', async () => {
    rules.length = 0;
    rules.push(
      tourRow({ rule_id: '30', rule_type: 'last_minute', multiplier: '0.900', days_before_max: 7, moderation_status: 'approved', removal_asked: false }),
      tourRow({ rule_id: '31', rule_type: 'last_minute', multiplier: '0.850', days_before_max: 7, moderation_status: 'pending' }),
    );
    render(<PricingClient />);
    await screen.findByText('Вулкан Горелый');
    expect(lastMinute().textContent).toContain('Действует на сайте: −10% за 7 дн. до выезда.');
    expect(lastMinute().textContent).toContain('сейчас на сайте — прежняя скидка');
    fireEvent.click(within(lastMinute()).getByRole('button', { name: 'Отозвать просьбу' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(calls.find((c) => c.method === 'DELETE')?.url).toBe('/api/hub/operator/pricing-rules?id=31');
    await waitFor(() => expect(screen.getByTestId('pricing-saved').textContent).toBe('Скидка убрана: на цену она не влияла.'));

    // Действующую — отдельной кнопкой и по её id, даже когда рядом ждёт просьба.
    calls.length = 0;
    rules.length = 0;
    rules.push(
      tourRow({ rule_id: '30', rule_type: 'last_minute', multiplier: '0.900', days_before_max: 7, moderation_status: 'approved', removal_asked: false }),
      tourRow({ rule_id: '31', rule_type: 'last_minute', multiplier: '0.850', days_before_max: 7, moderation_status: 'pending' }),
    );
    cleanup();
    render(<PricingClient />);
    await screen.findByText('Вулкан Горелый');
    fireEvent.click(screen.getByRole('button', { name: 'Попросить снять' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'DELETE')?.url).toBe('/api/hub/operator/pricing-rules?id=30'));
  });

  it('снятие уже попросили — второй кнопки «Попросить снять» нет', async () => {
    rules.length = 0;
    rules.push(tourRow({ rule_id: '30', rule_type: 'last_minute', multiplier: '0.900', days_before_max: 7, moderation_status: 'approved', removal_asked: true }));
    render(<PricingClient />);
    await screen.findByText('Вулкан Горелый');
    expect(lastMinute().textContent).toContain('Вы просили снять — до решения администратора скидка действует.');
    expect(screen.queryByRole('button', { name: 'Попросить снять' })).toBeNull();
  });

  it('отказ сервера показан человеку, а не «отправлено»', async () => {
    calls = stubServer({
      'GET /api/hub/operator/pricing-rules': () => ({ success: true, data: rules }),
      'POST /api/hub/operator/pricing-rules': () => ({ success: false, status: 404, error: 'Тур не найден' }),
      'GET /api/hub/operator/weekend-markup': () => ({ success: true, data: [] }),
    });
    render(<PricingClient />);
    await screen.findByText('Вулкан Горелый');
    fireEvent.change(screen.getAllByLabelText(/процент$/)[0], { target: { value: '15' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Отправить на проверку' })[0]);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Тур не найден'));
    expect(screen.queryByTestId('pricing-saved')).toBeNull();
  });
});

describe('экран «Наценка на выходные»: просьба, действующая и отказ — раздельно', () => {
  const tour = (o: Record<string, unknown> = {}) => ({
    tourId: 7, title: 'Вулкан Горелый', basePrice: 20000, priceUnit: 'per_person',
    percent: null, ruleId: null, removalAsked: false, request: null, ...o,
  });
  let data: Array<Record<string, unknown>> = [];
  let calls: Call[] = [];
  beforeEach(() => {
    data = [tour()];
    calls = stubServer({
      'GET /api/hub/operator/weekend-markup': () => ({ success: true, data }),
      'POST /api/hub/operator/weekend-markup': () => {
        data = [tour({ request: { ruleId: '51', percent: 15, status: 'pending', reason: null } })];
        return { success: true, status: 201, state: 'pending', message: 'Наценка отправлена на проверку. Туристы увидят её после одобрения администратором.' };
      },
      'DELETE /api/hub/operator/weekend-markup': () => ({ success: true, state: 'withdrawn', message: 'Готово: неодобренной наценки больше нет, цена на сайте не менялась.' }),
    });
  });
  const status = () => screen.getByTestId('pricing-rule-status');

  it('просьба: кнопка «Отправить на проверку», слова сервера, статус «на проверке», цена на сайте — без наценки', async () => {
    render(<WeekendMarkup />);
    await screen.findByText('Вулкан Горелый');
    expect(screen.getByText(/Наценка начинает действовать после проверки администратором/)).toBeTruthy();
    expect(within(status()).getByText('Наценки нет')).toBeTruthy();
    // Пустое поле — отправлять нечего.
    expect((screen.getByRole('button', { name: 'Отправить на проверку' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Наценка для Вулкан Горелый'), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить на проверку' }));
    await waitFor(() => expect(screen.getByTestId('markup-said').textContent)
      .toBe('Наценка отправлена на проверку. Туристы увидят её после одобрения администратором.'));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ tourId: 7, percent: 15 });
    await waitFor(() => expect(status().textContent).toContain('На проверке: +15% в субботу и воскресенье.'));
    expect(status().textContent).toContain('сейчас на сайте — цена без наценки');
  });

  it('31% и дробь не отправляются', async () => {
    render(<WeekendMarkup />);
    await screen.findByText('Вулкан Горелый');
    const send = () => screen.getByRole('button', { name: 'Отправить на проверку' }) as HTMLButtonElement;
    for (const bad of ['31', '0', '2.5']) {
      fireEvent.change(screen.getByLabelText('Наценка для Вулкан Горелый'), { target: { value: bad } });
      expect(send().disabled, bad).toBe(true);
    }
    fireEvent.change(screen.getByLabelText('Наценка для Вулкан Горелый'), { target: { value: '30' } });
    expect(send().disabled).toBe(false);
  });

  it('отозвать просьбу — по id просьбы, а не «снять все наценки тура»: действующая остаётся', async () => {
    data = [tour({ percent: 10, ruleId: '50', request: { ruleId: '51', percent: 20, status: 'pending', reason: null } })];
    render(<WeekendMarkup />);
    await screen.findByText('Вулкан Горелый');
    expect(status().textContent).toContain('Действует на сайте: +10% в субботу и воскресенье.');
    expect(status().textContent).toContain('На проверке: +20% в субботу и воскресенье.');
    fireEvent.click(screen.getByRole('button', { name: 'Отозвать просьбу' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'DELETE')?.url).toBe('/api/hub/operator/weekend-markup?ruleId=51'));
    // Снять действующую — отдельная кнопка, по id действующей.
    calls.length = 0;
    fireEvent.click(screen.getByRole('button', { name: 'Попросить снять' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'DELETE')?.url).toBe('/api/hub/operator/weekend-markup?ruleId=50'));
  });

  it('отказ виден с причиной; снятие уже попросили — кнопки «Попросить снять» нет', async () => {
    data = [
      tour({ request: { ruleId: '51', percent: 30, status: 'rejected', reason: 'Наценка 30% без объяснения.' } }),
      tour({ tourId: 8, title: 'Сплав по реке Быстрая', percent: 10, ruleId: '60', removalAsked: true }),
    ];
    render(<WeekendMarkup />);
    await screen.findByText('Вулкан Горелый');
    const [first, second] = screen.getAllByTestId('weekend-markup-row');
    expect(first.textContent).toContain('Наценка отклонена: +30% в субботу и воскресенье. Причина: Наценка 30% без объяснения.');
    expect(second.textContent).toContain('Вы просили снять — до решения администратора наценка действует.');
    expect(within(second).queryByRole('button', { name: 'Попросить снять' })).toBeNull();
  });

  it('отказ сервера показан, слов «отправлена» нет', async () => {
    calls = stubServer({
      'GET /api/hub/operator/weekend-markup': () => ({ success: true, data }),
      'POST /api/hub/operator/weekend-markup': () => ({ success: false, status: 403, error: 'Нет права менять цены' }),
    });
    render(<WeekendMarkup />);
    await screen.findByText('Вулкан Горелый');
    fireEvent.change(screen.getByLabelText('Наценка для Вулкан Горелый'), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить на проверку' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Нет права менять цены'));
    expect(screen.queryByTestId('markup-said')).toBeNull();
  });
});
