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
vi.mock('@/lib/partners/reach', () => ({
  reachForPartner: (...args: unknown[]) => reachMock(...args),
}));
vi.mock('@/lib/auth/middleware', () => ({
  requireOperator: vi.fn(async () => ({ userId: 'user-1', email: 'o@x.ru', role: 'operator' })),
}));
const partnerIdMock = vi.fn();
vi.mock('@/lib/auth/operator-helpers', () => ({
  getOperatorPartnerId: (...args: unknown[]) => partnerIdMock(...args),
}));

import { GET, PATCH } from '@/app/api/hub/operator/profile/route';
import { mergeClearable, isCleared } from '@/lib/operator/profile-patch';

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

beforeEach(() => {
  queryMock.mockReset();
  reachMock.mockReset();
  partnerIdMock.mockReset();
  partnerIdMock.mockResolvedValue('partner-op');
  queryMock.mockImplementation((sql: string) => {
    if (sql.includes('SELECT contacts, location FROM partners')) {
      return Promise.resolve({
        rows: [{ contacts: { phone: '+7 900', telegram: '@old', website: 'https://a.ru' }, location: { city: 'ПК', address: 'ул. 1' } }],
      });
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

  it('клиент профиля шлёт пустую строку, а не undefined', () => {
    const src = read('app/hub/operator/profile/_ProfileClient.tsx');
    expect(src).not.toMatch(/\.trim\(\) \|\| undefined/);
    expect(src).toMatch(/phone:\s+phone\.trim\(\),/);
  });
});

describe('партнёр — общим helper-ом, не произвольной записью', () => {
  it('роут профиля зовёт getOperatorPartnerId, своего выбора по user_id нет', () => {
    const src = read('app/api/hub/operator/profile/route.ts');
    expect(src).toMatch(/getOperatorPartnerId\(authOrResponse\.userId\)/);
    expect(src).not.toMatch(/FROM partners WHERE user_id = \$1 LIMIT 1/);
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

  it('профиль и справка называют настоящий способ подключения — бота по ссылке /start link_', () => {
    const profile = read('app/hub/operator/profile/_ProfileClient.tsx');
    expect(profile).toContain("fetch('/api/telegram/connect')");
    expect(profile).toContain('/start link_');
    const help = read('app/hub/operator/help/_OperatorHelpClient.tsx');
    expect(help).not.toMatch(/chat_id в контактах/);
    expect(help).toContain('/start link_');
    // Сама команда существует в вебхуке бота — справка не выдумывает.
    expect(read('app/api/telegram/webhook/route.ts')).toMatch(/arg\.startsWith\('link_'\)/);
  });
});
