// @vitest-environment node
// (jose подписывает JWT через WebCrypto — в jsdom его нет)
/**
 * tests/unit/register-by-role.test.ts
 *
 * Регистрация по типу пользователя (POST /api/auth/register):
 * - партнёрские роли (stay/gear/guide/...) получают запись в partners
 *   с category=роль и user_id — иначе их кабинеты не видят данных;
 * - мультироли: по партнёрскому профилю на каждую роль;
 * - tourist партнёрского профиля не получает;
 * - operator сохраняет расширенную вставку (commission_rate, slug);
 * - в JWT-ответе есть role и roles.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';

const clientQueryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  pool: {
    connect: () => Promise.resolve({
      query: (...args: unknown[]) => clientQueryMock(...args),
      release: () => undefined,
    }),
  },
}));

// Вторая дверь регистрации партнёра (register-operator) берёт пул отсюда.
vi.mock('@/lib/db-pool', () => ({
  pool: {
    connect: () => Promise.resolve({
      query: (...args: unknown[]) => clientQueryMock(...args),
      release: () => undefined,
    }),
  },
}));

vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: () => ({ check: () => true }),
  getClientIp: () => '10.0.0.1',
  getTrustedClientIp: () => '10.0.0.1',
}));

// Подменяется только хеширование. `passwordSchema` берётся настоящая:
// правило пароля — часть контракта регистрации, и проверять её на
// заглушке значит не проверять вовсе.
vi.mock('@/lib/auth/password', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/password')>()),
  hashPassword: vi.fn().mockResolvedValue('$hashed$'),
}));

// Выключатель оплаты: настоящий — false; сцена «оплату открыли» переключает
// его здесь, не правя код роли (#3212).
const payments = vi.hoisted(() => ({ accepts: false }));
vi.mock('@/lib/payments/accepting', () => ({
  PLATFORM_ACCEPTS_PAYMENTS: false,
  platformAcceptsPayments: () => payments.accepts,
}));

process.env.JWT_SECRET = 'test-secret-for-register-by-role';

import { POST } from '@/app/api/auth/register/route';
import { POST as POST_OPERATOR_FORM } from '@/app/api/auth/register-operator/route';
import { GET as GET_ROLES } from '@/app/api/roles/route';

function registerReq(body: Record<string, unknown>): NextRequest {
  return new Request('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pd_consent: true, ...body }),
  }) as unknown as NextRequest;
}

function mockDb() {
  clientQueryMock.mockImplementation((sql: string) => {
    // Управление транзакцией названо явно, а не пропущено общим условием:
    // «неожиданный SQL» здесь — полезный сторож, ослаблять его нельзя.
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve({ rows: [] });
    if (sql.includes('SELECT id FROM users WHERE email')) return Promise.resolve({ rows: [] });
    if (sql.includes('INSERT INTO users')) {
      return Promise.resolve({
        rows: [{ id: 'user-uuid-12345678', email: 'p@x.ru', name: 'Партнёр', role: 'stay', preferences: {} }],
      });
    }
    if (sql.includes('INSERT INTO partners')) return Promise.resolve({ rows: [] });
    // Строка сессии — условие входа (register-session.test.ts держит её отдельно).
    if (sql.includes('INSERT INTO user_sessions')) return Promise.resolve({ rows: [] });
    throw new Error('unexpected SQL: ' + sql);
  });
}

function partnerInsertCalls() {
  return clientQueryMock.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO partners'));
}

beforeEach(() => {
  payments.accepts = false;
  clientQueryMock.mockReset();
  mockDb();
});

describe('POST /api/auth/register — партнёрские профили по ролям', () => {
  it('stay: создаётся partners-запись с category=stay и user_id', async () => {
    const res = await POST(registerReq({
      email: 'stay@x.ru', password: 'Secret123', name: 'Гостиница',
      role: 'stay', roles: ['stay'],
    }));
    expect(res.status).toBe(201);

    const inserts = partnerInsertCalls();
    expect(inserts).toHaveLength(1);
    const [, params] = inserts[0];
    expect((params as unknown[])[0]).toBe('user-uuid-12345678'); // user_id
    expect((params as unknown[])[2]).toBe('stay');               // category
  });

  it('мультироли gear+transfer: по профилю на каждую роль', async () => {
    const res = await POST(registerReq({
      email: 'multi@x.ru', password: 'Secret123', name: 'Партнёр',
      roles: ['gear', 'transfer'],
    }));
    expect(res.status).toBe(201);

    const categories = partnerInsertCalls().map(([, params]) => (params as unknown[])[2]);
    expect(categories).toEqual(['gear', 'transfer']);
  });

  it('tourist: партнёрский профиль не создаётся', async () => {
    const res = await POST(registerReq({
      email: 't@x.ru', password: 'Secret123', name: 'Турист', role: 'tourist',
    }));
    expect(res.status).toBe(201);
    expect(partnerInsertCalls()).toHaveLength(0);
  });

  it('operator: сохраняется расширенная вставка с commission_rate и slug', async () => {
    const res = await POST(registerReq({
      email: 'op@x.ru', password: 'Secret123', name: 'Оператор', role: 'operator',
    }));
    expect(res.status).toBe(201);

    const inserts = partnerInsertCalls();
    expect(inserts).toHaveLength(1);
    expect(String(inserts[0][0])).toContain('commission_rate');
    expect(String(inserts[0][0])).toContain('slug');
  });

  it('ответ содержит role и roles, токен уходит в cookie', async () => {
    const res = await POST(registerReq({
      email: 'stay2@x.ru', password: 'Secret123', name: 'Гостиница',
      roles: ['stay', 'gear'],
    }));
    expect(res.status).toBe(201);

    const body = await res.json() as { user: { role: string; roles: string[] }; token: string };
    expect(body.user.roles).toEqual(['stay', 'gear']);
    expect(body.token).toBeTruthy();
    expect(res.headers.get('set-cookie')).toContain('auth_token=');
  });
});

describe('POST /api/auth/register — роль агента заморожена, пока Ведар не принимает оплату (#3212)', () => {
  it('агентом зарегистрироваться нельзя: 403 с причиной словами, в базу ничего не пишется', async () => {
    for (const body of [{ role: 'agent' }, { roles: ['agent'] }, { roles: ['guide', 'agent'] }]) {
      clientQueryMock.mockClear();
      const res = await POST(registerReq({ email: 'ag@x.ru', password: 'Secret123', name: 'Агент', ...body }));
      expect(res.status, JSON.stringify(body)).toBe(403);
      const json = await res.json() as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/^Регистрация агентом закрыта: роль заморожена, пока Ведар не принимает оплату\./);
      expect(clientQueryMock).not.toHaveBeenCalled();
    }
  });

  it('другие партнёрские роли регистрируются как раньше', async () => {
    const res = await POST(registerReq({ email: 'g@x.ru', password: 'Secret123', name: 'Гид', roles: ['guide'] }));
    expect(res.status).toBe(201);
  });

  it('вторая дверь — форма партнёра (register-operator) с категорией агента: тот же отказ, в базу ничего', async () => {
    const res = await POST_OPERATOR_FORM(new Request('http://localhost/api/auth/register-operator', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyName: 'Тест', category: 'agent', contactName: 'Иван', phone: '+79000000000',
        email: 'ag2@x.ru', password: 'Secret123', pd_consent: true,
      }),
    }) as unknown as NextRequest);
    expect(res.status).toBe(403);
    const json = await res.json() as { success: boolean; error: string };
    expect(json.error).toMatch(/^Регистрация агентом закрыта: роль заморожена, пока Ведар не принимает оплату\./);
    expect(clientQueryMock).not.toHaveBeenCalled();
  });

  it('форма партнёра: гида заморозка не касается — запрос идёт в базу', async () => {
    const res = await POST_OPERATOR_FORM(new Request('http://localhost/api/auth/register-operator', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyName: 'Тест', category: 'guide', contactName: 'Иван', phone: '+79000000000',
        email: 'g2@x.ru', password: 'Secret123', pd_consent: true,
      }),
    }) as unknown as NextRequest);
    expect(res.status).not.toBe(403);
    expect(clientQueryMock).toHaveBeenCalled();
  });

  it('оплату открыли — форма партнёра пропускает агента дальше, в базу', async () => {
    payments.accepts = true;
    const res = await POST_OPERATOR_FORM(new Request('http://localhost/api/auth/register-operator', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyName: 'Тест', category: 'agent', contactName: 'Иван', phone: '+79000000000',
        email: 'ag3@x.ru', password: 'Secret123', pd_consent: true,
      }),
    }) as unknown as NextRequest);
    expect(res.status).not.toBe(403);
    expect(clientQueryMock).toHaveBeenCalled();
  });

  it('публичное описание ролей (GET /api/roles): агент заморожен, о вознаграждении ни слова', async () => {
    const res = await GET_ROLES(new Request('http://localhost/api/roles') as unknown as NextRequest);
    const { data } = await res.json() as { data: Array<{ id: string; description: string; features: string[]; permissions: string[]; frozen?: boolean }> };
    const agent = data.find((r) => r.id === 'agent');
    expect(agent?.frozen).toBe(true);
    expect(agent?.description).toBe(
      'Продажа туров клиентам. Роль заморожена: вознаграждение не начисляется, пока Ведар не принимает оплату. Новая регистрация агентом закрыта.',
    );
    expect(JSON.stringify(agent)).not.toMatch(/ваучер|GDS|Белые метки|комисси|Вознаграждение с|Реферальн|view_commissions/i);
    expect(agent?.features).toContain('Бронь за клиента — заявка оператору');
  });

  it('оплату открыли — описание агента снова говорит о вознаграждении', async () => {
    payments.accepts = true;
    const res = await GET_ROLES(new Request('http://localhost/api/roles') as unknown as NextRequest);
    const { data } = await res.json() as { data: Array<{ id: string; description: string; features: string[]; frozen?: boolean }> };
    const agent = data.find((r) => r.id === 'agent');
    expect(agent?.frozen).toBe(false);
    expect(agent?.description).toBe('Продажа туров клиентам за вознаграждение с оплаченных продаж');
    expect(agent?.features).toContain('Вознаграждение с оплаченных продаж');
  });

  it('оплату открыли — агент регистрируется без правок кода роли', async () => {
    payments.accepts = true;
    const res = await POST(registerReq({ email: 'ag@x.ru', password: 'Secret123', name: 'Агент', role: 'agent' }));
    expect(res.status).toBe(201);
    expect(partnerInsertCalls().map(([, params]) => (params as unknown[])[2])).toEqual(['agent']);
  });
});

/**
 * Регистрация партнёра: заперта не была бы, если бы отказ был слышен.
 *
 * 24.08 перепись PREPARE-ом (/api/cron/sql-shape-check) показала: INSERT
 * партнёрского профиля отвечал 42P08 «inconsistent types deduced for
 * parameter $3» и не выполнялся НИКОГДА. Бил он по всем партнёрским ролям,
 * кроме оператора (у того отдельная ветка с VALUES).
 *
 * Дальше складывались три обстоятельства, и запертую дверь давало именно их
 * сочетание: транзакции не было — строка в users фиксировалась автокоммитом;
 * исключение уходило в catch, который отвечал «попробуйте позже»; catch
 * ничего не писал в лог. Человек получал 500, повторял — и получал 409
 * «пользователь уже существует». Выйти из этого он не мог ничем, а мы об
 * этом не знали.
 */
describe('регистрация: аккаунт и партнёрский профиль — вместе или никак', () => {
  const SRC = readFileSync(join(process.cwd(), 'app/api/auth/register/route.ts'), 'utf-8');

  it('тип задан явно у каждого употребления параметра', () => {
    expect(SRC).toMatch(/SELECT \$1::uuid, \$2, \$3::varchar, \$4::jsonb/);
    expect(SRC).toMatch(/WHERE user_id = \$1::uuid AND category = \$3::varchar/);
  });

  it('транзакция открывается и закрывается', () => {
    expect(SRC).toContain("await client.query('BEGIN')");
    expect(SRC).toContain("await client.query('COMMIT')");
    expect(SRC).toMatch(/catch[\s\S]*ROLLBACK/);
  });

  it('ранний выход по 409 случается ДО BEGIN: откатывать там нечего', () => {
    const i409  = SRC.indexOf('уже существует');
    const iBegin = SRC.indexOf("client.query('BEGIN')");
    expect(i409).toBeGreaterThan(-1);
    expect(iBegin).toBeGreaterThan(-1);
    expect(i409).toBeLessThan(iBegin);
  });

  it('флаг отличает «транзакцию не начинали» от «начали»', () => {
    expect(SRC).toMatch(/let transactionOpen = false;/);
    expect(SRC).toMatch(/if \(client && transactionOpen\)/);
  });

  it('отказ пишется в лог с SQLSTATE, а человеку уходит общее сообщение', () => {
    expect(SRC).toMatch(/console\.error\(\s*'\[register\] регистрация не завершена:'/);
    expect(SRC).toContain('SQLSTATE=');
    // Подробности отказа наружу по-прежнему не выдаются.
    expect(SRC).toContain('Ошибка регистрации. Попробуйте позже.');
  });

  it('пустого catch в этом роуте не осталось', () => {
    expect(SRC).not.toMatch(/catch \(error: unknown\) \{\s*return NextResponse\.json\(/);
  });
});
