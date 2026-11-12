/**
 * change_request — отмена и перенос заявки на тур ИИ-агентом по ключу заявки
 * (слово владельца 11.11: «мы доверяем агенту», «как самим человеком»).
 *
 * Судится вызовом двери (lib/mcp/change-request) и роута: база и отправка
 * подменены, остальное — настоящий код, включая ядро отмены и смены даты.
 * Настоящий SQL права и записи — tests/integration/request-chat.pg.test.ts.
 *
 * Что здесь держится:
 *   - право: менять заявку даёт только ключ новой заявки на тур на дату;
 *   - проба (`test: true`) ничего не пишет и никому ничего не шлёт;
 *   - оператору названо, что действие передал ИИ-агент, а не человек в чате;
 *   - агенту сказано, кто узнал на деле, и в ответе нет ключа и номера заявки;
 *   - ключ не попадает в журнал вызовов.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ query: vi.fn(), notify: vi.fn(), alert: vi.fn(), event: vi.fn(), log: vi.fn() }));

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (sql: string, params?: unknown[]) => h.query(sql, params ?? []),
    connect: async () => ({ query: (sql: string, params?: unknown[]) => h.query(sql, params ?? []), release: () => {} }),
  },
}));
vi.mock('@/lib/requests/notify-request-operator', async (orig) => ({
  ...(await orig<typeof import('@/lib/requests/notify-request-operator')>()),
  notifyRequestOperator: (a: unknown) => h.notify(a),
}));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: (p: unknown) => h.alert(p) }));
vi.mock('@/lib/crm/events', async (orig) => ({
  ...(await orig<typeof import('@/lib/crm/events')>()),
  recordSourceEventQuietly: (e: unknown) => h.event(e),
}));
vi.mock('@/lib/kuzmich/core', () => ({ executeKuzmichTool: async () => 'ok' }));
vi.mock('@/lib/mcp/call-log', () => ({ logMcpToolCall: (e: unknown) => h.log(e), logMcpClient: () => undefined }));

import {
  changeRequest, CHANGE_KEY_SQL, CHANGE_CANCEL_LEAD_SQL, CHANGE_DATE_LEAD_SQL,
} from '@/lib/mcp/change-request';
import {
  CHANGE_OUTCOMES, CHANGE_TOLD, CHANGE_REQUEST_OUTPUT_SCHEMA, CHANGE_REQUEST_RULE, CHANGE_REQUEST_TOOL_NAME,
} from '@/lib/mcp/change-request-schema';
import {
  CANCEL_NOW_SQL, CANCEL_REQUEST_SQL, CANCEL_DELIVERY_SQL, CANCEL_REQUEST_UNDELIVERED_SQL, CANCEL_REQUEST_RELEASE_SQL,
} from '@/lib/requests/cancel-request';
import {
  MY_TRIP_DATE_CHANGE_SQL, MY_TRIP_DATE_DELIVERY_SQL, MY_TRIP_DATE_REQUEST_LOG_SQL, MY_TRIP_DATE_DAILY_LIMIT,
} from '@/lib/requests/my-trip-date';
import { DATE_CHANGE_DAILY_LIMIT } from '@/lib/requests/date-change-limit';
import { FREE_DATES_SQL, TOUR_HAS_CALENDAR_SQL } from '@/lib/tours/nearest-free-date';
import { McpUserError } from '@/lib/mcp/jsonrpc';
import { CHANGE_REQUEST_TOOL, CHANGE_TOOL_NAMES, PUBLIC_MCP_TOOLS, WRITE_TOOL_NAMES } from '@/lib/mcp/public-tools';
import { runPublicTool } from '@/app/api/mcp/route';
import { storableTask } from '@/lib/a2a/durable-store';

const KEY = 'Zq3vT-xYLmK_aB7cDreFlgH8jNopRisU';
const LEAD = 'b3f0c7a2-1d4e-4f6a-9b8c-0a1b2c3d4e5f';
const OPERATOR = '11111111-2222-4333-8444-555555555555';
/** 01.06.2027 по UTC — «сегодня» для двери; даты заявки — после него. */
const NOW = Date.UTC(2027, 5, 1, 0, 0, 0);

interface KeyRow {
  tool_name: string; opens_chat: boolean; lead_id: string | null; seat_request_id: string | null; stay_request_id: string | null;
  lead_is_self: boolean | null; lead_addressed: boolean | null; lead_kind: string | null;
}
const tourKey = (over: Partial<KeyRow> = {}): KeyRow => ({
  tool_name: 'create_booking_request', opens_chat: true, lead_id: LEAD, seat_request_id: null, stay_request_id: null,
  lead_is_self: false, lead_addressed: true, lead_kind: null, ...over,
});

const lead = (over: Record<string, unknown> = {}) => ({
  id: LEAD, status: 'new', operator_id: OPERATOR, date: '2027-07-15', tour_id: 42, participants: 3,
  tour_title: 'Горелый & кратер <малый>', booking_status: null, booking_date: null,
  answered: false, cancel_request: null, refused_dates: null, date_actions: 0, ...over,
});

interface World {
  key: KeyRow | null | Error;
  lead: ReturnType<typeof lead> | null | Error;
  /** Строка условной отмены; null — запись не прошла. */
  cancelNow: { log_id: string; prev_status: string | null; operator_id: string | null } | null;
  cancelRequest: string | null;
  free: { date: string; free: number }[];
  hasCalendar: boolean;
  changed: string | null;
  requested: string | null;
}
let world: World;

const WRITES = [
  CANCEL_NOW_SQL, CANCEL_REQUEST_SQL, CANCEL_DELIVERY_SQL, CANCEL_REQUEST_UNDELIVERED_SQL, CANCEL_REQUEST_RELEASE_SQL,
  MY_TRIP_DATE_CHANGE_SQL, MY_TRIP_DATE_REQUEST_LOG_SQL, MY_TRIP_DATE_DELIVERY_SQL,
];
const callsOf = (sql: string) => h.query.mock.calls.filter(([s]) => s === sql).map(([, p]) => p as unknown[]);
const writes = () => h.query.mock.calls.filter(([s]) => WRITES.includes(s as string));

beforeEach(() => {
  h.query.mockReset();
  h.notify.mockReset().mockResolvedValue('max');
  h.alert.mockReset().mockResolvedValue({ channel: 'max', delivered: true, reason: 'доставлено' });
  h.event.mockReset().mockResolvedValue(undefined);
  h.log.mockReset();
  world = {
    key: tourKey(), lead: lead(), cancelNow: { log_id: '701', prev_status: 'new', operator_id: OPERATOR }, cancelRequest: '702',
    free: [{ date: '2027-07-18', free: 5 }, { date: '2099-07-18', free: 5 }], hasCalendar: true, changed: '801', requested: '802',
  };
  h.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql === CHANGE_KEY_SQL) {
      if (world.key instanceof Error) throw world.key;
      return { rows: world.key ? [world.key] : [] };
    }
    if (sql === CHANGE_CANCEL_LEAD_SQL || sql === CHANGE_DATE_LEAD_SQL) {
      if (world.lead instanceof Error) throw world.lead;
      return { rows: world.lead ? [world.lead] : [] };
    }
    if (sql === CANCEL_NOW_SQL) return { rows: world.cancelNow ? [world.cancelNow] : [] };
    if (sql === CANCEL_REQUEST_SQL) return { rows: world.cancelRequest ? [{ log_id: world.cancelRequest }] : [] };
    if (sql === FREE_DATES_SQL) {
      const only = params[3] as string | null;
      return { rows: only ? world.free.filter((d) => d.date === only) : world.free };
    }
    if (sql === TOUR_HAS_CALENDAR_SQL) return { rows: [{ has: world.hasCalendar }] };
    if (sql === MY_TRIP_DATE_CHANGE_SQL) return { rows: world.changed ? [{ log_id: world.changed }] : [] };
    if (sql === MY_TRIP_DATE_REQUEST_LOG_SQL) return { rows: world.requested ? [{ log_id: world.requested }] : [] };
    if (WRITES.includes(sql)) return { rows: [] };
    throw new Error(`неожиданный запрос: ${sql.slice(0, 70)}`);
  });
});

const call = (args: Record<string, unknown>, via: 'mcp' | 'a2a' = 'mcp') => changeRequest({ key: KEY, ...args }, via, { now: NOW });
const refusalOf = async (p: Promise<unknown>): Promise<McpUserError> => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(McpUserError);
  return err as McpUserError;
};
const sentToOperator = () => (h.notify.mock.calls[0]![0] as { text: (b: boolean) => string }).text(false);

describe('право: чей ключ меняет заявку', () => {
  it('условие права стоит в самом чтении заявки: живой ключ новой заявки на тур, не своя проба', () => {
    for (const sql of [CHANGE_CANCEL_LEAD_SQL, CHANGE_DATE_LEAD_SQL]) {
      expect(sql).toMatch(/k\.key_hash = \$1 AND k\.expires_at > NOW\(\)/);
      expect(sql).toMatch(/k\.opens_chat AND k\.tool_name = 'create_booking_request'/);
      expect(sql).toMatch(/l\.is_self = FALSE/);
      expect(sql).toMatch(/JOIN leads l ON l\.id = k\.lead_id/);
    }
    // Перенос требует адресата, отмена — нет (большую группу без адресата отменить можно).
    expect(CHANGE_DATE_LEAD_SQL).toMatch(/l\.operator_id IS NOT NULL/);
    expect(CHANGE_CANCEL_LEAD_SQL).not.toMatch(/l\.operator_id IS NOT NULL/);
  });

  it('в базу уходит hash ключа, а не ключ', async () => {
    await call({ action: 'cancel', test: true });
    for (const [, params] of h.query.mock.calls) expect(JSON.stringify(params)).not.toContain(KEY);
    expect((callsOf(CHANGE_KEY_SQL)[0]![0] as string)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ключ не той формы и пробный ключ — отказ до базы', async () => {
    expect((await refusalOf(changeRequest({ key: 'коротко', action: 'cancel' }, 'mcp'))).code).toBe('invalid_args:key');
    const probe = await refusalOf(changeRequest({ key: 'test_lead_op_AbCdEfGhIjKlMnOp', action: 'cancel' }, 'mcp'));
    expect(probe.code).toBe('test_key');
    expect(probe.message).toMatch(/пробной заявки.*менять нечего/);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('ключа нет или он истёк — отказ, ничего не записано', async () => {
    world.key = null;
    expect((await refusalOf(call({ action: 'cancel' }))).code).toBe('key_not_found');
    expect(writes()).toHaveLength(0);
  });

  it('ключ повтора и ключ своей пробы владельца видят статус, но не меняют', async () => {
    for (const k of [tourKey({ opens_chat: false }), tourKey({ lead_is_self: true })]) {
      world.key = k;
      const r = await refusalOf(call({ action: 'cancel' }));
      expect(r.code).toBe('status_only_key');
      expect(r.message).toMatch(/только показывает статус/);
      // Заявку по такому ключу дверь даже не читает.
      expect(callsOf(CHANGE_CANCEL_LEAD_SQL)).toHaveLength(0);
    }
    expect(writes()).toHaveLength(0);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('не заявка на тур — отказ словами, каким это ключом было', async () => {
    const cases: Array<[Partial<KeyRow>, RegExp]> = [
      [{ tool_name: 'create_stay_request', lead_id: null, stay_request_id: 's-1' }, /заявка на жильё.*владелец жилья/],
      [{ lead_id: null, seat_request_id: 'r-1', opens_chat: false }, /запрос мест у оператора/],
      [{ tool_name: 'create_lead' }, /заявка на подбор/],
      [{ tool_name: 'request_charter' }, /заявка на машину.*перевозчик/],
      [{ tool_name: 'create_car_rental_request' }, /заявка на прокат.*прокатчик/],
      [{ tool_name: 'partner-lead-form' }, /заявка другого вида/],
    ];
    for (const [over, words] of cases) {
      world.key = tourKey(over);
      const r = await refusalOf(call({ action: 'cancel' }));
      expect(r.code, JSON.stringify(over)).toBe('not_supported');
      expect(r.message, JSON.stringify(over)).toMatch(words);
      expect(r.message).toMatch(/Заявка не изменена\.$/);
    }
    expect(writes()).toHaveLength(0);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('ключ годился, а заявка по праву не прочиталась (истёк между чтениями) — отказ, не отмена', async () => {
    world.lead = null;
    expect((await refusalOf(call({ action: 'cancel' }))).code).toBe('key_not_found');
    expect(writes()).toHaveLength(0);
  });

  it('база не ответила — исключение, а не отказ по входу и не «отменено»', async () => {
    world.key = Object.assign(new Error('boom'), { code: '57014' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(call({ action: 'cancel' })).rejects.not.toBeInstanceOf(McpUserError);
    world.key = tourKey();
    world.lead = Object.assign(new Error('boom'), { code: '57014' });
    await expect(call({ action: 'cancel' })).rejects.not.toBeInstanceOf(McpUserError);
    expect(err.mock.calls.flat().join(' ')).toContain('SQLSTATE=57014');
    expect(writes()).toHaveLength(0);
    err.mockRestore();
  });
});

describe('аргументы', () => {
  it('действие обязательно и одно из двух; перенос — только с настоящей будущей датой', async () => {
    expect((await refusalOf(call({}))).code).toBe('invalid_args:action');
    expect((await refusalOf(call({ action: 'delete' }))).code).toBe('invalid_args:action');
    expect((await refusalOf(call({ action: 'change_date' }))).message).toMatch(/нужна новая дата/);
    expect((await refusalOf(call({ action: 'change_date', date: '18.07.2027' }))).code).toBe('invalid_args:date');
    expect((await refusalOf(call({ action: 'change_date', date: '2027-02-30' }))).message).toMatch(/не существует/);
    expect((await refusalOf(call({ action: 'change_date', date: '2027-05-31' }))).message).toMatch(/уже прошла/);
    expect(h.query).not.toHaveBeenCalled();
  });
});

describe('отмена', () => {
  it('оператор не ответил — отменена сразу; оператору сказано, что передал ИИ-агент', async () => {
    const r = await call({ action: 'cancel' });
    expect(callsOf(CANCEL_NOW_SQL)).toEqual([[LEAD, 'mcp']]);
    expect(r).toMatchObject({ action: 'cancel', outcome: 'cancelled', changed: true, test: false, told: 'operator', date: '2027-07-15' });
    expect(r.human).toBe('Заявка отменена: тур «Горелый & кратер <малый>», 15.07.2027, участников 3. Оператору ушло сообщение.');
    expect(r.next).toMatch(/Вернуть отменённую заявку нельзя/);
    const text = sentToOperator();
    expect(text).toContain('Отмену передал ИИ-агент туриста по ключу заявки, пока вы не ответили.');
    expect(text).not.toContain('в чате Ведара');
    // Журнал событий заявки называет дверь.
    expect(h.event.mock.calls[0]![0]).toMatchObject({ actorKind: 'tourist', payload: { to: 'cancelled', via: 'mcp' } });
  });

  it('дверь A2A пишется в журнал заявки своим словом', async () => {
    await call({ action: 'cancel' }, 'a2a');
    expect(callsOf(CANCEL_NOW_SQL)).toEqual([[LEAD, 'a2a']]);
  });

  it('оператор не узнал — так и сказано, менеджер предупреждён', async () => {
    h.notify.mockResolvedValue('none');
    const r = await call({ action: 'cancel' });
    expect(r).toMatchObject({ outcome: 'cancelled', changed: true, told: 'manager' });
    expect(r.human).toMatch(/Сообщить оператору сейчас не удалось.*Менеджер Ведара предупреждён\.$/);
    const manager = (h.alert.mock.calls[0]![0] as { text: string }).text;
    expect(manager).toContain('Передал ИИ-агент клиента по ключу заявки.');
    // Не дошло и менеджеру — «никто».
    h.alert.mockResolvedValue({ channel: 'none', delivered: false, reason: 'нет чата' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await call({ action: 'cancel' })).toMatchObject({ outcome: 'cancelled', told: 'nobody' });
    err.mockRestore();
  });

  it('оператор уже ответил — заявка не тронута, ему ушла просьба', async () => {
    world.lead = lead({ answered: true, status: 'contacted' });
    const r = await call({ action: 'cancel' });
    expect(callsOf(CANCEL_NOW_SQL)).toHaveLength(0);
    expect(callsOf(CANCEL_REQUEST_SQL)).toEqual([[LEAD, 'mcp']]);
    expect(r).toMatchObject({ outcome: 'cancel_requested', changed: false, told: 'operator', date: '2027-07-15' });
    expect(r.human).toMatch(/отменяет он: просьба ему отправлена\. Заявка действует, пока он её не закроет\./);
    expect(sentToOperator()).toContain('Просьбу передал ИИ-агент туриста по ключу заявки.');
  });

  it('просьба не дошла никому — заявка в силе, вызов можно повторить', async () => {
    world.lead = lead({ answered: true, status: 'contacted' });
    h.notify.mockResolvedValue('none');
    h.alert.mockResolvedValue({ channel: 'none', delivered: false, reason: 'нет чата' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await call({ action: 'cancel' });
    expect(r).toMatchObject({ outcome: 'cancel_request_undelivered', changed: false, told: 'nobody' });
    expect(r.human).toMatch(/Заявка остаётся в силе\.$/);
    expect(r.next).toMatch(/Повторите вызов/);
    expect(callsOf(CANCEL_REQUEST_UNDELIVERED_SQL)).toHaveLength(1);
    err.mockRestore();
  });

  it('повтор и закрытая заявка — правдой о том, что есть; ничего не пишется', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ status: 'cancelled' }, 'already_cancelled'],
      [{ status: 'lost' }, 'closed'],
      [{ date: '2027-05-01' }, 'past'],
      [{ answered: true, status: 'contacted', cancel_request: { delivery: 'max', manager: 'not_needed', fresh: false } }, 'cancel_already_requested'],
    ];
    for (const [over, outcome] of cases) {
      world.lead = lead(over);
      expect(await call({ action: 'cancel' }), outcome).toMatchObject({ outcome, changed: false });
    }
    expect(writes()).toHaveLength(0);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('отмена не записалась за две попытки — исключение, а не «отменена»', async () => {
    world.cancelNow = null;
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(call({ action: 'cancel' })).rejects.not.toBeInstanceOf(McpUserError);
    expect(h.notify).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('перенос', () => {
  it('оператор не ответил — дата меняется сразу, оператору названа дверь', async () => {
    const r = await call({ action: 'change_date', date: '2027-07-18' });
    expect(callsOf(MY_TRIP_DATE_CHANGE_SQL)).toEqual([[LEAD, '2027-07-18', '2027-07-15', 'mcp']]);
    expect(r).toMatchObject({ action: 'change_date', outcome: 'date_changed', changed: true, told: 'operator', date: '2027-07-18' });
    expect(r.human).toBe('Дата в заявке изменена: тур «Горелый & кратер <малый>», было 15.07.2027, теперь 18.07.2027. Оператору ушло сообщение о переносе.');
    const text = sentToOperator();
    expect(text).toContain('Турист перенёс заявку на другую дату');
    expect(text).toContain('Передал ИИ-агент туриста по ключу заявки.');
  });

  it('оператор уже ответил — просьба, в заявке прежняя дата; не дошла — сказано', async () => {
    world.lead = lead({ answered: true, status: 'contacted' });
    const r = await call({ action: 'change_date', date: '2027-07-18' });
    expect(callsOf(MY_TRIP_DATE_CHANGE_SQL)).toHaveLength(0);
    expect(callsOf(MY_TRIP_DATE_REQUEST_LOG_SQL)).toEqual([[LEAD, '2027-07-15', '2027-07-18', 'mcp']]);
    expect(r).toMatchObject({ outcome: 'date_change_requested', changed: false, told: 'operator', date: '2027-07-15' });
    expect(sentToOperator()).toContain('Передал ИИ-агент туриста по ключу заявки.');
    h.notify.mockResolvedValue('none');
    const lost = await call({ action: 'change_date', date: '2027-07-18' });
    expect(lost).toMatchObject({ outcome: 'date_change_request_undelivered', changed: false, told: 'nobody', date: '2027-07-15' });
    expect(lost.next).toMatch(/о просьбе оператор не знает/);
  });

  it('нет мест, нет расписания, лимит, та же дата, отказанная дата — без записи и без сообщений', async () => {
    world.free = [];
    expect(await call({ action: 'change_date', date: '2027-07-18' })).toMatchObject({ outcome: 'no_seats', changed: false, date: '2027-07-15' });
    world.hasCalendar = false;
    expect(await call({ action: 'change_date', date: '2027-07-18' })).toMatchObject({ outcome: 'no_schedule', changed: false });
    world.hasCalendar = true;
    world.free = [{ date: '2027-07-18', free: 5 }];
    world.lead = lead({ date_actions: MY_TRIP_DATE_DAILY_LIMIT });
    expect(await call({ action: 'change_date', date: '2027-07-18' })).toMatchObject({ outcome: 'daily_limit', changed: false });
    world.lead = lead();
    expect(await call({ action: 'change_date', date: '2027-07-15' })).toMatchObject({ outcome: 'same_date', changed: false });
    world.lead = lead({ refused_dates: ['2027-07-18'] });
    expect(await call({ action: 'change_date', date: '2027-07-18' })).toMatchObject({ outcome: 'date_refused_by_operator', changed: false });
    expect(writes()).toHaveLength(0);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('у заявки нет оператора — перенос некому подтверждать: отказ, отмена остаётся доступной', async () => {
    world.key = tourKey({ lead_addressed: false });
    const r = await refusalOf(call({ action: 'change_date', date: '2027-07-18' }));
    expect(r.code).toBe('no_addressee');
    expect(r.message).toMatch(/Отменить такую заявку можно: action cancel\.$/);
    expect(callsOf(CHANGE_DATE_LEAD_SQL)).toHaveLength(0);
    world.lead = lead({ operator_id: null });
    world.cancelNow = { log_id: '701', prev_status: 'new', operator_id: null };
    expect(await call({ action: 'cancel' })).toMatchObject({ outcome: 'cancelled', changed: true });
  });

  it('свободные даты не прочитались — исключение, не «мест нет»', async () => {
    const base = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql === FREE_DATES_SQL) throw Object.assign(new Error('boom'), { code: '57014' });
      return base(sql, params);
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(call({ action: 'change_date', date: '2027-07-18' })).rejects.not.toBeInstanceOf(McpUserError);
    expect(writes()).toHaveLength(0);
    err.mockRestore();
  });
});

describe('проба (test: true) ничего не пишет и никому не шлёт', () => {
  it('отмена: что произошло бы — словом would_*, не «отменено»', async () => {
    const now = await call({ action: 'cancel', test: true });
    expect(now).toMatchObject({ outcome: 'would_cancel', changed: false, test: true, told: null });
    expect(now.human).toMatch(/^Проба, ничего не изменено\./);
    world.lead = lead({ answered: true, status: 'contacted' });
    // Строкой "true" модели шлют не реже булева.
    expect(await call({ action: 'cancel', test: 'true' })).toMatchObject({ outcome: 'would_request_cancel', changed: false, test: true });
    world.lead = lead({ status: 'cancelled' });
    expect(await call({ action: 'cancel', test: true })).toMatchObject({ outcome: 'already_cancelled', test: true });
    expect(writes()).toHaveLength(0);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.alert).not.toHaveBeenCalled();
    expect(h.event).not.toHaveBeenCalled();
  });

  it('перенос: те же проверки, что у настоящего вызова, и ни одной записи', async () => {
    expect(await call({ action: 'change_date', date: '2027-07-18', test: true })).toMatchObject({ outcome: 'would_change_date', changed: false, test: true, date: '2027-07-15' });
    world.lead = lead({ answered: true, status: 'contacted' });
    expect(await call({ action: 'change_date', date: '2027-07-18', test: true })).toMatchObject({ outcome: 'would_request_date_change', changed: false });
    world.free = [];
    expect(await call({ action: 'change_date', date: '2027-07-18', test: true })).toMatchObject({ outcome: 'no_seats', test: true });
    expect(writes()).toHaveLength(0);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('проба права не обходит: ключ повтора получает тот же отказ', async () => {
    world.key = tourKey({ opens_chat: false });
    expect((await refusalOf(call({ action: 'cancel', test: true }))).code).toBe('status_only_key');
  });
});

describe('ответ агенту', () => {
  it('поля — по схеме; ни ключа, ни номера заявки, ни адреса кабинета', async () => {
    const outcomes = new Set<string>(CHANGE_OUTCOMES);
    const told = new Set<string | null>([...CHANGE_TOLD, null]);
    const required = CHANGE_REQUEST_OUTPUT_SCHEMA.required;
    const runs = [
      await call({ action: 'cancel' }),
      await call({ action: 'cancel', test: true }),
      await call({ action: 'change_date', date: '2027-07-18' }),
      await call({ action: 'change_date', date: '2027-07-18', test: true }),
    ];
    for (const r of runs) {
      expect(Object.keys(r).sort()).toEqual([...required].sort());
      expect(outcomes.has(r.outcome), r.outcome).toBe(true);
      expect(told.has(r.told), String(r.told)).toBe(true);
      const flat = JSON.stringify(r);
      expect(flat).not.toContain(KEY);
      expect(flat).not.toContain(LEAD);
      expect(flat).not.toContain(OPERATOR);
      expect(flat).not.toMatch(/\/hub\/|request-status#/);
    }
  });

  it('число в словах о лимите — то же, что в правиле', () => {
    expect(MY_TRIP_DATE_DAILY_LIMIT).toBe(DATE_CHANGE_DAILY_LIMIT);
    expect(DATE_CHANGE_DAILY_LIMIT).toBe(3);
    expect(CHANGE_REQUEST_TOOL.description).toMatch(/не больше трёх раз в сутки/);
  });
});

describe('объявление инструмента', () => {
  it('третий род записи: не заявка, но хост обязан спросить человека', () => {
    expect(CHANGE_REQUEST_TOOL.name).toBe(CHANGE_REQUEST_TOOL_NAME);
    expect([...CHANGE_TOOL_NAMES]).toEqual([CHANGE_REQUEST_TOOL_NAME]);
    expect(WRITE_TOOL_NAMES.has(CHANGE_REQUEST_TOOL_NAME)).toBe(false);
    const tool = PUBLIC_MCP_TOOLS.find((t) => t.name === CHANGE_REQUEST_TOOL_NAME)!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
    expect(tool.outputSchema).toBe(CHANGE_REQUEST_OUTPUT_SCHEMA);
    // Описание говорит главное: по просьбе человека, «зависит от ответа», необратимо.
    expect(tool.description).toMatch(/только когда человек сам попросил/);
    expect(tool.description).toMatch(/Оператор ещё не ответил — заявка отменяется или дата меняется сразу/);
    expect(tool.description).toMatch(/Отменённую заявку вернуть нельзя/);
    expect(CHANGE_REQUEST_RULE).toMatch(/только по просьбе человека/);
  });
});

describe('роут MCP', () => {
  const run = (args: Record<string, unknown>, via?: 'a2a') => runPublicTool({
    toolName: CHANGE_REQUEST_TOOL_NAME, rawArguments: { key: KEY, ...args }, ip: `10.9.0.${Math.floor(Math.random() * 200) + 1}`, userAgent: 'test', self: false, ...(via ? { via } : {}),
  });

  beforeEach(() => {
    // Роут берёт «сегодня» сам — даты заявки далеко впереди, чтобы тест не протух.
    world.lead = lead({ date: '2099-07-15' });
  });

  it('вызов доходит до двери; объект уходит и текстом, и structuredContent', async () => {
    const out = await run({ action: 'cancel' });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(JSON.parse(out.text)).toMatchObject({ action: 'cancel', outcome: 'cancelled', changed: true });
    expect(out.structured).toEqual(JSON.parse(out.text));
    expect(out.handoffUrl).toBeNull();
    expect(callsOf(CANCEL_NOW_SQL)).toEqual([[LEAD, 'mcp']]);
  });

  it('вызов по A2A пишет в журнал заявки дверь a2a', async () => {
    await run({ action: 'change_date', date: '2099-07-18' }, 'a2a');
    expect(callsOf(MY_TRIP_DATE_CHANGE_SQL)).toEqual([[LEAD, '2099-07-18', '2099-07-15', 'a2a']]);
  });

  it('в журнал вызовов идёт имя аргумента, а значение — никогда: там ключ заявки', async () => {
    await run({ action: 'cancel', test: true });
    await run({ action: 'cancel' });
    world.key = tourKey({ opens_chat: false });
    await run({ action: 'cancel' });
    expect(h.log).toHaveBeenCalledTimes(3);
    for (const [entry] of h.log.mock.calls as Array<[{ tool: string; argKey: string | null; argValue?: string | null; ok: boolean; errorCode?: string }]>) {
      expect(entry.tool).toBe(CHANGE_REQUEST_TOOL_NAME);
      expect(entry.argKey).toBe('key');
      expect(entry.argValue ?? null).toBeNull();
      expect(JSON.stringify(entry)).not.toContain(KEY);
    }
    // Отказ по ключу повтора — отказ по входу с машинным кодом, а не падение.
    expect((h.log.mock.calls[2]![0] as { ok: boolean; errorKind: string; errorCode: string })).toMatchObject({ ok: false, errorKind: 'refused', errorCode: 'status_only_key' });
  });

  it('отказ по входу — isError с объяснением; сбой базы — «сбой у Ведара», без подробностей', async () => {
    world.key = null;
    const gone = await run({ action: 'cancel' });
    expect(gone).toMatchObject({ kind: 'refused' });
    world.key = Object.assign(new Error('секрет базы'), { code: '57014' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failed = await run({ action: 'cancel' });
    expect(failed.kind).toBe('failed');
    if (failed.kind === 'failed') expect(failed.text).not.toContain('секрет базы');
    err.mockRestore();
  });

  it('копия задачи A2A: ответ хранится как есть — ключа в нём нет', async () => {
    const out = await run({ action: 'cancel' }, 'a2a');
    if (out.kind !== 'ok') throw new Error('ожидался ответ');
    const part = { text: out.text };
    const task = {
      id: 't-1', contextId: 'c-1', state: 'completed' as const, timestamp: new Date(0).toISOString(),
      statusMessage: null, artifacts: [{ artifactId: 'a-1', name: 'answer', parts: [part, { data: { tool: CHANGE_REQUEST_TOOL_NAME, result: out.structured } }] }],
      history: [], metadata: { input: 'tool', tool: CHANGE_REQUEST_TOOL_NAME },
    };
    const copy = storableTask(task as unknown as Parameters<typeof storableTask>[0]);
    expect(JSON.stringify(copy)).not.toContain(KEY);
    // Не заглушка: ответ без ключа прятать незачем, агент прочтёт исход и после перезапуска.
    expect(JSON.stringify(copy)).toContain('cancelled');
  });
});
