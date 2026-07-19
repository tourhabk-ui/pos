/**
 * Лестница эскалации возврата с маршрута: решение шага (буферы, идемпотентность,
 * гашение подтверждением) и тексты уведомлений — все шаги уходят экстренному
 * контакту, обращение честное, в каждом сообщении есть ссылка «Я вернулся».
 */

import { describe, it, expect } from 'vitest';
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
