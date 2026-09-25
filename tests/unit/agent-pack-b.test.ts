/**
 * Кабинет агента, пакет B (26.09): деньги агента, одобрение, личность.
 *
 * Решения владельца, которые держит этот сторож:
 *  1. Ставку агента назначает владелец; нет ставки — нет вознаграждения
 *     (null и слова «ставка не назначена», никогда не умолчание в процентах).
 *     Начисляется только с ОПЛАЧЕННОЙ и НЕ отменённой брони, засчитанной
 *     агенту (operator_bookings.agent_user_id), к выплате — после конца тура
 *     + 36 часов. Бронь нельзя выплатить дважды; смена ставки не переписывает
 *     запрошенное и выплаченное (снимок).
 *  2. Агент работает только после одобрения администратором.
 *
 * Единственный источник денег агента — lib/payments/agent-commission.ts.
 * Роутовые проверки с моками — agent-pack-b-routes.test.ts; SQL на настоящем
 * PostgreSQL — tests/integration/agent-money.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';

const poolQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));
const requireAgentMock = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({ requireAgent: (...a: unknown[]) => requireAgentMock(...a) }));

import {
  classifySale, summarize, payableForRequest, commissionAmount, type SaleRow,
} from '@/lib/payments/agent-commission';
import { requireApprovedAgent, AGENT_NOT_APPROVED_ERROR } from '@/lib/auth/agent-approval';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function row(over: Partial<SaleRow> = {}): SaleRow {
  return {
    booking_id: '1', booking_date: '2026-08-01', tour_title: 'Вулкан Горелый',
    final_price: '20000.00', booking_status: 'confirmed', referral_link_id: null,
    voided: false, paid: true, release_after: '2026-08-03 12:00:00', released: true,
    payout_id: null, payout_status: null, item_rate: null, item_amount: null,
    ...over,
  };
}

describe('состояние продажи и сумма — одна функция', () => {
  it('нет ставки — нет вознаграждения: сумма null, а не 0', () => {
    const s = classifySale(row(), null);
    expect(s.state).toBe('payable');
    expect(s.amount).toBeNull();
    const sum = summarize([s], null);
    expect(sum.payable).toBeNull();
    expect(sum.waiting).toBeNull();
    expect(payableForRequest([s])).toEqual([]);
  });

  it('ставка 0 — решение «без вознаграждения», сумма 0, а не null', () => {
    expect(classifySale(row(), 0).amount).toBe(0);
  });

  it('сумма — продажа × ставка / 100 с округлением до копейки', () => {
    expect(commissionAmount(12345.67, 10)).toBe(1234.57);
    expect(classifySale(row(), 10).amount).toBe(2000);
  });

  it('отменённая, неоплаченная и ещё не отпущенная продажа к выплате не идут', () => {
    expect(classifySale(row({ voided: true }), 10).state).toBe('cancelled');
    expect(classifySale(row({ voided: true }), 10).amount).toBeNull();
    expect(classifySale(row({ paid: false }), 10).state).toBe('unpaid');
    expect(classifySale(row({ paid: false }), 10).amount).toBeNull();
    const waiting = classifySale(row({ released: false }), 10);
    expect(waiting.state).toBe('waiting');
    // Срок не вычислен — «не знаю» не равно «можно».
    expect(classifySale(row({ released: null }), 10).state).toBe('waiting');
    expect(payableForRequest([
      classifySale(row({ voided: true }), 10),
      classifySale(row({ paid: false }), 10),
      waiting,
    ])).toEqual([]);
  });

  it('запрошенная или выплаченная бронь второй раз в заявку не попадает, и ставка — снимок', () => {
    const requested = classifySale(row({ payout_id: 'p1', payout_status: 'pending', item_rate: '7.00', item_amount: '1400.00' }), 15);
    expect(requested.state).toBe('requested');
    expect(requested.rate).toBe(7);
    expect(requested.amount).toBe(1400);
    const paid = classifySale(row({ payout_id: 'p1', payout_status: 'paid', item_rate: '7.00', item_amount: '1400.00' }), 15);
    expect(paid.state).toBe('paid_out');
    expect(payableForRequest([requested, paid])).toEqual([]);
    const sum = summarize([requested, paid], 15);
    expect(sum.requested).toBe(1400);
    expect(sum.paidOut).toBe(1400);
  });

  it('отмена после заявки или выплаты — флаг администратору, не минус', () => {
    const afterPay = classifySale(row({ voided: true, payout_id: 'p1', payout_status: 'paid', item_rate: '10', item_amount: '2000' }), 10);
    expect(afterPay.flag).toBe('cancelled_after_payout');
    expect(afterPay.amount).toBe(2000);
    const inRequest = classifySale(row({ voided: true, payout_id: 'p1', payout_status: 'pending', item_rate: '10', item_amount: '2000' }), 10);
    expect(inRequest.flag).toBe('cancelled_in_request');
    const sum = summarize([afterPay, inRequest], 10);
    expect(sum.flagged).toBe(2);
    expect(sum.paidOut).toBeGreaterThanOrEqual(0);
  });

  it('оплаченная продажа без суммы брони не выдумывает деньги', () => {
    const s = classifySale(row({ final_price: null }), 10);
    expect(s.amount).toBeNull();
    expect(payableForRequest([s])).toEqual([]);
    expect(summarize([s], 10).withoutPrice).toBe(1);
  });
});

describe('SQL денег агента: признак продажи, отмена, срок выплаты', () => {
  const LIB = strip(read('lib/payments/agent-commission.ts'));

  it('продажа — бронь оператора с agent_user_id, не agent_bookings и не agent_commissions', () => {
    expect(LIB).toMatch(/WHERE ob\.agent_user_id = \$1::uuid/);
    expect(LIB).not.toMatch(/FROM agent_bookings|FROM agent_commissions/);
  });

  it('отмена — общий список статусов, срок выплаты — тот же, что у оператора', () => {
    expect(LIB).toMatch(/CANCELLED_STATUS_PARAM/);
    expect(LIB).toMatch(/COALESCE\(tp\.release_after, \$\{RELEASE_AFTER_SQL\}\)/);
    expect(LIB).toMatch(/import \{ RELEASE_AFTER_SQL \} from '@\/lib\/payments\/hold-tour-payment'/);
  });

  it('ставку читает только из записи агента; ни один автомат её не пишет', () => {
    expect(LIB).toMatch(/p\.agent_commission_rate::text AS rate/);
    // Писатель ставки — ровно один SQL (setRate), и зовёт его только рука
    // администратора. Новый писатель — решение владельца видимым коммитом.
    const hits = execSync(
      'grep -rlE "agent_commission_rate\\s*=" app lib components --include=*.ts --include=*.tsx || true',
      { cwd: ROOT, encoding: 'utf-8' },
    ).trim().split('\n').filter(Boolean).sort();
    expect(hits).toEqual(['lib/payments/agent-commission.ts']);
    const callers = execSync('grep -rl "AGENT_MONEY_SQL.setRate" app lib components || true', { cwd: ROOT, encoding: 'utf-8' })
      .trim().split('\n').filter(Boolean);
    expect(callers).toEqual(['app/api/admin/agent-commission/rate/route.ts']);
    expect(read('app/api/admin/agent-commission/rate/route.ts')).toMatch(/requireAdmin/);
  });
});

describe('одобрение агента — requireApprovedAgent', () => {
  const req = {} as NextRequest;

  beforeEach(() => {
    poolQuery.mockReset();
    requireAgentMock.mockReset();
  });

  it('администратор проходит без обращения к базе', async () => {
    requireAgentMock.mockResolvedValue({ userId: 'a', role: 'admin', email: 'a@x' });
    const r = await requireApprovedAgent(req);
    expect(r).toMatchObject({ role: 'admin' });
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('одобренный агент проходит', async () => {
    requireAgentMock.mockResolvedValue({ userId: 'u1', role: 'agent', email: 'a@x' });
    poolQuery.mockResolvedValue({ rows: [{ profile_status: 'approved' }] });
    const r = await requireApprovedAgent(req);
    expect(r).toMatchObject({ userId: 'u1' });
    expect(poolQuery.mock.calls[0][1]).toEqual(['u1']);
    expect(String(poolQuery.mock.calls[0][0])).toMatch(/category = 'agent'/);
  });

  it.each([['pending'], ['none'], ['rejected']])('агент в статусе %s — 403 с понятным текстом', async (st) => {
    requireAgentMock.mockResolvedValue({ userId: 'u1', role: 'agent', email: 'a@x' });
    poolQuery.mockResolvedValue({ rows: [{ profile_status: st }] });
    const r = await requireApprovedAgent(req);
    expect(r).toBeInstanceOf(Response);
    const res = r as Response;
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(AGENT_NOT_APPROVED_ERROR);
  });

  it('записи агента нет — тоже 403, а не «одобрен»', async () => {
    requireAgentMock.mockResolvedValue({ userId: 'u1', role: 'agent', email: 'a@x' });
    poolQuery.mockResolvedValue({ rows: [] });
    expect(((await requireApprovedAgent(req)) as Response).status).toBe(403);
  });

  it('база не ответила — 503 и строка в логе с SQLSTATE, а не пропуск', async () => {
    requireAgentMock.mockResolvedValue({ userId: 'u1', role: 'agent', email: 'a@x' });
    poolQuery.mockRejectedValue(Object.assign(new Error('boom'), { code: '57P01' }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await requireApprovedAgent(req) as Response;
    expect(r.status).toBe(503);
    expect(spy.mock.calls.some((c) => c.join(' ').includes('57P01'))).toBe(true);
    spy.mockRestore();
  });
});

describe('одобрение: онбординг агента подаёт заявку, очередь его видит', () => {
  it('завершение онбординга агента переводит none → pending', () => {
    const src = read('app/api/partners/profile/route.ts');
    expect(src).toMatch(/partner\.category === 'guide' \|\| partner\.category === 'agent'/);
    expect(src).toMatch(/submit_for_review/);
  });

  it('миграция 1025 переводит уже прошедших онбординг агентов в очередь', () => {
    const sql = read('migrations/1025_agent_onboarded_to_pending.sql');
    expect(sql).toMatch(/category = 'agent'[\s\S]*onboarding_completed = TRUE[\s\S]*profile_status = 'none'/);
  });

  it('очередь /hub/admin/operators берёт все партнёрские категории, включая агента, и подписывает его', async () => {
    const { PARTNER_CATEGORIES } = await import('@/lib/partners/categories');
    expect(PARTNER_CATEGORIES).toContain('agent');
    expect(read('app/api/admin/operators/route.ts')).toMatch(/p\.category = ANY\(\$1\)/);
    expect(read('app/hub/admin/operators/_OperatorsClient.tsx')).toMatch(/agent:\s*'Турагент'/);
  });

  it('письмо об одобрении агенту говорит про кабинет агента, а не про публикацию туров', () => {
    const src = read('app/api/admin/operators/[id]/route.ts');
    expect(src).toMatch(/const isAgent = partner\.category === 'agent'/);
    expect(src).toMatch(/Кабинет агента открыт/);
    expect(src).toMatch(/профиль агента/);
    // Агент не становится публичным от одобрения.
    expect(src).toMatch(/CASE WHEN category = 'agent' THEN is_public ELSE TRUE END/);
  });

  it('заявка на выплату закрыта до одобрения', () => {
    expect(read('app/api/agent/commissions/request-payout/route.ts')).toMatch(/await requireApprovedAgent\(request\)/);
  });

  it('профиль агента показывает статус проверки и даёт подать снова', () => {
    const ui = read('app/hub/agent/profile/_AgentProfileClient.tsx');
    expect(ui).toMatch(/Проверка платформой/);
    expect(ui).toMatch(/submit_for_review: true/);
  });
});

describe('администратор заводит агента честно', () => {
  const SRC = read('app/api/admin/users/create-agent/route.ts');
  const CODE = strip(SRC);

  it('согласие на ПД не выдумывается', () => {
    expect(CODE).not.toMatch(/'127\.0\.0\.1'/);
    expect(CODE).toMatch(/pd_consent_at, pd_consent_ip, created_at, updated_at\)\s*VALUES \(\$1, \$2, \$3, 'agent', \$4::jsonb, NULL, NULL/);
  });

  it('пароль — crypto.randomBytes, вход — /auth/login', () => {
    expect(CODE).not.toMatch(/Math\.random/);
    expect(CODE).toMatch(/randomBytes\(/);
    expect(CODE).toMatch(/login_url: '\/auth\/login'/);
  });

  it('запись партнёра агента создаётся сразу и одобрена: создание администратором и есть одобрение', () => {
    expect(CODE).toMatch(/'agent', \$3::jsonb, TRUE, 0, 0, 'approved'/);
    expect(SRC).toMatch(/АДМИНИСТРАТОР, заводящий агента\s*\n?\s*\*?\s*своей рукой, и есть одобрение/);
  });

  it('отказ пишется в лог с SQLSTATE', () => {
    expect(CODE).toMatch(/console\.error\('\[admin\/users\/create-agent\]/);
    expect(CODE).toMatch(/sqlstate=/);
  });
});

describe('агентский маркет данных: подтверждение — от администратора и только не истёкшее', () => {
  it('confirmed_by — из JWT, а не из тела; истёкший не подтверждается', () => {
    const code = strip(read('app/api/admin/agent-market/route.ts'));
    expect(code).not.toMatch(/confirmed_by:\s*z\./);
    expect(code).toMatch(/\[payment_id, authError\.userId, tx_id \?\? null\]/);
    expect(code).toMatch(/status = 'pending' AND expires_at > NOW\(\)/);
  });

  it('данные отдаются только по подтверждённому платежу; payment_id — UUID', () => {
    const code = strip(read('app/api/agent-market/routes/route.ts'));
    expect(code).toMatch(/if \(payment\.status !== 'confirmed'\)/);
    expect(code).toMatch(/payment_id: z\.string\(\)\.uuid\(/);
  });
});

describe('мёртвые деньги сняты', () => {
  it('payment.service удалён: соединялся с несуществующей agents, писал выдуманный статус', () => {
    expect(existsSync(join(ROOT, 'lib/services/payment.service.ts'))).toBe(false);
    expect(strip(read('lib/services/index.ts'))).not.toMatch(/payment\.service/);
  });

  it('обзор агента не парсит jsonb через JSON.parse и не читает agent_bookings', () => {
    const code = strip(read('app/api/agent/dashboard/route.ts'));
    expect(code).not.toMatch(/JSON\.parse/);
    expect(code + strip(read('lib/agent-cabinet/queries.ts'))).not.toMatch(/agent_bookings/);
  });

  it('статистика и обзор не суммируют agent_commissions', () => {
    for (const f of ['app/api/agent/stats/route.ts', 'app/api/agent/dashboard/route.ts', 'app/api/agent/commissions/route.ts', 'lib/agent-cabinet/queries.ts']) {
      expect(strip(read(f)), f).not.toMatch(/FROM agent_commissions/);
    }
  });

  it('экраны денег агента не подставляют нули при отказе', () => {
    const commissions = strip(read('app/hub/agent/commissions/_AgentCommissionsPageClient.tsx'));
    expect(commissions).not.toMatch(/EMPTY_STATS/);
    expect(commissions).toMatch(/ставка не назначена/);
    const stats = strip(read('app/hub/agent/stats/_StatsClient.tsx'));
    expect(stats).not.toMatch(/retention: 0/);
    expect(stats).toMatch(/Повторить/);
  });
});
