/**
 * Лестница эскалации возврата с маршрута: решение шага (буферы, идемпотентность,
 * ОТСРОЧКА подтверждением — не отмена) и тексты уведомлений. Все шаги уходят
 * экстренному контакту, обращение честное, в каждом сообщении есть обе отметки:
 * «я вернулся» (закрывает маршрут) и «мы в порядке» (только отодвигает шаг).
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
  formatKamchatkaTime,
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

  /**
   * Отметка «я в порядке» ОТОДВИГАЕТ лестницу, но не отменяет её.
   *
   * Раньше здесь стоял `return null`: одно подтверждение снимало тревогу
   * навсегда, включая шаг МЧС. Ветка была мёртвой (писать
   * `checkin_confirmed_at` было некому) и потому безобидной — ровно до дня,
   * когда появилась кнопка «мы в порядке». Тогда это стало дырой в том
   * самом месте, ради которого платформа существует: группа отмечается
   * «идём, задерживаемся», через час с ней случается беда, и сторож молчит
   * до конца времён.
   */
  it('свежее подтверждение отодвигает следующий шаг на буфер, а не отменяет лестницу', () => {
    const confirm = hoursAfter(1.2);
    // Сразу после отметки — тихо.
    expect(decideEscalation(T0, 'day', ['soft'], confirm, hoursAfter(2))).toBeNull();
    // Через буфер hard (3ч) от ОТМЕТКИ, а не от контрольного времени — шаг идёт.
    expect(decideEscalation(T0, 'day', ['soft'], confirm, hoursAfter(3.5))).toBeNull();
    expect(decideEscalation(T0, 'day', ['soft'], confirm, hoursAfter(4.5))?.step).toBe('hard');
    // И до МЧС лестница доходит: подтверждение не выключает её насовсем.
    expect(decideEscalation(T0, 'day', ['soft', 'hard'], confirm, hoursAfter(10))?.step).toBe('mchs');
  });

  it('старое подтверждение (до контрольного времени) не отодвигает ничего', () => {
    const stale = new Date(T0.getTime() - 3_600_000);
    expect(decideEscalation(T0, 'day', [], stale, hoursAfter(1.5))?.step).toBe('soft');
  });

  it('просрочка считается от контрольного времени, а часы с отметки — отдельно', () => {
    const d = decideEscalation(T0, 'day', ['soft'], hoursAfter(1.2), hoursAfter(4.5));
    // Правда о просрочке не должна уезжать из-за отметки: контакту важно
    // знать, что группа опаздывает 4.5 ч, а не 3.3.
    expect(d?.hoursOverdue).toBeCloseTo(4.5, 5);
    expect(d?.hoursSinceConfirm).toBeCloseTo(3.3, 5);
    expect(decideEscalation(T0, 'day', [], null, hoursAfter(1.5))?.hoursSinceConfirm).toBeNull();
  });

  /**
   * Пороги многодневки — перенесены из второго набора тестов того же модуля
   * (`lib/safety/checkin-escalation.test.ts`, удалён 09.09).
   *
   * Наборов было ДВА, и они разошлись ровно там, где это опаснее всего: про
   * подтверждение один говорил «гасит тревогу навсегда», другой — «отодвигает
   * шаг». Правило, записанное дважды, — это два правила (§12); в сторожах цена
   * та же, что в коде.
   */
  it('многодневка: soft после 3ч, hard после 6ч, mchs после 18ч', () => {
    expect(decideEscalation(T0, 'multi', [], null, hoursAfter(2))).toBeNull();
    expect(decideEscalation(T0, 'multi', [], null, hoursAfter(3))?.step).toBe('soft');
    expect(decideEscalation(T0, 'multi', ['soft'], null, hoursAfter(6))?.step).toBe('hard');
    expect(decideEscalation(T0, 'multi', ['soft', 'hard'], null, hoursAfter(18))?.step).toBe('mchs');
  });

  it('однодневка и многодневка на одном часе дают разные шаги', () => {
    expect(decideEscalation(T0, 'day', [], null, hoursAfter(3.5))?.step).toBe('hard');
    expect(decideEscalation(T0, 'multi', [], null, hoursAfter(3.5))?.step).toBe('soft');
  });

  it('все шаги пройдены — тишина', () => {
    expect(decideEscalation(T0, 'day', ['soft', 'hard', 'mchs'], null, hoursAfter(10))).toBeNull();
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

  it('soft и hard дают вторую ссылку — «мы в пути, всё в порядке»', () => {
    // Без неё снять тревогу можно было только отметкой о ВОЗВРАТЕ, то есть
    // соврав и выключив сторожа.
    const withCheckin = { ...msgInput, checkinUrl: 'https://vedarai.ru/checkin-ok?id=abc-123' };
    for (const step of ['soft', 'hard'] as const) {
      const m = buildEscalationMessage(withCheckin, step, 2);
      expect(m).toContain(withCheckin.checkinUrl);
      expect(m).toContain('номер телефона руководителя');
    }
  });

  it('часы с последней отметки называются, когда отметка была', () => {
    const m = buildEscalationMessage({ ...msgInput, hoursSinceConfirm: 3.2 }, 'hard', 5);
    expect(m).toContain('3.2 ч назад');
    expect(buildEscalationMessage(msgInput, 'hard', 5)).not.toContain('всё в порядке» —');
  });

  it('шаг МЧС предупреждает о дубле, но остаётся тревогой', () => {
    const m = buildEscalationMessage({ ...msgInput, mchsInformedText: '19.07 21:30 (камч.)' }, 'mchs', 9);
    expect(m).toContain('19.07 21:30');
    expect(m).toContain('не дублируйте');
    // Самоотчёт человека — не подтверждение приёма заявки: тревога не снимается.
    expect(m).toContain('ЭКСТРЕННАЯ СИТУАЦИЯ');
    expect(m).toContain('112');
  });

  it('soft адресован экстренному контакту, а не туристу (реальный получатель)', () => {
    const soft = buildEscalationMessage(msgInput, 'soft', 1.5);
    expect(soft).not.toContain('Вы зарегистрировали');
    expect(soft).toContain('Свяжитесь с руководителем');
    expect(soft).toContain(msgInput.leaderPhone);
  });

  it('время по Камчатке считается сдвигом, а не локалью рантайма', () => {
    // На урезанной сборке ICU `toLocaleString` молча отдаёт UTC — время
    // звонка в 112 уехало бы на двенадцать часов, и никто бы не заметил.
    expect(formatKamchatkaTime(new Date('2026-07-19T09:30:00Z'))).toBe('19.07 21:30 (камч.)');
    expect(formatKamchatkaTime(new Date('2026-07-19T13:00:00Z'))).toBe('20.07 01:00 (камч.)');
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
