/**
 * Профиль оператора (аудит кабинета, пакет «Г», пп. 2, 3, 4, 10).
 *
 * - стёртое поле очищается, а не остаётся под «Профиль сохранён»;
 * - партнёр выбирается getOperatorPartnerId (category='operator'), а не
 *   `WHERE user_id = $1 LIMIT 1` — у гида-оператора записей две;
 * - завершение онбординга подаёт заявку: 'none' → 'pending', applied_at;
 * - статус Telegram-уведомлений — по реальному источнику (reach), с
 *   исходом «не знаю»;
 * - администратору партнёрская запись не заводится.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));
const reachMock = vi.fn();
// Подменяется только чтение адреса из базы; правило статуса
// (requestsChannelStatus: MAX или Telegram) — настоящее.
vi.mock('@/lib/partners/reach', async (orig) => ({
  ...(await orig<typeof import('@/lib/partners/reach')>()),
  reachForPartner: (...args: unknown[]) => reachMock(...args),
}));
vi.mock('@/lib/auth/middleware', () => ({
  requireOperator: vi.fn(async () => ({ userId: 'user-1', email: 'o@x.ru', role: 'operator' })),
}));
const partnerIdMock = vi.fn();
vi.mock('@/lib/auth/operator-helpers', () => ({
  getOperatorPartnerId: (...args: unknown[]) => partnerIdMock(...args),
}));
// Кабинет — через гарды CRM 2г (lib/operators/team-access): здесь вошёл
// владелец кабинета partnerIdMock(); нет кабинета — код ответа, который роут
// просит у гарда (у профиля — прежний 404).
const seatMock = vi.fn(() => 'owner');
vi.mock('@/lib/operators/team-access', async () => {
  const { NextResponse: R } = await import('next/server');
  const gate = (ownerOnly: boolean) => async (_req: unknown, opts?: { noProfileStatus?: number }) => {
    const partnerId = await partnerIdMock('user-1');
    if (!partnerId) return R.json({ success: false, error: 'Профиль оператора не найден' }, { status: opts?.noProfileStatus ?? 403 });
    const kind = seatMock();
    if (ownerOnly && kind !== 'owner') return R.json({ success: false, error: 'Этот раздел ведёт владелец кабинета' }, { status: 403 });
    const access = kind === 'owner'
      ? { kind: 'owner', partnerId }
      : { kind: 'manager', partnerId, memberId: 'm-1', perms: { can_edit_prices: false, can_cancel_bookings: false } };
    return { userId: 'user-1', email: 'o@x.ru', role: 'operator', partnerId, access };
  };
  return { requireOperatorTeam: gate(false), requireOperatorOwner: gate(true) };
});

import { GET, PATCH } from '@/app/api/hub/operator/profile/route';
import { mergeClearable, isCleared } from '@/lib/operator/profile-patch';
import { RESUBMIT_RACE_TEXT, RESUBMITTED_TEXT, resubmitRefusal } from '@/lib/operator/profile-status';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

function patchReq(body: unknown): NextRequest {
  return new Request('http://localhost/api/hub/operator/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function updateCall(): [string, unknown[]] {
  const call = queryMock.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE partners'));
  expect(call, 'UPDATE partners не выполнен').toBeTruthy();
  return call as [string, unknown[]];
}

/** Что стоит в карточке до запроса и что вернёт запись — для сцен повторной подачи. */
const card = { status: 'none' as string | null, after: 'pending' as string | null, journalFails: false };

beforeEach(() => {
  queryMock.mockReset();
  reachMock.mockReset();
  partnerIdMock.mockReset();
  partnerIdMock.mockResolvedValue('partner-op');
  seatMock.mockReturnValue('owner');
  card.status = 'none';
  card.after = 'pending';
  card.journalFails = false;
  queryMock.mockImplementation((sql: string) => {
    if (sql.includes('SELECT contacts, location, profile_status FROM partners')) {
      return Promise.resolve({
        rows: [{
          contacts: { phone: '+7 900', telegram: '@old', website: 'https://a.ru' }, location: { city: 'ПК', address: 'ул. 1' },
          profile_status: card.status,
        }],
      });
    }
    if (sql.startsWith('UPDATE partners')) {
      return Promise.resolve({ rows: sql.includes('RETURNING profile_status') ? [{ profile_status: card.after }] : [] });
    }
    if (sql.includes('UPDATE operator_applications')) {
      return card.journalFails
        ? Promise.reject(Object.assign(new Error('журнал недоступен'), { code: '57014' }))
        : Promise.resolve({ rows: [], rowCount: 1 });
    }
    return Promise.resolve({ rows: [{ id: 'partner-op', company_name: 'Оператор' }] });
  });
});

describe('три исхода поля: записать / очистить / не трогать', () => {
  it('mergeClearable удаляет ключ на пустом, пишет на строке, не трогает undefined', () => {
    const merged = mergeClearable({ phone: '1', telegram: '@a', website: 'w' }, {
      phone: '', telegram: undefined, website: 'new',
    });
    expect(merged).toEqual({ telegram: '@a', website: 'new' });
    expect(mergeClearable({ a: '1' }, { a: null })).toEqual({});
    expect(isCleared('')).toBe(true);
    expect(isCleared(null)).toBe(true);
    expect(isCleared(undefined)).toBe(false);
  });

  it('PATCH со стёртым телефоном и описанием очищает их в базе', async () => {
    const res = await PATCH(patchReq({
      phone: '', telegram: '@new', description: '', location: { city: '', address: 'ул. 2' },
    }));
    expect(res.status).toBe(200);
    const [sql, params] = updateCall();

    const contactsIdx = Number(/contacts = \$(\d+)/.exec(sql)?.[1]) - 1;
    const contacts = JSON.parse(String(params[contactsIdx]));
    expect(contacts).toEqual({ telegram: '@new', website: 'https://a.ru' });

    expect(sql).toMatch(/description = \$\d+/);
    const descIdx = Number(/description = \$(\d+)/.exec(sql)?.[1]) - 1;
    expect(params[descIdx]).toBeNull();

    const locIdx = Number(/location = \$(\d+)/.exec(sql)?.[1]) - 1;
    expect(JSON.parse(String(params[locIdx]))).toEqual({ address: 'ул. 2' });
  });

  it('канал уведомлений из профиля не пишется: chat id в запросе не доходит до базы', async () => {
    // Ревью 23.11: оператор вписывал любой id, и шлюз «канал до витрины»
    // принимал его за подключённый Telegram. Канал привязывает только бот.
    for (const sent of [-1, 0, 123456789, null]) {
      queryMock.mockClear();
      const res = await PATCH(patchReq({ phone: '+7 900', telegram_chat_id: sent, max_chat_id: sent }));
      expect(res.status, String(sent)).toBe(200);
      const [sql, params] = updateCall();
      expect(sql, String(sent)).not.toMatch(/telegram_chat_id|max_chat_id/);
      // Ни в одном параметре записи присланного id нет (в contacts — тоже).
      expect(JSON.stringify(params)).not.toMatch(/telegram_chat_id|max_chat_id/);
      if (typeof sent === 'number' && sent !== 0) expect(params).not.toContain(sent);
    }
  });

  it('клиент профиля шлёт пустую строку, а не undefined', () => {
    const src = read('app/hub/operator/profile/_ProfileClient.tsx');
    expect(src).not.toMatch(/\.trim\(\) \|\| undefined/);
    expect(src).toMatch(/phone:\s+phone\.trim\(\),/);
  });
});

describe('партнёр — общим helper-ом, не произвольной записью', () => {
  // CRM 2г: кабинет решают гарды команды (свой или команды, category='operator'),
  // правка профиля — только владельцу.
  it('роут профиля идёт через гарды кабинета, своего выбора по user_id нет', () => {
    const src = read('app/api/hub/operator/profile/route.ts');
    expect(src).toMatch(/requireOperatorTeam\(request, \{ noProfileStatus: 404 \}\)/);
    expect(src).toMatch(/requireOperatorOwner\(request, \{ noProfileStatus: 404 \}\)/);
    expect(src).not.toMatch(/FROM partners WHERE user_id = \$1 LIMIT 1/);
  });

  it('менеджер команды: профиль читает без денег, править не может', async () => {
    seatMock.mockReturnValue('manager');
    queryMock.mockImplementation((sql: string) => (sql.includes('FROM partners p')
      ? Promise.resolve({ rows: [{ id: 'partner-op', payout_method: 'card', payout_verified: true, commission_current: '10' }] })
      : Promise.resolve({ rows: [] })));
    reachMock.mockResolvedValue({ reachable: true, telegramChatId: null, maxChatId: null });
    const got = await (await GET({} as NextRequest)).json() as { data: Record<string, unknown> };
    expect(got.data).toMatchObject({ payout_method: null, payout_verified: null, commission_current: null });
    const res = await PATCH(patchReq({ phone: '1' }));
    expect(res.status).toBe(403);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE partners'))).toBe(false);
    seatMock.mockReturnValue('owner');
  });

  it('нет партнёрской записи — честный 404, а не 500', async () => {
    partnerIdMock.mockResolvedValue(null);
    const res = await PATCH(patchReq({ phone: '1' }));
    expect(res.status).toBe(404);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('завершение онбординга подаёт заявку (п.2)', () => {
  it("complete_onboarding переводит 'none' → 'pending' и ставит applied_at только из 'none'", async () => {
    await PATCH(patchReq({ complete_onboarding: true }));
    const [sql] = updateCall();
    expect(sql).toMatch(/onboarding_completed = \$\d+/);
    expect(sql).toMatch(/profile_status = CASE WHEN profile_status = 'none' THEN 'pending' ELSE profile_status END/);
    expect(sql).toMatch(/applied_at = CASE WHEN profile_status = 'none' THEN NOW\(\) ELSE applied_at END/);
  });

  it('без complete_onboarding статус заявки не трогается', async () => {
    await PATCH(patchReq({ phone: '1' }));
    const [sql] = updateCall();
    expect(sql).not.toMatch(/profile_status/);
    expect(sql).not.toMatch(/applied_at/);
  });

  it('повторное завершение настройки отклонённую заявку в очередь не возвращает', async () => {
    // Вернуть её может только явная подача: иначе любое сохранение формы настройки
    // молча ставило бы отклонённого обратно в очередь.
    card.status = 'rejected';
    await PATCH(patchReq({ complete_onboarding: true }));
    const [sql] = updateCall();
    expect(sql).not.toMatch(/profile_status = 'rejected'/);
    expect(queryMock.mock.calls.some(([q]) => String(q).includes('operator_applications'))).toBe(false);
  });
});

/**
 * Слово владельца 23.11: «отклонённый оператор видит причину отказа и может
 * подать заявку снова, как у гида». Дверь — та же, что правит профиль:
 * владелец кабинета, флаг `submit_for_review`.
 */
describe('повторная подача после отказа (слово владельца 23.11)', () => {
  const journalCalls = () => queryMock.mock.calls.filter(([sql]) => String(sql).includes('UPDATE operator_applications'));
  const partnerUpdates = () => queryMock.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE partners'));

  it('отклонённая заявка уходит на проверку: статус и время подачи — только из «отклонена», журнал снова ждёт', async () => {
    card.status = 'rejected';
    const res = await PATCH(patchReq({ submit_for_review: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message: RESUBMITTED_TEXT, profile_status: 'pending' });
    const [sql, params] = updateCall();
    expect(sql).toMatch(/profile_status = CASE WHEN profile_status = 'rejected' THEN 'pending' ELSE profile_status END/);
    expect(sql).toMatch(/applied_at = CASE WHEN profile_status = 'rejected' THEN NOW\(\) ELSE applied_at END/);
    expect(sql).toMatch(/RETURNING profile_status$/);
    // Причина прошлого отказа остаётся до следующего решения, как у гида.
    expect(sql).not.toMatch(/profile_review_comment/);
    expect(params.at(-1)).toBe('partner-op');
    expect(journalCalls()).toHaveLength(1);
    expect(journalCalls()[0][0]).toMatch(/SET status = 'pending' WHERE partner_id = \$1 AND status = 'rejected'/);
    expect(journalCalls()[0][1]).toEqual(['partner-op']);
  });

  it.each([
    ['pending', 'Заявка уже на проверке — дождитесь решения администратора'],
    ['approved', 'Профиль уже одобрен — подавать заявку снова не нужно'],
    ['none', 'Заявка ещё не подана — завершите настройку профиля, и она уйдёт на проверку'],
    ['что-то новое', 'Статус заявки определить не удалось — попробуйте позже'],
    [null, 'Статус заявки определить не удалось — попробуйте позже'],
  ])('статус «%s»: подавать нечего — 409 словами, ни записи, ни журнала', async (status, words) => {
    card.status = status;
    const res = await PATCH(patchReq({ submit_for_review: true, phone: '+7 999' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ success: false, error: words });
    expect(partnerUpdates()).toHaveLength(0);
    expect(journalCalls()).toHaveLength(0);
  });

  it('заявку решили между чтением и записью — 409, а не «отправлено»; журнал не тронут', async () => {
    card.status = 'rejected';
    card.after = 'approved';
    const res = await PATCH(patchReq({ submit_for_review: true }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ success: false, error: RESUBMIT_RACE_TEXT });
    expect(journalCalls()).toHaveLength(0);
  });

  it('журнал не обновился — заявка всё равно в очереди, отказ журнала в логе без данных', async () => {
    card.status = 'rejected';
    card.journalFails = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await PATCH(patchReq({ submit_for_review: true }));
    expect(res.status).toBe(200);
    expect(errors).toHaveBeenCalledWith('[hub/operator/profile] журнал заявок не обновлён, SQLSTATE', '57014');
    errors.mockRestore();
  });

  it('вместе с правкой профиля: поля сохранены той же записью, что ставит заявку в очередь', async () => {
    card.status = 'rejected';
    const res = await PATCH(patchReq({ submit_for_review: true, description: 'Новое описание компании.' }));
    expect(res.status).toBe(200);
    const [sql, params] = updateCall();
    expect(sql).toMatch(/description = \$\d+/);
    expect(params).toContain('Новое описание компании.');
    expect(partnerUpdates()).toHaveLength(1);
  });

  it('флаг — только настоящее true: строка и число — ошибка запроса; false — обычное сохранение', async () => {
    card.status = 'rejected';
    for (const flag of ['true', 1, {}]) {
      const res = await PATCH(patchReq({ submit_for_review: flag }));
      expect(res.status, JSON.stringify(flag)).toBe(422);
    }
    expect(partnerUpdates()).toHaveLength(0);
    const plain = await PATCH(patchReq({ submit_for_review: false, phone: '1' }));
    expect(await plain.json()).toEqual({ success: true, message: 'Профиль сохранён' });
    expect(updateCall()[0]).not.toMatch(/profile_status/);
    expect(journalCalls()).toHaveLength(0);
  });

  it('менеджер компании заявку не подаёт: дверь — владельца кабинета', async () => {
    card.status = 'rejected';
    seatMock.mockReturnValue('manager');
    const res = await PATCH(patchReq({ submit_for_review: true }));
    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('слова правила: подать можно только из «отклонена»; срок и исход не обещаны', () => {
    expect(resubmitRefusal('rejected')).toBeNull();
    for (const s of ['pending', 'approved', 'none', '', undefined, null, 42]) expect(resubmitRefusal(s), String(s)).not.toBeNull();
    expect(RESUBMITTED_TEXT).not.toMatch(/\d|сутк|час|дн[яей]|одобр/i);
  });
});

describe('статус Telegram-уведомлений — по реальному источнику (п.4)', () => {
  async function tgStatus(): Promise<unknown> {
    const res = await GET(new Request('http://localhost/api/hub/operator/profile') as unknown as NextRequest);
    const json = await (res as NextResponse).json() as { data: { telegram_notifications: unknown } };
    return json.data.telegram_notifications;
  }

  it('адрес есть в любой из двух колонок — подключены', async () => {
    reachMock.mockResolvedValue({ telegramChatId: '42', maxChatId: null, telegramSource: 'user', reachable: true });
    expect(await tgStatus()).toEqual({ status: 'connected', source: 'user' });
  });

  it('адреса нет — не подключены, даже если в contacts.telegram что-то записано', async () => {
    reachMock.mockResolvedValue({ telegramChatId: null, maxChatId: null, telegramSource: null, reachable: false });
    expect(await tgStatus()).toEqual({ status: 'not_connected', source: null });
  });

  it('не смогли прочитать — «не знаю», а не «не подключены»', async () => {
    reachMock.mockResolvedValue(null);
    expect(await tgStatus()).toEqual({ status: 'unknown', source: null });
  });

  it('профиль выдаёт короткий код кабинета, а не ссылку человека /start link_', () => {
    const profile = read('app/hub/operator/profile/_ProfileClient.tsx');
    expect(profile).toContain("fetch('/api/hub/operator/messenger-code'");
    expect(profile).not.toContain("fetch('/api/telegram/connect')");
    expect(profile).not.toContain('/start link_');
    const help = read('app/hub/operator/help/_OperatorHelpClient.tsx');
    expect(help).not.toMatch(/chat_id в контактах/);
    expect(help).toContain('/start');
    expect(help).not.toContain('/start link_');
    // Привязка аккаунта человека остаётся в вебхуке — кабинет её больше не зовёт.
    expect(read('app/api/telegram/webhook/route.ts')).toMatch(/arg\.startsWith\('link_'\)/);
    expect(read('app/api/telegram/webhook/route.ts')).toMatch(/normalizeBindCode\(arg\)/);
  });
});
