/**
 * CRM 2г-4: уведомления менеджерам команды оператора (решение владельца
 * 11.10: «уведомления менеджерам — да»).
 *
 * Что держит сторож (вызовами; по тексту исходника — только запреты, CLAUDE.md
 * §4 «Сторож судит поведение, не текст»):
 *  - ссылка менеджера (`om_`) подписана своим доменом: ссылка кабинета (`op_`)
 *    ею не проходит, и наоборот; срок, подпись и «нет секрета» — разные исходы;
 *  - чат пишется только в АКТИВНУЮ строку команды; владелец узнаёт о привязке;
 *  - рассылка — только активным менеджерам с адресом; ПД — через sendPdAlert
 *    с названным получателем; кнопки — только ссылки (действие в чате
 *    менеджера было бы мёртвым); «не смог прочитать команду» — не «никого нет»;
 *    заглушка в Telegram — штатный исход, а не отказ; шлётся параллельно;
 *  - вызова notifyNewBooking без кабинета нет; адрес менеджера не пишет никто,
 *    кроме привязки и снятия; снятие стирает адрес;
 *  - роут менеджера берёт строку из гарда, владельцу ссылку не выдаёт.
 *
 * Двери и экраны проверяются вызовом и рендером рядом:
 *  - бронь (notifyNewBooking, задача «нет канала») — operator-booking-team-copy;
 *  - бронь из чата Кузьмича — kuzmich-booking-team-copy;
 *  - личная заявка — lead-personal-to-operator; запрос мест — seat-requests;
 *  - оба бота и `om_` — member-channel-bots;
 *  - баннеры кабинета — operator-layout-banners, member-channel-banner;
 *  - подписи на «Команде» — operator-team-notify-labels.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';

const { query, pdMock, reachMock, noticeMock, tgMock, maxMock } = vi.hoisted(() => ({
  query: vi.fn(), pdMock: vi.fn(), reachMock: vi.fn(), noticeMock: vi.fn(), tgMock: vi.fn(), maxMock: vi.fn(),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a), connect: vi.fn() } }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: pdMock }));
vi.mock('@/lib/partners/reach', () => ({ reachForPartner: reachMock }));
vi.mock('@/lib/partners/notice', () => ({ sendPartnerNotice: noticeMock }));
vi.mock('@/lib/notifications/telegram', () => ({ telegramService: { sendMessage: tgMock } }));
vi.mock('@/lib/notifications/max-channel', () => ({ maxSendDm: maxMock }));
vi.mock('@/lib/config', () => ({ getPublicBaseUrl: () => 'https://vedarai.ru' }));
vi.mock('@/lib/auth/middleware', () => ({
  requireOperator: vi.fn().mockResolvedValue({ userId: '00000000-0000-4000-8000-0000000000a1', role: 'operator', email: 'x@example.test' }),
}));

const mc = await import('@/lib/operators/member-channel');
const tn = await import('@/lib/operators/team-notify');
const { createPartnerLinkToken, verifyPartnerLinkToken } = await import('@/lib/partners/channel-link');
const messenger = await import('@/app/api/hub/operator/me/messenger/route');

const MEMBER = '00000000-0000-4000-8000-00000000m001'.replace('m', 'a');
const CABINET = '00000000-0000-4000-8000-0000000000c1';
const read = (p: string) => readFileSync(p, 'utf-8');

beforeEach(() => {
  vi.stubEnv('JWT_SECRET', 'тестовый-секрет-подписи-длиннее-16');
  vi.stubEnv('CONNECT_TOKEN_SECRET', '');
  for (const m of [query, pdMock, reachMock, noticeMock, tgMock, maxMock]) m.mockReset();
  pdMock.mockResolvedValue({ channel: 'max', delivered: true, reason: 'ok' });
  noticeMock.mockResolvedValue('max');
  tgMock.mockResolvedValue({ success: true });
  maxMock.mockResolvedValue({ ok: true });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('ссылка менеджера: своя подпись, свой срок', () => {
  it('подписанная ссылка возвращает строку команды; срок — сутки', () => {
    const t = mc.createMemberLinkToken(MEMBER, Date.UTC(2026, 9, 13));
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(t.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mc.verifyMemberLinkToken(t.token, Date.UTC(2026, 9, 13, 23))).toEqual({ ok: true, memberId: MEMBER });
    expect(mc.verifyMemberLinkToken(t.token, Date.UTC(2026, 9, 14, 1))).toEqual({ ok: false, reason: 'expired' });
  });

  it('ссылка кабинета не проходит как ссылка менеджера, и наоборот', () => {
    const op = createPartnerLinkToken(CABINET);
    const om = mc.createMemberLinkToken(MEMBER);
    expect(op.ok && om.ok).toBe(true);
    if (!op.ok || !om.ok) return;
    expect(mc.verifyMemberLinkToken(op.token)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyPartnerLinkToken(om.token)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('нет секрета — ссылки нет, и это названо; мусор — malformed', () => {
    vi.stubEnv('JWT_SECRET', '');
    expect(mc.createMemberLinkToken(MEMBER)).toEqual({ ok: false, reason: 'no_secret' });
    vi.stubEnv('JWT_SECRET', 'тестовый-секрет-подписи-длиннее-16');
    expect(mc.verifyMemberLinkToken('коротко')).toEqual({ ok: false, reason: 'malformed' });
    expect(mc.memberTokenFromStart('om_abc')).toBe('abc');
    expect(mc.memberTokenFromStart('op_abc')).toBeNull();
  });
});

describe('привязка: только активная строка команды, владелец узнаёт', () => {
  it('записано — владельцу уходит уведомление без ПД', async () => {
    query.mockResolvedValueOnce({ rows: [{ partner_id: CABINET, partner_name: 'Вулкан Тур', label: 'Анна', previous: null }] });
    reachMock.mockResolvedValue({ maxChatId: '900', telegramChatId: null, telegramSource: null, reachable: true });
    const r = await mc.bindMemberChannel(MEMBER, 'max', 555);
    expect(r).toMatchObject({ ok: true, partnerId: CABINET, rebound: false });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/m\.status = 'active'/);
    expect(sql).toMatch(/SET max_chat_id = \$1::bigint/);
    expect(params).toEqual(['555', MEMBER]);
    expect(noticeMock).toHaveBeenCalledTimes(1);
    expect(String(noticeMock.mock.calls[0][1])).toMatch(/К уведомлениям кабинета подключён MAX менеджера «Анна»/);
  });

  it('строки нет или менеджер снят — not_active, ничего не шлётся', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await mc.bindMemberChannel(MEMBER, 'telegram', 777)).toEqual({ ok: false, reason: 'not_active' });
    expect(noticeMock).not.toHaveBeenCalled();
  });

  it('перепривязка — прежний чат менеджера узнаёт, что сюда больше не придёт', async () => {
    query.mockResolvedValueOnce({ rows: [{ partner_id: CABINET, partner_name: 'Вулкан Тур', label: null, previous: '111' }] });
    reachMock.mockResolvedValue({ maxChatId: '900', telegramChatId: null, telegramSource: null, reachable: true });
    const r = await mc.bindMemberChannel(MEMBER, 'max', 222);
    expect(r).toMatchObject({ ok: true, rebound: true });
    expect(maxMock).toHaveBeenCalledWith('111', expect.stringMatching(/больше не приходят в этот чат/));
  });

  it('/start om_ с чужой подписью — отказ словами, в базу не ходим', async () => {
    const replies: string[] = [];
    const op = createPartnerLinkToken(CABINET);
    expect(op.ok).toBe(true);
    if (!op.ok) return;
    expect(await mc.handleMemberStart(`om_${op.token}`, 'max', 1, async (t) => { replies.push(t); })).toBe(true);
    expect(replies[0]).toMatch(/недействительна/);
    expect(query).not.toHaveBeenCalled();
    expect(await mc.handleMemberStart('op_что-то', 'max', 1, async () => undefined)).toBe(false);
  });
});

describe('рассылка команде', () => {
  const msg = { text: 'Турист: Анна, +79990000000', stub: 'Контакты — в MAX', buttons: [{ text: 'Открыть бронь', url: 'https://vedarai.ru/x' }] };

  it('только активные менеджеры с адресом; ПД — sendPdAlert с названным получателем', async () => {
    query.mockResolvedValueOnce({ rows: [
      { member_id: 'm1', max_chat_id: '11', telegram_chat_id: null },
      { member_id: 'm2', max_chat_id: null, telegram_chat_id: 22 },
    ] });
    pdMock.mockResolvedValueOnce({ channel: 'max', delivered: true }).mockResolvedValueOnce({ channel: 'telegram-stub', delivered: false, reason: 'нет MAX' });
    const r = await tn.notifyTeam(CABINET, msg, 'бронь #1');
    expect(r).toEqual({ state: 'sent', members: 2, delivered: 1, stubbed: 1 });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/m\.status = 'active'/);
    expect(sql).toMatch(/max_chat_id IS NOT NULL OR m\.telegram_chat_id IS NOT NULL/);
    expect(params).toEqual([CABINET]);
    expect(pdMock.mock.calls[0][0]).toEqual({ ...msg, to: { maxChatId: '11', telegramChatId: null } });
    expect(pdMock.mock.calls[1][0].to).toEqual({ maxChatId: null, telegramChatId: '22' });
  });

  it('команда не прочиталась — unknown, а не «никого нет»; таблицы ещё нет — никого', async () => {
    query.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '57P01' }));
    expect(await tn.notifyTeam(CABINET, msg, 'бронь #1')).toEqual({ state: 'unknown' });
    query.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '42703' }));
    expect(await tn.notifyTeam(CABINET, msg, 'бронь #1')).toEqual({ state: 'sent', members: 0, delivered: 0, stubbed: 0 });
    expect(pdMock).not.toHaveBeenCalled();
  });

  it('заглушка в Telegram — штатно, не отказ; «не ушло никуда» — в лог; шлётся параллельно', async () => {
    query.mockResolvedValueOnce({ rows: [
      { member_id: 'm1', max_chat_id: null, telegram_chat_id: '21' },
      { member_id: 'm2', max_chat_id: null, telegram_chat_id: '22' },
    ] });
    let inflight = 0;
    let peak = 0;
    pdMock.mockImplementation(async (p: { to: { telegramChatId: string } }) => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise(r => setTimeout(r, 5));
      inflight--;
      return p.to.telegramChatId === '21'
        ? { channel: 'telegram-stub', delivered: false, reason: 'у получателя нет max_chat_id' }
        : { channel: 'none', delivered: false, reason: 'у получателя нет max_chat_id; заглушка в Telegram тоже не ушла' };
    });
    const err = vi.mocked(console.error);
    err.mockClear();
    expect(await tn.notifyTeam(CABINET, msg, 'бронь #2')).toEqual({ state: 'sent', members: 2, delivered: 0, stubbed: 1 });
    expect(peak, 'бронь туриста не ждёт отправок по очереди').toBe(2);
    const lines = err.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('[team-notify]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/менеджеру m2 не ушло ни в MAX, ни в Telegram/);
  });

  it('кнопка-действие до чата менеджера не доходит — только ссылки', async () => {
    query.mockResolvedValueOnce({ rows: [{ member_id: 'm1', max_chat_id: '11', telegram_chat_id: null }] });
    const mixed = { ...msg, buttons: [{ text: 'Есть места', payload: 'sr:yes:1' }, ...msg.buttons] } as never;
    await tn.notifyTeam(CABINET, mixed, 'запрос мест 1');
    expect(pdMock.mock.calls[0][0].buttons).toEqual(msg.buttons);
  });
});

describe('вызова notifyNewBooking без кабинета быть не должно', () => {
  // Запрет, а не поиск строки-обещания: бронь, ушедшая без кабинета, до
  // менеджеров не дойдёт. Что notifyNewBooking делает с кабинетом, держит
  // вызов (operator-booking-team-copy).
  it('у каждого вызова есть operator_partner_id', () => {
    const files = execSync("git ls-files 'app' 'lib'", { encoding: 'utf-8' }).split('\n').filter(f => /\.tsx?$/.test(f));
    const missing: string[] = [];
    let calls = 0;
    for (const f of files) {
      if (f === 'lib/notifications/operator-booking.ts') continue;
      const src = read(f);
      for (const m of src.matchAll(/notifyNewBooking\(\{/g)) {
        calls++;
        const body = src.slice(m.index!, src.indexOf('})', m.index!));
        if (!/operator_partner_id:/.test(body)) missing.push(f);
      }
    }
    expect(calls, 'вызовы notifyNewBooking не найдены — правило проверять нечем').toBeGreaterThanOrEqual(3);
    expect(missing, 'бронь без кабинета не дойдёт до менеджеров').toEqual([]);
  });
});

describe('адрес менеджера: кто пишет и кто стирает', () => {
  it('адрес менеджера не пишет никто, кроме привязки и снятия', () => {
    const writers = execSync("git ls-files 'app' 'lib'", { encoding: 'utf-8' }).split('\n')
      .filter(f => /\.tsx?$/.test(f))
      .filter(f => {
        const src = read(f);
        return /operator_members/.test(src) && /(?:max_chat_id|telegram_chat_id)\s*=\s*(?:\$\d|NULL)/.test(src);
      })
      .sort();
    expect(writers).toEqual(['lib/operators/member-channel.ts', 'lib/operators/team.ts']);
  });

  it('снятие из команды стирает адрес тем же запросом, что ставит revoked', async () => {
    // SQL — артефакт: его смысл (какие колонки обнуляются в UPDATE снятия)
    // проверяется на запросе, который действительно уходит в базу. На
    // настоящем PostgreSQL то же проверено pg-скриптом (см. PR).
    const sent: Array<[string, unknown[]]> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        sent.push([sql, params ?? []]);
        return /SET status = 'revoked'/.test(sql) ? { rows: [{ id: MEMBER, user_id: null }] } : { rows: [] };
      }),
      release: vi.fn(),
    };
    const { pool } = await import('@/lib/db-pool');
    vi.mocked(pool.connect).mockResolvedValueOnce(client as never);
    const { revokeMember } = await import('@/lib/operators/team');
    await revokeMember(CABINET, MEMBER, '00000000-0000-4000-8000-0000000000a1');
    const revoke = sent.find(([sql]) => /SET status = 'revoked'/.test(sql))![0];
    for (const col of ['max_chat_id', 'telegram_chat_id', 'channel_bound_at']) {
      expect(revoke, `${col} не стирается при снятии`).toMatch(new RegExp(`${col} = NULL`));
    }
  });
});

describe('роут менеджера /api/hub/operator/me/messenger', () => {
  const accessRow = (manager: boolean) => ({ rows: [{
    own_partner_id: manager ? null : CABINET, member_partner_id: manager ? CABINET : null,
    member_id: manager ? MEMBER : null, can_edit_prices: false, can_cancel_bookings: false, was_revoked: false,
  }] });
  const req = (method: string) => new NextRequest('http://localhost/api/hub/operator/me/messenger', { method });

  it('менеджер: статус «да/нет», ссылка — на его строку команды из гарда', async () => {
    query.mockResolvedValueOnce(accessRow(true)).mockResolvedValueOnce({ rows: [{ max: false, telegram: true }] });
    const g = await (await messenger.GET(req('GET'))).json();
    expect(g.data).toEqual({ kind: 'manager', max: false, telegram: true });
    expect(JSON.stringify(g)).not.toMatch(/chat_id/);

    query.mockResolvedValueOnce(accessRow(true));
    const p = await (await messenger.POST(req('POST'))).json();
    const token = String(p.data.max).split('start=om_')[1];
    expect(mc.verifyMemberLinkToken(token)).toEqual({ ok: true, memberId: MEMBER });
  });

  it('владельцу — 409 с подсказкой: его чат — чат кабинета', async () => {
    query.mockResolvedValueOnce(accessRow(false));
    const res = await messenger.POST(req('POST'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Подключите MAX/);
  });
});
