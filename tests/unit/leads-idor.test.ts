/**
 * IDOR на роутах лида (разведка кабинета оператора, Рост-5 + аудит кабинета
 * оператора 24.08): «Проверки владения лидом нет — любой оператор может
 * открыть/изменить чужой лид по id». Список /api/leads скоупил лиды всегда
 * (свои + ничейные), а /api/leads/[id] — нет: requireOperator пускал ЛЮБОГО
 * оператора к ЛЮБОМУ лиду с телефоном и почтой туриста. Дыра закрыта единой
 * функцией lib/leads/ownership.ts — сторож держит её подключённой везде, где
 * читается/меняется чужой лид.
 *
 * 24.08: та же формула была пропущена в ЧЕТЫРЁХ соседних роутах того же
 * ресурса (proposal, proposal/send, proposal/pdf, оба process) — оператор
 * мог по чужому UUID скачать PDF с именем/телефоном туриста, перезапустить
 * AI-обработку и отправить предложение от имени платформы. Функция
 * вынесена в общий модуль ИМЕННО чтобы такой дрейф не повторялся: один
 * источник формулы, а не шесть копий, которые расходятся по одной.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Формула владения — вызовом: кабинет вошедшего (operatorAccess) и пул
// подменены, запрос смены статуса заявки ловится вместе с параметрами.
const access = vi.hoisted(() => ({ result: { kind: 'owner', partnerId: 'P-OWN' } as Record<string, unknown>, calls: 0 }));
const poolQuery = vi.hoisted(() => vi.fn());
vi.mock('@/lib/operators/team-access', () => ({
  operatorAccess: async () => { access.calls += 1; return access.result; },
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));
vi.mock('@/lib/crm/events', () => ({
  recordSourceEventQuietly: vi.fn(async () => undefined),
  statusChangeTitle: (_k: string, from: string | null, to: string) => `${from ?? ''} → ${to}`,
}));

import { leadScopeCond, operatorLeadScope, leadOwnershipCond } from '@/lib/leads/ownership';
import { changeLeadStatus } from '@/lib/leads/owner-lead-status';
import type { JWTPayload } from '@/lib/auth/jwt';

const operator = { userId: 'u-op', role: 'operator' } as unknown as JWTPayload;
const admin = { userId: 'u-admin', role: 'admin' } as unknown as JWTPayload;

const ROOT = process.cwd();
const DETAIL = readFileSync(join(ROOT, 'app/api/leads/[id]/route.ts'), 'utf-8');
const LIST = readFileSync(join(ROOT, 'app/api/leads/route.ts'), 'utf-8');
const PROPOSAL = readFileSync(join(ROOT, 'app/api/leads/[id]/proposal/route.ts'), 'utf-8');
const PROPOSAL_SEND = readFileSync(join(ROOT, 'app/api/leads/[id]/proposal/send/route.ts'), 'utf-8');
const PROPOSAL_PDF = readFileSync(join(ROOT, 'app/api/leads/[id]/proposal/pdf/route.ts'), 'utf-8');
const PROCESS_BY_ID = readFileSync(join(ROOT, 'app/api/leads/[id]/process/route.ts'), 'utf-8');
const PROCESS_BODY = readFileSync(join(ROOT, 'app/api/leads/process/route.ts'), 'utf-8');

describe('lib/leads/ownership.ts — единственный источник формулы', () => {
  beforeEach(() => {
    access.result = { kind: 'owner', partnerId: 'P-OWN' };
    access.calls = 0;
    poolQuery.mockReset();
  });

  it('формула: продавец — свои и (у кабинета оператора) ничейные; гид — только свои; без карточки — только ничейные; админ без скоупа', () => {
    expect(leadScopeCond({ kind: 'admin' }, 3)).toEqual({ cond: '', vals: [] });
    expect(leadScopeCond({ kind: 'owner', partnerId: 'P', claimUnowned: true }, 3))
      .toEqual({ cond: ' AND (operator_id = $3 OR operator_id IS NULL)', vals: ['P'] });
    expect(leadScopeCond({ kind: 'owner', partnerId: 'P', claimUnowned: false }, 3))
      .toEqual({ cond: ' AND operator_id = $3', vals: ['P'] });
    expect(leadScopeCond({ kind: 'unowned_only' }, 3)).toEqual({ cond: ' AND operator_id IS NULL', vals: [] });
  });

  it('кабинет оператора: свой или команды — карточка кабинета; нет карточки — только ничейные; «не смогли проверить» — отказ, а не «только ничейные»', async () => {
    expect(await operatorLeadScope(admin)).toEqual({ kind: 'admin' });
    expect(access.calls).toBe(0);
    expect(await operatorLeadScope(operator)).toEqual({ kind: 'owner', partnerId: 'P-OWN', claimUnowned: true });
    access.result = { kind: 'manager', partnerId: 'P-TEAM', memberId: 'm', perms: {} };
    expect(await operatorLeadScope(operator)).toEqual({ kind: 'owner', partnerId: 'P-TEAM', claimUnowned: true });
    access.result = { kind: 'none', reason: 'no_profile' };
    expect(await operatorLeadScope(operator)).toEqual({ kind: 'unowned_only' });
    access.result = { kind: 'unavailable', reason: 'sqlstate 57P01' };
    await expect(operatorLeadScope(operator)).rejects.toThrow(/не проверен/);
    await expect(leadOwnershipCond(operator, 2)).rejects.toThrow(/не проверен/);
  });

  it('смена статуса заявки: скоуп — в условии блокируемой строки; занять ничейную может только скоуп кабинета оператора', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    const lead = '11111111-2222-4333-8444-555555555555';
    const call = async (scope: Parameters<typeof changeLeadStatus>[0]['scope']) => {
      poolQuery.mockClear();
      const r = await changeLeadStatus({ leadId: lead, status: 'contacted', actor: { kind: 'partner_user', userId: 'u' }, scope, via: 'site' });
      const [sql, params] = poolQuery.mock.calls[0] as [string, unknown[]];
      return { r, prevCte: sql.slice(0, sql.indexOf('FOR UPDATE')), params };
    };
    const guide = await call({ kind: 'owner', partnerId: 'G', claimUnowned: false });
    expect(guide.r).toEqual({ kind: 'not_found' });
    expect(guide.prevCte).toContain('AND operator_id = $6');
    expect(guide.prevCte).not.toContain('IS NULL');
    expect(guide.params).toEqual([lead, 'contacted', false, null, null, 'G']);

    const op = await call({ kind: 'owner', partnerId: 'P', claimUnowned: true });
    expect(op.prevCte).toContain('AND (operator_id = $6 OR operator_id IS NULL)');
    expect(op.params).toEqual([lead, 'contacted', false, null, 'P', 'P']);

    const none = await call({ kind: 'unowned_only' });
    expect(none.prevCte).toContain('AND operator_id IS NULL');
    expect(none.params).toEqual([lead, 'contacted', false, null, null]);
  });
});

describe('владение лидом: /api/leads/[id]', () => {
  it('GET применяет скоуп к SQL, PATCH отдаёт скоуп кабинета общему правилу смены (lib/leads/owner-lead-status)', () => {
    expect(DETAIL).toMatch(/FROM leads WHERE id = \$1\$\{scope\.cond\}/);
    const patch = DETAIL.slice(DETAIL.indexOf('export async function PATCH'), DETAIL.indexOf('export async function GET'));
    expect(patch).toMatch(/changeLeadStatus\(\{[\s\S]*scope: await operatorLeadScope\(user\)/);
    expect(patch).not.toMatch(/UPDATE leads/);
  });

  it('импортирует общую формулу, а не держит свою копию', () => {
    expect(DETAIL).toMatch(/import \{ leadOwnershipCond, operatorLeadScope \} from '@\/lib\/leads\/ownership'/);
  });

  it('список берёт ту же формулу владения, а не свою копию', () => {
    expect(LIST).toMatch(/leadOwnershipCond\(user,/);
    expect(LIST).not.toMatch(/SELECT id FROM partners WHERE user_id = \$1/);
  });

  it('чужой лид неотличим от несуществующего: 404, не 403', () => {
    // 403 на чужом id раскрыл бы существование лида; в роуте 403 быть не должно
    // (право роли проверяет middleware, роут отвечает только 404).
    expect(DETAIL).not.toMatch(/status: 403/);
    expect(DETAIL).toMatch(/'Лид не найден' \}, \{ status: 404/);
  });

  it('DELETE остаётся только админским', () => {
    const deleteFn = DETAIL.slice(DETAIL.indexOf('export async function DELETE'));
    expect(deleteFn).toMatch(/requireAdmin\(request\)/);
  });
});

describe('владение лидом: четыре роута, где проверка была пропущена (аудит 24.08)', () => {
  it('GET /api/leads/[id]/proposal — скоуп применён к SELECT', () => {
    expect(PROPOSAL).toMatch(/import \{ leadOwnershipCond \} from '@\/lib\/leads\/ownership'/);
    expect(PROPOSAL).toMatch(/FROM leads WHERE id = \$1\$\{scope\.cond\}/);
  });

  it('POST /api/leads/[id]/proposal/send — проверка ДО вызова sendProposalToClient', () => {
    expect(PROPOSAL_SEND).toMatch(/import \{ canAccessLead \} from '@\/lib\/leads\/ownership'/);
    const beforeSend = PROPOSAL_SEND.slice(0, PROPOSAL_SEND.indexOf('sendProposalToClient(id'));
    expect(beforeSend).toMatch(/canAccessLead\(user, id\)/);
  });

  it('GET /api/leads/[id]/proposal/pdf — скоуп применён к SELECT', () => {
    expect(PROPOSAL_PDF).toMatch(/import \{ leadOwnershipCond \} from '@\/lib\/leads\/ownership'/);
    expect(PROPOSAL_PDF).toMatch(/FROM leads WHERE id = \$1\$\{scope\.cond\}/);
  });

  it('POST /api/leads/[id]/process — проверка ДО leadProcessor.process', () => {
    expect(PROCESS_BY_ID).toMatch(/import \{ canAccessLead \} from '@\/lib\/leads\/ownership'/);
    const beforeProcess = PROCESS_BY_ID.slice(0, PROCESS_BY_ID.indexOf('leadProcessor.process(id)'));
    expect(beforeProcess).toMatch(/canAccessLead\(user, id\)/);
  });

  it('POST /api/leads/process (lead_id из body) — проверка ДО leadProcessor.process', () => {
    expect(PROCESS_BODY).toMatch(/import \{ canAccessLead \} from '@\/lib\/leads\/ownership'/);
    const beforeProcess = PROCESS_BODY.slice(0, PROCESS_BODY.indexOf('leadProcessor.process(lead_id)'));
    expect(beforeProcess).toMatch(/canAccessLead\(user, lead_id\)/);
  });
});
