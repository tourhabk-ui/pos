/**
 * «Спланировать поездку» кнопками в MAX и Telegram (22.11): данные кнопки
 * ≤ 64 байт и без ПД, четыре шага, план — тем же инструментом движка без
 * модели, ответ — строка на день и две ссылки.
 */
import { describe, it, expect, vi } from 'vitest';
import type { DayPlan } from '@/lib/planner/engine';
import {
  CALLBACK_DATA_MAX_BYTES, WIZARD_BUTTON, daysWord, WIZARD_START, buildWizardPlan, decodeWizard, encodeWizard,
  isWizardPayload, startOptions, wizardPlanArgs, wizardPlannerHref, wizardScreen, wizardStale,
  type WizardScreen, type WizardState,
} from '@/lib/chat/trip-wizard';
import { TOURIST_BUTTONS, touristReplyMarkup } from '@/lib/telegram/tourist-keyboard';

// 22.11.2026 18:00 по Камчатке.
const NOW = Date.parse('2026-11-22T06:00:00Z');
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

function press(screen: WizardScreen, label: RegExp): WizardState {
  const b = screen.buttons.flat().find((x) => label.test(x.text));
  if (!b?.payload) throw new Error(`нет кнопки ${label}`);
  const s = decodeWizard(b.payload);
  if (!s) throw new Error(`не разобралась ${b.payload}`);
  return s;
}

function allPayloads(screen: WizardScreen): string[] {
  return screen.buttons.flat().map((b) => b.payload).filter((p): p is string => typeof p === 'string');
}

const day = (p: Partial<DayPlan>): DayPlan => ({
  day: 1, type: 'activity', zone: 'avachinsky', title: 'День', description: '', activityType: 'volcano',
  priceFrom: 0, priceTo: 0, coords: [53, 158], defaultTransport: 'jeep', allowedTransports: ['jeep'],
  difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: [], ...p,
} as DayPlan);

const DAYS: DayPlan[] = [
  day({ day: 1, type: 'arrival', title: 'Прилёт в Петропавловск-Камчатский' }),
  day({ day: 2, title: 'Авачинский вулкан', realTour: { tourId: '12', title: 'Авачинский вулкан' } as DayPlan['realTour'], availability: 'open' }),
  day({ day: 3, title: 'Долина гейзеров <вертолёт>', zone: 'eastern', realTour: { tourId: '40', title: 'Долина гейзеров' } as DayPlan['realTour'], availability: 'none' }),
  day({ day: 4, title: 'Паратунка, источники', zone: 'southern' }),
  day({ day: 5, title: 'Многодневный тур', realTour: { tourId: '77', title: 'Тур' } as DayPlan['realTour'], availability: 'unread' }),
  day({ day: 6, title: 'Многодневный тур', realTour: { tourId: '77', title: 'Тур' } as DayPlan['realTour'], availability: 'unread' }),
  day({ day: 7, type: 'departure', title: 'Вылет' }),
];

describe('кнопка и данные кнопок', () => {
  it('кнопка туриста в Telegram есть', () => {
    expect(TOURIST_BUTTONS).toContain(WIZARD_BUTTON);
    expect(touristReplyMarkup(false).keyboard.flat().map((b) => b.text)).toContain(WIZARD_BUTTON);
  });

  it('каждая кнопка каждого шага: ≤ 64 байт, разбирается, без длинных чисел (телефонов)', () => {
    const seen = new Set<string>();
    const queue: WizardScreen[] = [wizardScreen(WIZARD_START, NOW)];
    let guard = 0;
    while (queue.length && guard++ < 4000) {
      const screen = queue.shift()!;
      for (const p of allPayloads(screen)) {
        expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
        expect(isWizardPayload(p)).toBe(true);
        expect(p).not.toMatch(/\d{7,}/);
        const s = decodeWizard(p);
        expect(s).not.toBeNull();
        if (seen.has(p)) continue;
        seen.add(p);
        if (s!.step < 5 && seen.size < 600) queue.push(wizardScreen(s!, NOW));
      }
    }
    expect(seen.size).toBeGreaterThan(20);
  });

  it('мусор и чужие данные не разбираются', () => {
    for (const bad of ['tp:', 'tp:9:-:-:-:-:0', 'tp:1:261301:-:-:-:0', 'tp:2:261215:8:-:-:0', 'tp:3:261215:7:9:-:0',
      'tp:4:261215:7:2:9:0', 'tp:4:261215:7:2:0:fff', 'tp:4:261215:7:2:0:0:+79991234567', 'rm:op:in']) {
      expect(decodeWizard(bad)).toBeNull();
    }
  });

  it('кодирование туда и обратно', () => {
    const s: WizardState = { step: 4, start: '2027-01-01', days: 10, adults: 4, kid: 4, mask: 0b1010000011 };
    expect(decodeWizard(encodeWizard(s))).toEqual(s);
  });

  it('старт: через 2 недели и первые числа следующих месяцев, не в прошлом', () => {
    const opts = startOptions(NOW);
    expect(opts[0]!.iso).toBe('2026-12-06');
    expect(opts.slice(1).map((o) => o.iso)).toEqual(['2027-01-01', '2027-02-01', '2027-03-01', '2027-04-01', '2027-05-01']);
  });

  it('кнопка с прошедшей датой — устарела', () => {
    expect(wizardStale({ ...WIZARD_START, step: 2, start: '2026-11-01' }, NOW)).toBe(true);
    expect(wizardStale({ ...WIZARD_START, step: 2, start: '2026-12-06' }, NOW)).toBe(false);
  });
});

describe('диалог целиком', () => {
  it('когда → дни → взрослые → ребёнок → интересы → план', async () => {
    const s0 = wizardScreen(WIZARD_START, NOW);
    expect(s0.text).toMatch(/без имени и телефона/);
    const s1 = press(s0, /^Январь 2027/);
    const scr1 = wizardScreen(s1, NOW);
    const s2 = press(scr1, /^7$/);
    const s3 = press(wizardScreen(s2, NOW), /^2$/);
    const s4 = press(wizardScreen(s3, NOW), /^7–11 лет$/);
    const scr4 = wizardScreen(s4, NOW);
    expect(scr4.buttons.flat().map((b) => b.text)).toEqual(expect.arrayContaining(['Вулканы', 'Рыбалка', 'Снегоходы']));
    const s5 = press(scr4, /^Вулканы$/);
    const s6 = press(wizardScreen(s5, NOW), /^Источники$/);
    const scr6 = wizardScreen(s6, NOW);
    expect(scr6.buttons.flat().map((b) => b.text)).toEqual(expect.arrayContaining(['✅ Вулканы', '✅ Источники']));
    const go = press(scr6, /^Собрать план$/);
    expect(go.step).toBe(5);

    const makePlan = vi.fn(async () => `заметки\n\nплан…\n\nСтраница плана: https://vedarai.ru/trip/${ID}`);
    const loadDays = vi.fn(async () => DAYS);
    const out = await buildWizardPlan(go, { makePlan, loadDays, site: 'https://vedarai.ru' });

    expect(makePlan).toHaveBeenCalledWith({
      when: '2027-01-01', days: '7', adults: '2', children: '7 лет', interests: 'вулканы, термальные источники',
    });
    expect(loadDays).toHaveBeenCalledWith(ID);
    expect(out.text.split('\n')).toEqual(expect.arrayContaining([
      'День 1, 01.01 — Прилёт в Петропавловск-Камчатский',
      'День 2, 02.01 — Авачинский вулкан — места есть',
      'День 3, 03.01 — Долина гейзеров &lt;вертолёт&gt; — свободных мест на эти даты нет',
      'Дни 5–6, 05.01–06.01 — Многодневный тур — места не проверены',
      'День 7, 07.01 — Вылет',
    ]));
    expect(out.text).toMatch(/не бронь/);
    expect(out.text).not.toMatch(/телефон/i);
    const urls = out.buttons.flat().map((b) => b.url).filter(Boolean);
    expect(urls).toEqual([
      `https://vedarai.ru/trip/${ID}`,
      'https://vedarai.ru/planner?from=2027-01-01&days=7&hint=volcano%2Cthermal&adults=2&children=7',
    ]);
  });

  it('дни словом', () => {
    expect([1, 3, 5, 7, 10, 14, 21, 22].map(daysWord)).toEqual(['1 день', '3 дня', '5 дней', '7 дней', '10 дней', '14 дней', '21 день', '22 дня']);
  });

  it('без интересов — «классика», аргумента interests нет', () => {
    const s = { step: 5, start: '2027-01-01', days: 5, adults: 1, kid: 0, mask: 0 } as const;
    expect(wizardPlanArgs(s)).toEqual({ when: '2027-01-01', days: '5', adults: '1' });
    expect(wizardPlannerHref(s)).toBe('https://vedarai.ru/planner?from=2027-01-01&days=5&adults=1');
  });

  it('движок отказал (нет черновика) — его текст и кнопка в планер, строк дней нет', async () => {
    const s: WizardState = { step: 5, start: '2027-01-01', days: 5, adults: 2, kid: 1, mask: 0 };
    const out = await buildWizardPlan(s, { makePlan: async () => 'В январе рыбалки нет.', loadDays: async () => null });
    expect(out.text).toBe('В январе рыбалки нет.');
    expect(out.buttons.flat().some((b) => b.text === 'Изменить в планере')).toBe(true);
    expect(out.buttons.flat().some((b) => b.text === 'Открыть план целиком')).toBe(false);
  });

  it('движок упал — честный отказ, без падения', async () => {
    const s: WizardState = { step: 5, start: '2027-01-01', days: 5, adults: 2, kid: 0, mask: 1 };
    const out = await buildWizardPlan(s, { makePlan: async () => { throw new Error('db'); }, loadDays: async () => null });
    expect(out.text).toMatch(/не собрался/);
  });

  it('неполное состояние — не собирает', async () => {
    const makePlan = vi.fn(async () => '');
    const out = await buildWizardPlan({ ...WIZARD_START, step: 5 }, { makePlan, loadDays: async () => null });
    expect(makePlan).not.toHaveBeenCalled();
    expect(out.text).toMatch(/сначала/);
  });
});
