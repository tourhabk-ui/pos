/**
 * Лестница эскалации возврата с маршрута: решение шага (буферы, идемпотентность,
 * гашение подтверждением) и тексты уведомлений — все шаги уходят экстренному
 * контакту, обращение честное, в каждом сообщении есть ссылка «Я вернулся».
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decideEscalation,
  resolveControlTime,
  tripKindFromDates,
  buildEscalationMessage,
  formatPositionText,
  type EscalationMessageInput,
} from '@/lib/safety/checkin-escalation';

const T0 = new Date('2026-07-19T20:00:00+12:00'); // контрольное время
const hoursAfter = (h: number) => new Date(T0.getTime() + h * 3_600_000);

const msgInput: EscalationMessageInput = {
  routeName: 'Авачинский перевал',
  leaderName: 'Иван Петров',
  leaderPhone: '+7 914 111-22-33',
  emergencyContactName: 'Мария Петрова',
  emergencyContactPhone: '+7 914 444-55-66',
  positionText: '53.02000° N, 158.65000° E',
  returnUrl: 'https://vedarai.ru/return?id=abc-123',
  checkinUrl: 'https://vedarai.ru/checkin-ok?id=abc-123',
};

describe('decideEscalation', () => {
  it('однодневка: soft после 1ч, hard после 3ч, mchs после 8ч', () => {
    expect(decideEscalation(T0, 'day', [], null, hoursAfter(0.5))).toBeNull();
    expect(decideEscalation(T0, 'day', [], null, hoursAfter(1.5))?.step).toBe('soft');
    expect(decideEscalation(T0, 'day', ['soft'], null, hoursAfter(3.5))?.step).toBe('hard');
    expect(decideEscalation(T0, 'day', ['soft', 'hard'], null, hoursAfter(9))?.step).toBe('mchs');
  });

  it('уже отправленный шаг не повторяется (идемпотентность)', () => {
    expect(decideEscalation(T0, 'day', ['soft'], null, hoursAfter(1.5))).toBeNull();
  });

  it('подтверждение ПОСЛЕ контрольного времени гасит тревогу, старое — нет', () => {
    expect(decideEscalation(T0, 'day', [], hoursAfter(0.2), hoursAfter(2))).toBeNull();
    const stale = new Date(T0.getTime() - 3_600_000);
    expect(decideEscalation(T0, 'day', [], stale, hoursAfter(1.5))?.step).toBe('soft');
  });

  it('resolveControlTime: без expected_return_at — end_date 20:00', () => {
    const end = new Date('2026-07-19T00:00:00');
    expect(resolveControlTime(end, null).getHours()).toBe(20);
    const explicit = new Date('2026-07-19T16:30:00');
    expect(resolveControlTime(end, explicit)).toEqual(explicit);
  });

  it('tripKindFromDates: одна дата — day, разные — multi', () => {
    const d = new Date('2026-07-19');
    expect(tripKindFromDates(d, d)).toBe('day');
    expect(tripKindFromDates(d, new Date('2026-07-21'))).toBe('multi');
  });
});

describe('buildEscalationMessage', () => {
  it('каждый шаг содержит ссылку «Я вернулся»', () => {
    for (const step of ['soft', 'hard', 'mchs'] as const) {
      expect(buildEscalationMessage(msgInput, step, 2)).toContain(msgInput.returnUrl);
    }
  });

  it('soft адресован экстренному контакту, а не туристу (реальный получатель)', () => {
    const soft = buildEscalationMessage(msgInput, 'soft', 1.5);
    expect(soft).not.toContain('Вы зарегистрировали');
    expect(soft).toContain('Свяжитесь с руководителем');
    expect(soft).toContain(msgInput.leaderPhone);
  });

  it('soft несёт ссылку «мы на связи» — единственная ступень, где decideEscalation гасится подтверждением без возврата', () => {
    const soft = buildEscalationMessage(msgInput, 'soft', 1.5);
    expect(soft).toContain(msgInput.checkinUrl);
  });

  it('hard и mchs не предлагают «мы на связи» — эти ступени про реальную тревогу, не про задержку', () => {
    expect(buildEscalationMessage(msgInput, 'hard', 4)).not.toContain(msgInput.checkinUrl);
    expect(buildEscalationMessage(msgInput, 'mchs', 9)).not.toContain(msgInput.checkinUrl);
  });

  it('без checkinUrl soft не ломается — поле необязательное', () => {
    const { checkinUrl: _unused, ...withoutCheckin } = msgInput;
    expect(() => buildEscalationMessage(withoutCheckin, 'soft', 1.5)).not.toThrow();
  });

  it('hard и mchs содержат позицию и 112; mchs — данные экстренного контакта', () => {
    const hard = buildEscalationMessage(msgInput, 'hard', 4);
    expect(hard).toContain(msgInput.positionText);
    expect(hard).toContain('112');
    const mchs = buildEscalationMessage(msgInput, 'mchs', 9);
    expect(mchs).toContain(msgInput.emergencyContactName);
    expect(mchs).toContain('112');
  });
});

describe('formatPositionText', () => {
  it('координаты форматируются, отсутствие — «неизвестно»', () => {
    expect(formatPositionText('53.0195', '158.6505')).toBe('53.01950° N, 158.65050° E');
    expect(formatPositionText(null, '158.65')).toBe('неизвестно');
  });
});

/**
 * Сбой на одном туристе не хоронит очередь.
 *
 * ── Чем это опасно именно здесь ────────────────────────────────────────────
 *
 * Сторож возвращения обходит просроченных туристов и поднимает эскалацию до
 * МЧС. Выборка идёт `ORDER BY expected_return_at ASC` — то есть ПЕРВЫМ
 * обрабатывается самый просроченный, тот, о ком тревожатся сильнее всех.
 *
 * Тело цикла не было защищено вовсе. Любое исключение — отправка в Telegram,
 * запись уведомления, недоступная база — роняло весь обработчик, и очередь
 * тех, кто стоял за сбойной записью, не обрабатывалась. Молча: до
 * `recordCronRun` выполнение не доходило, и в реестре кронов прогон выглядел
 * не упавшим, а НЕ ЗАПУСКАВШИМСЯ.
 *
 * Находка эволюции 19.08 («Нет try/catch вокруг sendTelegram»), первая
 * разобранная после четырёх суток немоты решателя.
 */
describe('очередь эскалации переживает сбой на одном человеке', () => {
  const SRC = readFileSync(join(process.cwd(), 'app/api/cron/checkin-watchdog/route.ts'), 'utf-8');

  it('тело цикла обёрнуто в try/catch', () => {
    const loop = SRC.slice(SRC.indexOf('for (const reg of rows)'));
    expect(loop.slice(0, 200)).toMatch(/try\s*\{/);
    expect(loop).toMatch(/catch \(err\)/);
  });

  it('пропущенные люди считаются и попадают в ответ', () => {
    expect(SRC).toMatch(/let failed = 0/);
    expect(SRC).toMatch(/failed,\s*ts:/);
  });

  it('прогон с пропущенными НЕ отчитывается успехом', () => {
    // Иначе сторож ляжет наполовину, а реестр кронов покажет здоровье.
    expect(SRC).toMatch(/failed > 0 \? 'failed' : 'success'/);
    expect(SRC).toMatch(/success: failed === 0/);
  });

  it('отправка в Telegram не выпускает исключение наружу', () => {
    // `.catch()` на промисе ловил только сетевой отказ: сам fetch может
    // бросить синхронно на кривом базовом адресе, и тогда не выполнится
    // следующая строка — запись шага эскалации.
    const fn = SRC.slice(SRC.indexOf('async function sendTelegram'), SRC.indexOf('async function recordNotification'));
    expect(fn).toMatch(/try\s*\{/);
    expect(fn).toMatch(/catch/);
  });
});
