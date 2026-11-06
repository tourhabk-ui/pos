/**
 * Закрытие парка на днях плана поездки (разбор планера 06.11, слово владельца
 * «Действуй»). Чистая часть: что тревога говорит о дне на его дату, порядок
 * строк дня и плана, порядок «Важно» у агента. Запрос к базе и привязка дня к
 * парку тем же PARK_SCOPED_SQL — tests/integration/alert-place-scope.pg.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  parkNoteForDay, parkVerdicts, clipTitle, kamchatkaDateOf, applyPlanParkStatus, PARK_STATUS_UNREAD_NOTE,
  type PlanParkAlert,
} from '@/lib/planner/park-status';
import { planWarningLines } from '@/lib/kuzmich/trip-plan-tool';
import { PARK_UNKNOWN_MAX_DAYS } from '@/lib/safety/park-closure-terms';

const SEASONAL = 'Маршруты природного парка «Налычево» закрыты на период межсезонья';
const closure = (over: Partial<PlanParkAlert> = {}): PlanParkAlert => ({
  ref_kind: 'route', ref_id: 'r-1', alert_id: 'a-1', alert_type: 'park_closure',
  title: SEASONAL, description: '',
  // 02.11 03:00 UTC — 02.11 на Камчатке; срок 23.11 03:00 UTC — 23.11.
  published_iso: '2026-11-02T03:00:00.000Z', expires_iso: '2026-11-23T03:00:00.000Z',
  ...over,
});
const TODAY = '2026-11-06';

describe('что тревога парка говорит о дне на его дату', () => {
  it('закрытие накрывает день до своего срока включительно — по дню Камчатки', () => {
    expect(parkNoteForDay(closure(), '2026-11-10', TODAY)).toEqual({
      severity: 'critical',
      text: `Закрытие парка по сводке от 02.11: «${SEASONAL}». Перед выходом уточните у дирекции парка.`,
    });
    expect(parkNoteForDay(closure(), '2026-11-23', TODAY)?.severity).toBe('critical');
    // 23.11 15:00 UTC — уже 24.11 на Камчатке: срок по местному дню.
    expect(parkNoteForDay(closure({ expires_iso: '2026-11-23T15:00:00.000Z' }), '2026-11-24', TODAY)?.severity).toBe('critical');
  });

  it('после срока сезонное закрытие без даты — «статус на этот день не известен», не дольше предела от сводки', () => {
    const after = parkNoteForDay(closure(), '2026-12-10', TODAY);
    expect(after?.severity).toBe('important');
    expect(after?.text).toMatch(/^Статус парка на этот день не известен: сводка от 02\.11 сообщала о закрытии маршрутов без даты открытия, сводку об открытии мы пока не нашли/);
    // Предел — числом из той же константы, что держит строку «не знаю».
    const lastDay = new Date(Date.parse('2026-11-02T00:00:00Z') + PARK_UNKNOWN_MAX_DAYS * 86_400_000).toISOString().slice(0, 10);
    const dayAfter = new Date(Date.parse(`${lastDay}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    expect(parkNoteForDay(closure(), lastDay, TODAY)?.severity).toBe('important');
    expect(parkNoteForDay(closure(), dayAfter, TODAY)).toBeNull();
  });

  it('закрытие с названной датой после неё о дне ничего не говорит', () => {
    const dated = closure({ title: 'Маршруты парка «Налычево» закрыты до 23 ноября' });
    expect(parkNoteForDay(dated, '2026-11-30', TODAY)).toBeNull();
  });

  it('«статус парка не известен» — заголовок строки и совет, в пределе от сводки; дня нет — судится сегодня', () => {
    const unknown = closure({
      alert_type: 'park_status_unknown',
      title: 'Статус парка «Налычево» не известен: последняя сезонная сводка от 02.11',
      expires_iso: '2026-11-07T03:00:00.000Z',
    });
    expect(parkNoteForDay(unknown, '2026-12-01', TODAY)).toEqual({
      severity: 'important',
      text: 'Статус парка «Налычево» не известен: последняя сезонная сводка от 02.11. Уточните у дирекции парка, открыты ли маршруты, до выхода.',
    });
    expect(parkNoteForDay(unknown, '2027-07-15', TODAY)).toBeNull();
    expect(parkNoteForDay(closure(), null, TODAY)?.severity).toBe('critical');
  });

  it('длинный заголовок сводки укорачивается по слову', () => {
    const long = 'Закрытие маршрутов «Вулканы Камчатки» сообщают о закрытии туристических маршрутов на всех территориях природных парков на период межсезонья в связи с погодными условиями и сходом снега';
    const c = clipTitle(long);
    expect(c.length).toBeLessThanOrEqual(161);
    expect(c.endsWith('…')).toBe(true);
    expect(long.startsWith(c.slice(0, -1))).toBe(true);
    expect(clipTitle(SEASONAL)).toBe(SEASONAL);
    expect(kamchatkaDateOf('2026-11-23T15:00:00.000Z')).toBe('2026-11-24');
  });
});

describe('раскладка по дням и предупреждения плана', () => {
  it('тревога — к своим дням по маршруту и туру; одна строка плана на тревогу с номерами дней; закрытие — первым', () => {
    const alerts: PlanParkAlert[] = [
      closure({ ref_kind: 'route', ref_id: 'r-1' }),
      closure({ ref_kind: 'tour', ref_id: '7' }),
      // Тот же тур через главное место — та же тревога, строка одна.
      closure({ ref_kind: 'tour', ref_id: '7' }),
      closure({
        ref_kind: 'tour', ref_id: '9', alert_id: 'u-1', alert_type: 'park_status_unknown',
        title: 'Статус парка «Быстринский» не известен: последняя сезонная сводка от 20.10',
      }),
    ];
    const { perDay, warnings } = parkVerdicts([
      { day: 1, title: 'Таловская тропа', dayIso: '2026-11-10', routeId: 'r-1' },
      { day: 2, title: 'Тур', dayIso: '2026-11-11', tourId: '7' },
      { day: 3, title: 'Город', dayIso: '2026-11-12' },
      { day: 4, title: 'Эссо', dayIso: '2026-11-13', tourId: '9' },
    ], alerts, TODAY);
    expect(perDay.map((v) => [v.day, v.notes.length])).toEqual([[1, 1], [2, 1], [4, 1]]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]!.severity).toBe('critical');
    expect(warnings[0]!.message).toMatch(/^Дни 1, 2: Закрытие парка по сводке от 02\.11/);
    expect(warnings[1]!.message).toMatch(/^День 4: Статус парка «Быстринский» не известен/);
  });

  it('строки дня встают ПЕРВЫМИ: агент видит три строки дня, и закрытие не уступает совету про снаряжение', async () => {
    const days = [{ day: 1, title: 'Тропа', dayWarnings: ['Треккинговые палки.', 'Вода.', 'Дождевик.'], routeId: 'r-1' }];
    const res = await applyPlanParkStatus(days, () => '2026-11-10', async <T,>() => ({ rows: [closure()] as unknown as T[] }), new Date('2026-11-06T00:00:00Z'));
    expect(days[0]!.dayWarnings[0]).toMatch(/^Закрытие парка/);
    expect(days[0]!.dayWarnings).toHaveLength(4);
    expect(res.warnings[0]!.severity).toBe('critical');
    // Повтор прохода строку не дублирует.
    await applyPlanParkStatus(days, () => '2026-11-10', async <T,>() => ({ rows: [closure()] as unknown as T[] }), new Date('2026-11-06T00:00:00Z'));
    expect(days[0]!.dayWarnings.filter((w) => w.startsWith('Закрытие парка'))).toHaveLength(1);
  });

  it('дней без ссылок нет — к базе не ходим; отказ базы — «проверить не удалось», а не «закрытий нет»', async () => {
    let calls = 0;
    const counting = async <T,>(): Promise<{ rows: T[] }> => { calls += 1; return { rows: [] }; };
    expect(await applyPlanParkStatus([{ day: 1, title: 'Прилёт', dayWarnings: [] }], () => null, counting)).toEqual({ warnings: [], unread: false });
    expect(calls).toBe(0);
    const failing = async <T,>(): Promise<{ rows: T[] }> => { throw Object.assign(new Error('boom'), { code: '57014' }); };
    const errLog: unknown[][] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { errLog.push(args); };
    try {
      const res = await applyPlanParkStatus([{ day: 1, title: 'Тропа', dayWarnings: [], routeId: 'r-1' }], () => null, failing);
      expect(res).toEqual({ warnings: [{ severity: 'important', message: PARK_STATUS_UNREAD_NOTE }], unread: true });
    } finally {
      console.error = orig;
    }
    expect(errLog.some((a) => a.join(' ').includes('57014'))).toBe(true);
  });
});

describe('«Важно» у агента: критическое не срезается потолком', () => {
  it('критическое из хвоста встаёт первым, раньше просьб человека и справок', () => {
    const lines = planWarningLines({
      warnings: [
        ...Array.from({ length: 7 }, (_, i) => ({ type: 'safety', severity: 'info' as const, message: `справка ${i + 1}` })),
        { type: 'safety', severity: 'critical' as const, message: 'День 3: Закрытие парка по сводке от 02.11' },
      ],
      preferences: { notes: [{ status: 'partial', message: 'Дни отдыха: один из двух' }, { status: 'honoured', message: 'не показывать' }] },
    });
    expect(lines[0]).toBe('День 3: Закрытие парка по сводке от 02.11');
    expect(lines[1]).toBe('Дни отдыха: один из двух');
    expect(lines).not.toContain('не показывать');
    expect(lines).toHaveLength(9);
  });
});
