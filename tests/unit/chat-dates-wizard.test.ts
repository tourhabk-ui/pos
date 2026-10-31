/**
 * Даты кнопками в MAX (31.10, слово владельца «Б: даты кнопками»): тур →
 * месяц → дни → места → то же предложение с «Открыть», что у фразы.
 *
 * Держится вызовом:
 *   - payload: туда и обратно, до 64 байт, чужая форма и места вне 1–500 — null;
 *   - даты шага — те же, что разбор даёт по равной фразе («открой выходные
 *     декабря, 15 мест»): у кнопок и фразы одно правило дней;
 *   - прошедшие дни и даты за горизонтом года не предлагаются; где дат нет —
 *     кнопки нет;
 *   - в ряду не больше трёх кнопок, каждая кнопка шага разбирается обратно;
 *   - поток: скрытый и чужой тур — «тура нет», ничего не предлагается; без
 *     кабинета, не продавец, «не смог проверить» — свои ответы; «Открыть» —
 *     ровно даты шага с местами и правилом, через общий путь предложения;
 *   - кнопка `dw:` идёт полосой нажатий дат (`pressActionOf` → `dates`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const readPartnerTours = vi.fn();
const proposeChosenDates = vi.fn(async () => undefined);
vi.mock('@/lib/operators/chat-dates/proposals', async (orig) => ({
  ...(await orig<typeof import('@/lib/operators/chat-dates/proposals')>()),
  readPartnerTours: (...args: unknown[]) => readPartnerTours(...args),
}));
vi.mock('@/lib/operators/chat-dates/flow', async (orig) => ({
  ...(await orig<typeof import('@/lib/operators/chat-dates/flow')>()),
  proposeChosenDates: (...args: unknown[]) => proposeChosenDates(...(args as [])),
}));

import {
  daysStep, dw, monthStep, parseWizardPayload, seatsStep, toursStep, WIZARD_SEATS, wizardDates, wizardMonths, wizardRule,
  type WizardStep,
} from '@/lib/operators/chat-dates/wizard';
import { datesWizardStart, handleDatesWizardPress } from '@/lib/operators/chat-dates/wizard-flow';
import { parseDatesPhrase } from '@/lib/operators/chat-dates/parse';
import { pressActionOf } from '@/lib/max/verified-press';
import type { PartnerChatContext, PartnerChatLookup } from '@/lib/kuzmich/operator-chat';

const NOV_15 = Date.parse('2026-11-15T00:00:00+12:00');
const TODAY = '2026-11-15';
const GORELY = { id: '41', title: 'Вулкан Горелый', active: true };
const FISH = { id: '42', title: 'Рыбалка на Быстрой', active: true };
const HIDDEN = { id: '43', title: 'Скрытый сплав', active: false };

const PARTNER = {
  partnerId: '11111111-1111-4111-8111-111111111111', category: 'operator', slug: 'op', userId: 'u1', sellsTours: true,
} as unknown as PartnerChatContext;
const found = (p: Partial<PartnerChatContext> = {}): PartnerChatLookup => ({ outcome: 'found', partner: { ...PARTNER, ...p } } as PartnerChatLookup);

function payloads(step: WizardStep): string[] {
  return step.rows.flat().map((b) => b.payload);
}

describe('кнопки шагов', () => {
  it('payload туда и обратно, короче 64 байт; чужое — null', () => {
    const all = [
      dw.tours(), dw.cancel(), dw.month('1234567890123456789'), dw.days('41', '2026-12'),
      dw.seats('41', '2026-12', 'e'), dw.go('1234567890123456789', '2027-01', 'w', 500),
    ];
    for (const p of all) {
      expect(Buffer.byteLength(p)).toBeLessThanOrEqual(64);
      expect(parseWizardPayload(p)).not.toBeNull();
    }
    expect(parseWizardPayload(dw.go('41', '2026-12', 'e', 6))).toEqual({ step: 'go', tourId: '41', month: '2026-12', pattern: 'e', seats: 6 });
    expect(parseWizardPayload(dw.days('41', '2027-01'))).toEqual({ step: 'days', tourId: '41', month: '2027-01' });
    for (const bad of ['dw:g:41:202612:e:0', 'dw:g:41:202612:e:501', 'dw:d:41:202613', 'dw:s:41:202612:z', 'dw:m:abc', 'dw:m:41:x', 'od:o:1', 'dw:']) {
      expect(parseWizardPayload(bad)).toBeNull();
    }
    expect(pressActionOf(dw.go('41', '2026-12', 'e', 6))).toBe('dates');
    expect(pressActionOf(dw.tours())).toBe('dates');
  });

  it('месяцы — текущий и три следующих, через Новый год', () => {
    expect(wizardMonths(TODAY)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
  });

  it('даты: без прошедших, без горизонта, по дням недели', () => {
    expect(wizardDates('2026-12', 'a', TODAY)).toHaveLength(31);
    expect(wizardDates('2026-12', 'e', TODAY)).toEqual(['2026-12-05', '2026-12-06', '2026-12-12', '2026-12-13', '2026-12-19', '2026-12-20', '2026-12-26', '2026-12-27']);
    expect(wizardDates('2026-12', 'w', TODAY)).toHaveLength(23);
    // Текущий месяц — с сегодняшнего дня.
    expect(wizardDates('2026-11', 'a', TODAY)[0]).toBe('2026-11-15');
    expect(wizardDates('2026-11', 'a', TODAY)).toHaveLength(16);
    // Горизонт записи — год вперёд: ноябрь следующего года — до 15-го.
    expect(wizardDates('2027-11', 'a', TODAY).at(-1)).toBe('2027-11-15');
    // Прошлый месяц — ни одной даты.
    expect(wizardDates('2026-10', 'a', TODAY)).toEqual([]);
  });

  it('дни шага совпадают с разбором равной фразы', () => {
    const tours = [GORELY];
    for (const [phrase, p] of [['открой выходные декабря, 15 мест', 'e'], ['открой будни декабря, 15 мест', 'w'], ['открой весь декабрь, 15 мест', 'a']] as const) {
      const parsed = parseDatesPhrase(phrase, NOV_15, tours);
      expect(parsed.kind).toBe('proposal');
      if (parsed.kind === 'proposal') {
        expect(parsed.dates).toEqual(wizardDates('2026-12', p, TODAY));
        expect(parsed.seats).toBe(15);
      }
    }
  });

  it('образец фразы на шаге мест разбирается в те же даты', () => {
    for (const p of ['a', 'e', 'w'] as const) {
      const step = seatsStep(GORELY, '2026-12', p, TODAY);
      const phrase = step.text.match(/«(открой [^»]+)»/)?.[1] ?? '';
      const parsed = parseDatesPhrase(phrase, NOV_15, [GORELY]);
      expect(parsed.kind).toBe('proposal');
      if (parsed.kind === 'proposal') expect(parsed.dates).toEqual(wizardDates('2026-12', p, TODAY));
    }
  });

  it('шаги: живые туры, месяцы, дни с числом дат, места; не больше трёх в ряду', () => {
    const tours = toursStep([GORELY, FISH, HIDDEN]);
    expect(payloads(tours)).toEqual([dw.month('41'), dw.month('42'), dw.cancel()]);
    expect(tours.text).toContain('Скрытым турам (1) даты не открываются');
    const many = toursStep(Array.from({ length: 11 }, (_, i) => ({ id: String(100 + i), title: `Тур ${i}`, active: true })));
    expect(payloads(many).filter((p) => p.startsWith('dw:m:'))).toHaveLength(8);
    expect(many.text).toContain('первые 8 из 11');

    const month = monthStep(GORELY, TODAY, true);
    expect(month.rows.flat().map((b) => b.text)).toEqual(['Ноябрь', 'Декабрь', 'Январь 2027', 'Февраль 2027', '‹ Тур', 'Отмена']);
    expect(payloads(monthStep(GORELY, TODAY, false))).not.toContain(dw.tours());

    const days = daysStep(GORELY, '2026-12', TODAY);
    expect(days.rows.flat().map((b) => b.text)).toEqual(['Каждый день (31)', 'Выходные (8)', 'Будни (23)', '‹ Месяц', 'Отмена']);
    // 28.11 — суббота: в ноябре остались только 28, 29, 30.
    const late = daysStep(GORELY, '2026-11', '2026-11-28');
    expect(late.rows.flat().map((b) => b.text)).toEqual(['Каждый день (3)', 'Выходные (2)', 'Будни (1)', '‹ Месяц', 'Отмена']);
    const none = daysStep(GORELY, '2026-10', TODAY);
    expect(payloads(none).some((p) => p.startsWith('dw:s:'))).toBe(false);
    expect(none.text).toContain('дней не осталось');

    const seats = seatsStep(GORELY, '2026-12', 'e', TODAY);
    expect(payloads(seats).filter((p) => p.startsWith('dw:g:'))).toEqual(WIZARD_SEATS.map((n) => dw.go('41', '2026-12', 'e', n)));
    expect(seats.text).toContain('выходные декабря 2026 — 8 дат');

    for (const step of [tours, many, month, days, seats]) {
      for (const row of step.rows) expect(row.length).toBeLessThanOrEqual(3);
      for (const p of payloads(step)) expect(parseWizardPayload(p)).not.toBeNull();
    }
    expect(seats.text).not.toMatch(/<script|Скрытый/);
  });

  it('название тура экранируется', () => {
    const step = monthStep({ id: '9', title: 'Тур <b>&</b>', active: true }, TODAY, false);
    expect(step.text).toContain('Тур &lt;b&gt;&amp;&lt;/b&gt;');
  });
});

describe('поток нажатий', () => {
  const sent: Array<{ text: string; rows?: unknown }> = [];
  const send = async (text: string, rows?: unknown) => { sent.push({ text, rows }); };
  const press = (payload: string, lookup: PartnerChatLookup = found()) => handleDatesWizardPress({
    payload, chatId: 77, lookup, send, nowMs: NOV_15,
  });

  beforeEach(() => {
    sent.length = 0;
    proposeChosenDates.mockClear();
    readPartnerTours.mockReset();
    readPartnerTours.mockResolvedValue([GORELY, FISH, HIDDEN]);
  });

  it('«Открыть» шага — общий путь предложения с датами, местами и правилом', async () => {
    await press(dw.go('41', '2026-12', 'e', 6));
    expect(proposeChosenDates).toHaveBeenCalledTimes(1);
    expect(proposeChosenDates.mock.calls[0]).toEqual([expect.objectContaining({
      chatId: 77, tourId: '41', seats: 6, dates: wizardDates('2026-12', 'e', TODAY),
      rule: wizardRule('2026-12', 'e'), weekdayWords: true,
    })]);
    expect(sent).toEqual([]);
  });

  it('скрытый и чужой тур — «тура нет», предложения нет', async () => {
    for (const id of ['43', '999']) {
      sent.length = 0;
      await press(dw.go(id, '2026-12', 'a', 6));
      expect(sent[0]?.text).toContain('Этого тура больше нет среди ваших живых');
    }
    await press(dw.month('999'));
    expect(proposeChosenDates).not.toHaveBeenCalled();
  });

  it('прошедший месяц на «Открыть» — «уже прошли», предложения нет', async () => {
    await press(dw.go('41', '2026-10', 'e', 6));
    expect(sent[0]?.text).toContain('уже прошли');
    expect(proposeChosenDates).not.toHaveBeenCalled();
  });

  it('право: без кабинета, не продавец, «не смог проверить», нет карточки', async () => {
    await press(dw.month('41'), found({ userId: null }));
    expect(sent.at(-1)?.text).toContain('кабинета нет');
    await press(dw.month('41'), found({ category: 'transfer', sellsTours: false }));
    expect(sent.at(-1)?.text).toContain('работает только в чате кабинета');
    await press(dw.month('41'), { outcome: 'unavailable' } as PartnerChatLookup);
    expect(sent.at(-1)?.text).toContain('Не смог проверить нажатие');
    await press(dw.month('41'), { outcome: 'none' } as PartnerChatLookup);
    expect(sent.at(-1)?.text).toContain('работает только в чате кабинета');
    expect(readPartnerTours).not.toHaveBeenCalled();
  });

  it('туры не прочитались — так и сказано; «Отмена» — ничего', async () => {
    readPartnerTours.mockResolvedValue(null);
    await press(dw.days('41', '2026-12'));
    expect(sent.at(-1)?.text).toContain('Не смог прочитать ваши туры');
    await press(dw.cancel());
    expect(sent.at(-1)).toEqual({ text: 'Хорошо, ничего не открываю.', rows: undefined });
  });

  it('старт: один живой тур — сразу месяц; ни одного — «нет активных туров»', async () => {
    readPartnerTours.mockResolvedValue([GORELY, HIDDEN]);
    const one = await datesWizardStart(PARTNER, NOV_15);
    expect(one.text).toContain('Какой месяц?');
    expect(payloads(one)).not.toContain(dw.tours());
    expect(one.text).toContain('Или фразой, например «открой весь декабрь, 8 мест»');
    readPartnerTours.mockResolvedValue([HIDDEN]);
    const zero = await datesWizardStart(PARTNER, NOV_15);
    expect(zero.text).toContain('нет активных туров');
    expect(zero.rows).toEqual([]);
  });
});
