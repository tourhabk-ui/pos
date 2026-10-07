/**
 * Сброс пароля и аккаунт партнёра из админки (07.10).
 *
 * Повод: оператора «Край Вулканов» платформа заводит сама (карточка 1174 без
 * пользователя); ему нужен вход с временным паролем и путь «забыл пароль»,
 * которого на платформе не было вовсе — шаблон письма passwordResetEmail
 * лежал в email-templates.ts без единого вызова (§10.09).
 *
 * Сторож держит связку целиком: таблица → библиотека (хеш, одноразовость,
 * срок, закрытие сессий) → два публичных роута (одно тело на все нейтральные
 * исходы, честное 503 без SMTP и при лежащей почте, лимиты по доверенному IP)
 * → страницы и ссылка со входа → админские роуты (только админ, одна
 * транзакция, пароль один раз, только своим операторам, без согласия за
 * человека) → список админки видит карточку без аккаунта.
 *
 * Поведение проверяется запросами, а не только регэкспом по исходнику:
 * адверсарное ревью 07.10 показало, что сторож по тексту зеленел при
 * выключенном лимите и выключенном requireAdmin.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { mailHealth } from '@/app/api/auth/forgot-password/route';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const LIB = 'lib/auth/password-reset.ts';
const MIGRATION = 'migrations/1175_password_reset_tokens.sql';
const FORGOT = 'app/api/auth/forgot-password/route.ts';
const RESET = 'app/api/auth/reset-password/route.ts';
const ACCOUNT = 'app/api/admin/operators/[id]/account/route.ts';
const RESET_LINK = 'app/api/admin/operators/[id]/reset-link/route.ts';
const ADMIN_LIST = 'app/api/admin/operators/route.ts';
const ADMIN_UI = 'app/hub/admin/operators/_OperatorsClient.tsx';
const MAIL = 'lib/notifications/password-reset-email.ts';

/* ─── моки ───────────────────────────────────────────────────────────────── */

type Q = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>;
const poolQuery = vi.hoisted(() => vi.fn<Q>());
const clientQuery = vi.hoisted(() => vi.fn<Q>());
const clientRelease = vi.hoisted(() => vi.fn());
const sendEmail = vi.hoisted(() => vi.fn<(o: { to: string; subject: string; html: string; text?: string }) => Promise<{ success: boolean; error?: string }>>());

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (sql: string, params?: unknown[]) => poolQuery(sql, params),
    connect: async () => ({ query: (sql: string, params?: unknown[]) => clientQuery(sql, params), release: clientRelease }),
  },
}));
vi.mock('@/lib/auth/password', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/password')>()),
  hashPassword: async (p: string) => `hashed:${p}`,
}));
vi.mock('@/lib/notifications/email-service', () => ({
  emailService: { sendEmail: (o: { to: string; subject: string; html: string; text?: string }) => sendEmail(o) },
}));
vi.mock('@/lib/auth/middleware', () => ({
  requireAdmin: vi.fn(async () => ({ userId: 'admin-0000', email: 'admin@test', role: 'admin' })),
}));

let ipSeq = 0;
/** Каждый запрос — со своего доверенного IP, чтобы лимит не срабатывал между тестами. */
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'x-real-ip': `198.51.100.${(ipSeq++ % 200) + 1}`,
      'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 250)}`,
      ...headers,
    },
  });

const sql = (calls: Array<[string, unknown[] | undefined]>) => calls.map(([s]) => s.replace(/\s+/g, ' ').trim());
const calls = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls as Array<[string, unknown[] | undefined]>;

beforeEach(() => {
  poolQuery.mockReset();
  clientQuery.mockReset();
  clientRelease.mockReset();
  sendEmail.mockReset();
  vi.mocked(requireAdmin).mockReset();
  vi.mocked(requireAdmin).mockResolvedValue({ userId: 'admin-0000', email: 'admin@test', role: 'admin' });
  clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mailHealth.downUntil = 0;
});

/* ─── 1. таблица ─────────────────────────────────────────────────────────── */

describe('таблица password_reset_tokens (1175)', () => {
  it('хранит хеш, срок и одноразовость; сырого токена колонки нет', () => {
    const m = read(MIGRATION);
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS password_reset_tokens/);
    expect(m).toMatch(/token_hash\s+TEXT NOT NULL UNIQUE/);
    expect(m).toMatch(/expires_at\s+TIMESTAMPTZ NOT NULL/);
    expect(m).toMatch(/used_at\s+TIMESTAMPTZ/);
    expect(m).toMatch(/issued_by\s+UUID REFERENCES users\(id\)/);
    expect(m).not.toMatch(/^\s*token\s+TEXT/m);
    expect(m).toMatch(/user_id\s+UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  });
});

/* ─── 2. библиотека ──────────────────────────────────────────────────────── */

describe('lib/auth/password-reset', () => {
  it('токен случайный и URL-безопасный, хеш — sha256 и не равен токену', async () => {
    const { generateResetToken, hashResetToken, buildResetLink } = await import('@/lib/auth/password-reset');
    const t = generateResetToken();
    expect(t.length).toBeGreaterThanOrEqual(40);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(generateResetToken()).not.toBe(t);
    const h = hashResetToken(t);
    expect(h).toBe(createHash('sha256').update(t).digest('hex'));
    expect(h).not.toBe(t);
    expect(buildResetLink(t)).toMatch(/\/auth\/reset-password\?token=/);
    expect(buildResetLink(t)).toContain(t);
  });

  it('сроки — ровно те, что обещают тексты письма и сообщения', async () => {
    const m = await import('@/lib/auth/password-reset');
    expect(m.SELF_SERVICE_TTL_MS).toBe(60 * 60_000);
    expect(m.SELF_SERVICE_TTL_TEXT).toBe('один час');
    expect(m.ADMIN_ISSUED_TTL_MS).toBe(24 * 60 * 60_000);
    expect(m.ADMIN_ISSUED_TTL_TEXT).toBe('сутки');
    expect(read(FORGOT)).toMatch(/ttlText: SELF_SERVICE_TTL_TEXT/);
    expect(read(RESET_LINK)).toMatch(/\$\{ADMIN_ISSUED_TTL_TEXT\}/);
  });

  it('выдача — один оператор: отзыв прежних + вставка ХЕША; сырой токен только в ссылке', async () => {
    const { issuePasswordResetToken, hashResetToken } = await import('@/lib/auth/password-reset');
    const exec = { query: vi.fn<Q>().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const before = Date.now();
    const issued = await issuePasswordResetToken({ userId: 'u-1', issuedBy: 'admin-1' }, exec);
    expect(exec.query).toHaveBeenCalledTimes(1);
    const [stmt, params] = calls(exec.query)[0];
    const flat = stmt.replace(/\s+/g, ' ');
    expect(flat).toMatch(/WITH gone AS \( DELETE FROM password_reset_tokens WHERE user_id = \$1::uuid AND used_at IS NULL AND \(\$4::uuid IS NOT NULL OR issued_by IS NULL\) \) INSERT INTO password_reset_tokens \(user_id, token_hash, expires_at, issued_by\)/);
    expect(params![1]).toBe(hashResetToken(issued.token));
    expect(params).not.toContain(issued.token);
    expect(params![3]).toBe('admin-1');
    expect(issued.link).toContain(issued.token);
    expect(issued.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60 * 60_000);
    expect(issued.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60_000 + 5_000);
  });

  it('самообслуживание передаёт issued_by = NULL — то есть не отзывает ссылку администратора', async () => {
    const { issuePasswordResetToken } = await import('@/lib/auth/password-reset');
    const exec = { query: vi.fn<Q>().mockResolvedValue({ rows: [], rowCount: 1 }) };
    await issuePasswordResetToken({ userId: 'u-1' }, exec);
    expect(calls(exec.query)[0][1]![3]).toBeNull();
  });

  it('погашение: нет строки → invalid, used_at → used, срок → expired; ROLLBACK, release, сессии целы', async () => {
    const { consumePasswordResetToken } = await import('@/lib/auth/password-reset');
    const scenarios: Array<[unknown[], string]> = [
      [[], 'invalid'],
      [[{ id: '1', user_id: 'u', expired: false, used: true }], 'used'],
      [[{ id: '1', user_id: 'u', expired: true, used: false }], 'expired'],
    ];
    for (const [rows, reason] of scenarios) {
      clientQuery.mockReset();
      clientRelease.mockReset();
      clientQuery.mockImplementation(async (s) => (/FOR UPDATE/.test(s) ? { rows, rowCount: rows.length } : { rows: [], rowCount: 0 }));
      const r = await consumePasswordResetToken('tok-tok-tok-tok-tok-tok', 'NovyParol2026');
      expect(r).toEqual({ ok: false, reason });
      const seen = sql(calls(clientQuery));
      expect(seen[0]).toBe('BEGIN');
      expect(seen.at(-1)).toBe('ROLLBACK');
      expect(seen.some((s) => /UPDATE users|user_sessions/.test(s))).toBe(false);
      expect(clientRelease).toHaveBeenCalledTimes(1);
    }
  });

  it('погашение: живой токен → пароль сменён, флаг снят, токен погашен предикатом в SQL, остальные ссылки и сессии закрыты, COMMIT', async () => {
    const { consumePasswordResetToken, hashResetToken } = await import('@/lib/auth/password-reset');
    clientQuery.mockImplementation(async (s) => {
      if (/FOR UPDATE/.test(s)) return { rows: [{ id: '7', user_id: 'u-7', expired: false, used: false }], rowCount: 1 };
      if (/UPDATE password_reset_tokens/.test(s)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const r = await consumePasswordResetToken('tok-tok-tok-tok-tok-tok', 'NovyParol2026');
    expect(r).toEqual({ ok: true, userId: 'u-7' });
    const c = calls(clientQuery);
    const seen = sql(c);
    expect(c[1][1]).toEqual([hashResetToken('tok-tok-tok-tok-tok-tok')]);
    const stamp = seen.find((s) => /UPDATE password_reset_tokens/.test(s))!;
    expect(stamp).toMatch(/SET used_at = NOW\(\) WHERE id = \$1 AND used_at IS NULL AND expires_at > NOW\(\)/);
    const users = seen.find((s) => /UPDATE users/.test(s))!;
    expect(users).toMatch(/password_hash = \$1/);
    expect(users).toMatch(/- 'force_password_change'/);
    expect(c.find(([s]) => /UPDATE users/.test(s))![1]).toEqual(['hashed:NovyParol2026', 'u-7']);
    const siblings = c.find(([s]) => /DELETE FROM password_reset_tokens/.test(s))!;
    expect(siblings[0].replace(/\s+/g, ' ')).toMatch(/WHERE user_id = \$1::uuid AND id <> \$2 AND used_at IS NULL/);
    expect(siblings[1]).toEqual(['u-7', '7']);
    const sessions = c.find(([s]) => /DELETE FROM user_sessions/.test(s))!;
    expect(sessions[0].replace(/\s+/g, ' ')).toMatch(/DELETE FROM user_sessions WHERE user_id = \$1::uuid/);
    expect(sessions[1]).toEqual(['u-7']);
    expect(seen.indexOf('COMMIT')).toBeGreaterThan(seen.findIndex((s) => /user_sessions/.test(s)));
    expect(seen.at(-1)).toBe('COMMIT');
    expect(clientRelease).toHaveBeenCalledTimes(1);
  });

  it('гонка: UPDATE погашения не задел строку → used, не ok', async () => {
    const { consumePasswordResetToken } = await import('@/lib/auth/password-reset');
    clientQuery.mockImplementation(async (s) => {
      if (/FOR UPDATE/.test(s)) return { rows: [{ id: '7', user_id: 'u-7', expired: false, used: false }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const r = await consumePasswordResetToken('tok-tok-tok-tok-tok-tok', 'NovyParol2026');
    expect(r).toEqual({ ok: false, reason: 'used' });
    expect(sql(calls(clientQuery)).some((s) => /UPDATE users|user_sessions/.test(s))).toBe(false);
  });

  it('транзакция на одном соединении (pool.connect), не на pool.query; токен не в логе', () => {
    const src = read(LIB);
    expect(src).toMatch(/pool\.connect\(\)/);
    expect(src).not.toMatch(/pool\.query\('BEGIN'\)/);
    expect(src).toMatch(/FOR UPDATE/);
    expect(src).not.toMatch(/console\.(log|error|warn)\([^)]*\btoken\b/);
  });
});

/* ─── 3. форма «Забыли пароль?» ──────────────────────────────────────────── */

describe('POST /api/auth/forgot-password', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });
  const smtpOn = () => { process.env.SMTP_USER = 'u'; process.env.SMTP_PASS = 'p'; };

  it('без SMTP — честное 503 ДО поиска пользователя, токен не выдаётся', async () => {
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    const { POST, MAIL_NOT_CONFIGURED_TEXT } = await import('@/app/api/auth/forgot-password/route');
    const res = await POST(post('/api/auth/forgot-password', { email: 'someone@example.test' }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(MAIL_NOT_CONFIGURED_TEXT);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('неизвестный адрес, известный адрес и исчерпанный лимит по адресу — ОДНО И ТО ЖЕ тело', async () => {
    smtpOn();
    const { POST, NEUTRAL_TEXT } = await import('@/app/api/auth/forgot-password/route');

    poolQuery.mockResolvedValue({ rows: [] });
    const unknown = await POST(post('/api/auth/forgot-password', { email: 'nobody@example.test' }));
    expect(unknown.status).toBe(200);
    const unknownBody = await unknown.json();
    expect(unknownBody.message).toBe(NEUTRAL_TEXT);
    expect(sql(calls(poolQuery))).toEqual([
      expect.stringMatching(/SELECT id, name FROM users WHERE email = \$1 AND is_active IS DISTINCT FROM FALSE/),
    ]);
    expect(sendEmail).not.toHaveBeenCalled();

    poolQuery.mockReset();
    poolQuery.mockImplementation(async (s) => (/FROM users/.test(s) ? { rows: [{ id: 'u-9', name: 'Н' }] } : { rows: [], rowCount: 1 }));
    sendEmail.mockResolvedValue({ success: true });
    const known = await POST(post('/api/auth/forgot-password', { email: 'known-same@example.test' }));
    expect(known.status).toBe(200);
    expect(await known.json()).toEqual(unknownBody);

    // Лимит по адресу: 3 в час, четвёртый — то же тело, ни запроса, ни письма.
    for (let i = 0; i < 2; i++) await POST(post('/api/auth/forgot-password', { email: 'known-same@example.test' }));
    poolQuery.mockClear();
    sendEmail.mockClear();
    const limited = await POST(post('/api/auth/forgot-password', { email: 'known-same@example.test' }));
    expect(limited.status).toBe(200);
    expect(await limited.json()).toEqual(unknownBody);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('известный адрес — письмо со ссылкой на сырой токен, в базе хеш, имя экранировано', async () => {
    smtpOn();
    poolQuery.mockImplementation(async (s) => (/FROM users/.test(s) ? { rows: [{ id: 'u-9', name: 'Эдуард <b>' }] } : { rows: [], rowCount: 1 }));
    sendEmail.mockResolvedValue({ success: true });
    const { POST } = await import('@/app/api/auth/forgot-password/route');
    const res = await POST(post('/api/auth/forgot-password', { email: 'Known@Example.test' }));
    expect(res.status).toBe(200);
    const insert = calls(poolQuery).find(([s]) => /INSERT INTO password_reset_tokens/.test(s))!;
    const storedHash = (insert[1] as unknown[])[1] as string;
    expect((insert[1] as unknown[])[3]).toBeNull();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toBe('known@example.test');
    const m = /token=([A-Za-z0-9_-]+)/.exec(mail.html)!;
    expect(m).not.toBeNull();
    expect(createHash('sha256').update(m[1]).digest('hex')).toBe(storedHash);
    expect(mail.html).not.toContain(storedHash);
    expect(mail.html).toContain('Эдуард &lt;b&gt;');
    expect(mail.html).toContain('один час');
    expect(mail.subject).toContain('Ведар');
    expect(mail.html).not.toContain('KamHub');
  });

  it('письмо не ушло — 503 без адреса в логе, и пять минут 503 получают все, даже неизвестный адрес', async () => {
    smtpOn();
    poolQuery.mockImplementation(async (s) => (/FROM users/.test(s) ? { rows: [{ id: 'u-9', name: 'Н' }] } : { rows: [], rowCount: 1 }));
    sendEmail.mockResolvedValue({ success: false, error: "Can't send mail - all recipients were rejected: 550 5.1.1 <known-fail@example.test>: Recipient address rejected" });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { POST, MAIL_DOWN_TEXT } = await import('@/app/api/auth/forgot-password/route');
    const res = await POST(post('/api/auth/forgot-password', { email: 'known-fail@example.test' }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(MAIL_DOWN_TEXT);
    const logged = errSpy.mock.calls.flat().join(' ');
    expect(logged).toContain('[forgot-password]');
    expect(logged).not.toContain('known-fail@example.test');
    errSpy.mockRestore();

    poolQuery.mockClear();
    const unknown = await POST(post('/api/auth/forgot-password', { email: 'nobody-after-fail@example.test' }));
    expect(unknown.status).toBe(503);
    expect((await unknown.json()).error).toBe(MAIL_DOWN_TEXT);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(mailHealth.downUntil).toBeGreaterThan(Date.now());
  });

  it('лимит по IP: шестой запрос с одного доверенного IP — 429, подмена X-Forwarded-For не помогает', async () => {
    smtpOn();
    poolQuery.mockResolvedValue({ rows: [] });
    const { POST } = await import('@/app/api/auth/forgot-password/route');
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await POST(post('/api/auth/forgot-password', { email: `probe-${i}@example.test` }, {
        'x-real-ip': '203.0.113.77',
        'x-forwarded-for': `10.9.${i}.${i}`,
      }));
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it('исходник: два лимита по доверенному IP, адрес не попадает в лог, свой шаблон Ведара, SMTP до поиска', () => {
    const src = read(FORGOT);
    expect(src.match(/createRateLimiter\(/g)?.length).toBe(2);
    expect(src).toMatch(/getTrustedClientIp\(request\.headers\)/);
    expect(src).not.toMatch(/\bgetClientIp\(/);
    expect(src).not.toMatch(/console\.(log|error|warn)\([^)]*\bemail\b/);
    expect(src).toMatch(/redactPII\(sent\.error/);
    expect(src).toMatch(/passwordResetEmailVedar/);
    expect(src).not.toMatch(/email-templates/);
    expect(src.indexOf('mailConfigured()')).toBeLessThan(src.indexOf('FROM users'));
    expect(src.indexOf('mailHealth.downUntil)')).toBeLessThan(src.indexOf('FROM users'));
  });
});

/* ─── 4. новый пароль по ссылке ──────────────────────────────────────────── */

describe('POST /api/auth/reset-password', () => {
  it('слабый пароль — 400 правилом платформы, база не трогается', async () => {
    const { POST } = await import('@/app/api/auth/reset-password/route');
    const res = await POST(post('/api/auth/reset-password', { token: 'tok-tok-tok-tok-tok-tok-tok', password: 'short' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/8 символов/);
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('устаревший токен — 400 с причиной; живой — 200 без выдачи сессии', async () => {
    const { POST } = await import('@/app/api/auth/reset-password/route');
    clientQuery.mockImplementation(async (s) => (/FOR UPDATE/.test(s)
      ? { rows: [{ id: '1', user_id: 'u', expired: true, used: false }], rowCount: 1 }
      : { rows: [], rowCount: 0 }));
    let res = await POST(post('/api/auth/reset-password', { token: 'tok-tok-tok-tok-tok-tok-tok', password: 'NovyParol2026' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/устарела/);

    clientQuery.mockImplementation(async (s) => {
      if (/FOR UPDATE/.test(s)) return { rows: [{ id: '1', user_id: 'u', expired: false, used: false }], rowCount: 1 };
      if (/UPDATE password_reset_tokens/.test(s)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    res = await POST(post('/api/auth/reset-password', { token: 'tok-tok-tok-tok-tok-tok-tok', password: 'NovyParol2026' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('лимит по IP: одиннадцатый запрос с одного доверенного IP — 429', async () => {
    const { POST } = await import('@/app/api/auth/reset-password/route');
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await POST(post('/api/auth/reset-password', { token: 'x', password: 'x' }, { 'x-real-ip': '203.0.113.78' }));
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('исходник: правило пароля общее, сессия не выдаётся, лимит по доверенному IP', () => {
    const src = read(RESET);
    expect(src).toMatch(/passwordSchema/);
    expect(src).toMatch(/createRateLimiter\(/);
    expect(src).toMatch(/getTrustedClientIp\(request\.headers\)/);
    expect(src).not.toMatch(/\bgetClientIp\(/);
    expect(src).not.toMatch(/signToken|setAuthCookie|lib\/auth'/);
  });
});

/* ─── 5. страницы и вход ─────────────────────────────────────────────────── */

describe('страницы', () => {
  it('со входа есть «Забыли пароль?», обе страницы существуют и закрыты от индекса', () => {
    expect(read('app/auth/login/_AuthPageClient.tsx')).toMatch(/href="\/auth\/forgot-password"/);
    for (const p of ['app/auth/forgot-password/page.tsx', 'app/auth/reset-password/page.tsx']) {
      expect(existsSync(join(ROOT, p)), p).toBe(true);
      expect(read(p)).toMatch(/robots:\s*\{\s*index:\s*false/);
    }
    const reset = read('app/auth/reset-password/_ResetPasswordClient.tsx');
    expect(reset).toMatch(/PASSWORD_RULE_HINT/);
    expect(reset).toMatch(/get\('token'\)/);
    expect(reset).toMatch(/fetch\('\/api\/auth\/reset-password'/);
    expect(read('app/auth/forgot-password/_ForgotPasswordClient.tsx')).toMatch(/fetch\('\/api\/auth\/forgot-password'/);
  });

  it('публичные роуты достижимы на Edge (префикс /api/auth открыт)', async () => {
    const { isPublicApiPath } = await import('@/lib/auth/public-api-routes');
    expect(isPublicApiPath('/api/auth/forgot-password', 'POST')).toBe(true);
    expect(isPublicApiPath('/api/auth/reset-password', 'POST')).toBe(true);
  });

  it('письмо: имя и ссылка экранированы, бренд Ведар, не KamHub', async () => {
    const src = read(MAIL);
    expect(src).toMatch(/escapeHtml\(data\.userName\)/);
    expect(src).toMatch(/escapeHtml\(data\.resetLink\)/);
    const { passwordResetEmailVedar } = await import('@/lib/notifications/password-reset-email');
    const mail = passwordResetEmailVedar({ userName: '<i>Имя</i>', resetLink: 'https://x.test/auth/reset-password?token=a"b', ttlText: 'час' });
    expect(mail.html).toContain('&lt;i&gt;Имя&lt;/i&gt;');
    expect(mail.html).toContain('token=a&quot;b');
    expect(mail.html).not.toContain('<i>Имя</i>');
    for (const part of [mail.subject, mail.html, mail.text]) {
      expect(part).not.toContain('KamHub');
      expect(part).toContain('Ведар');
    }
  });
});

/* ─── 6. аккаунт из админки ──────────────────────────────────────────────── */

describe('POST /api/admin/operators/[id]/account', () => {
  const ID = '41e2c8f8-2d29-41b8-87a7-46ffd78b65d5';
  const params = { params: Promise.resolve({ id: ID }) };
  const card = (over: Partial<{ user_id: string | null; card_email: string | null; category: string; external_source: string | null }> = {}) =>
    ({ id: ID, name: 'Край Вулканов', category: 'operator', user_id: null, external_source: null, card_email: 'mail@volcanoesland.ru', ...over });
  const withCard = (c: ReturnType<typeof card>, rest: (s: string) => { rows: unknown[]; rowCount: number } = () => ({ rows: [], rowCount: 0 })) =>
    clientQuery.mockImplementation(async (s) => (/FROM partners/.test(s) ? { rows: [c], rowCount: 1 } : rest(s)));
  const happy = (s: string) => {
    if (/SELECT id FROM users/.test(s)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO users/.test(s)) return { rows: [{ id: 'u-new' }], rowCount: 1 };
    if (/UPDATE partners/.test(s)) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };

  it('не администратор — ответ requireAdmin как есть, база не трогается', async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce(NextResponse.json({ success: false, error: 'Нет доступа' }, { status: 403 }));
    const { POST } = await import('@/app/api/admin/operators/[id]/account/route');
    const res = await POST(post(`/api/admin/operators/${ID}/account`, {}), params);
    expect(res.status).toBe(403);
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('своя карточка оператора без аккаунта: пользователь + привязка одной транзакцией, пароль один раз', async () => {
    withCard(card(), happy);
    const { POST } = await import('@/app/api/admin/operators/[id]/account/route');
    const res = await POST(post(`/api/admin/operators/${ID}/account`, {}), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.email).toBe('mail@volcanoesland.ru');
    expect(body.data.oneTimePassword).toMatch(/^[A-HJ-NP-Za-km-z2-9]{14}$/);

    const c = calls(clientQuery);
    const seen = sql(c);
    expect(seen[0]).toBe('BEGIN');
    expect(seen.at(-1)).toBe('COMMIT');
    expect(seen[1]).toMatch(/SELECT id, name, category, user_id, external_source/);
    const ins = c.find(([s]) => /INSERT INTO users/.test(s))!;
    const p = ins[1] as unknown[];
    expect(p[0]).toBe('mail@volcanoesland.ru');
    expect(p[1]).toBe(`hashed:${body.data.oneTimePassword}`);
    expect(p[3]).toBe('operator');
    expect(JSON.parse(p[4] as string)).toEqual({ roles: ['operator'], force_password_change: true });
    expect(ins[0]).not.toMatch(/pd_consent/);
    const upd = seen.find((s) => /UPDATE partners/.test(s))!;
    expect(upd).toMatch(/SET user_id = \$1::uuid/);
    expect(upd).toMatch(/AND user_id IS NULL/);
    expect(c.find(([s]) => /UPDATE partners/.test(s))![1]).toEqual(['u-new', ID]);
    expect(clientRelease).toHaveBeenCalledTimes(1);
  });

  it('привязка не задела строку (кто-то успел раньше) — 409, ROLLBACK, без COMMIT', async () => {
    withCard(card(), (s) => (/UPDATE partners/.test(s) ? { rows: [], rowCount: 0 } : /INSERT INTO users/.test(s) ? { rows: [{ id: 'u-new' }], rowCount: 1 } : { rows: [], rowCount: 0 }));
    const { POST } = await import('@/app/api/admin/operators/[id]/account/route');
    const res = await POST(post(`/api/admin/operators/${ID}/account`, {}), params);
    expect(res.status).toBe(409);
    const seen = sql(calls(clientQuery));
    expect(seen).toContain('ROLLBACK');
    expect(seen).not.toContain('COMMIT');
    expect(clientRelease).toHaveBeenCalledTimes(1);
  });

  it('аккаунт уже есть / email занят / гонка по UNIQUE (23505) — 409; некорректный email карточки — 400', async () => {
    const { POST, EMAIL_TAKEN_TEXT, BAD_CARD_EMAIL_TEXT } = await import('@/app/api/admin/operators/[id]/account/route');

    withCard(card({ user_id: 'u-old' }));
    let res = await POST(post(`/api/admin/operators/${ID}/account`, {}), params);
    expect(res.status).toBe(409);
    expect(sql(calls(clientQuery))).not.toContain('COMMIT');

    clientQuery.mockReset();
    withCard(card(), (s) => (/SELECT id FROM users/.test(s) ? { rows: [{ id: 'someone' }], rowCount: 1 } : { rows: [], rowCount: 0 }));
    res = await POST(post(`/api/admin/operators/${ID}/account`, {}), params);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(EMAIL_TAKEN_TEXT);
    expect(sql(calls(clientQuery)).some((s) => /INSERT INTO users/.test(s))).toBe(false);

    clientQuery.mockReset();
    clientQuery.mockImplementation(async (s) => {
      if (/FROM partners/.test(s)) return { rows: [card()], rowCount: 1 };
      if (/INSERT INTO users/.test(s)) throw Object.assign(new Error('duplicate key'), { code: '23505' });
      return { rows: [], rowCount: 0 };
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    res = await POST(post(`/api/admin/operators/${ID}/account`, {}), params);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(EMAIL_TAKEN_TEXT);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();

    for (const bad of [null, 'a@b.ru, c@d.ru', 'mail @ site.ru']) {
      clientQuery.mockReset();
      withCard(card({ card_email: bad }));
      res = await POST(post(`/api/admin/operators/${ID}/account`, {}), params);
      expect(res.status, String(bad)).toBe(400);
      expect((await res.json()).error).toBe(BAD_CARD_EMAIL_TEXT);
      expect(sql(calls(clientQuery)).some((s) => /INSERT INTO users/.test(s))).toBe(false);
    }
  });

  it('не оператор или импорт с чужого сайта — 409, пользователь не заводится', async () => {
    const { POST, ONLY_OPERATOR_TEXT, IMPORTED_CARD_TEXT } = await import('@/app/api/admin/operators/[id]/account/route');
    withCard(card({ category: 'guide' }), happy);
    let res = await POST(post(`/api/admin/operators/${ID}/account`, {}), params);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(ONLY_OPERATOR_TEXT);
    expect(sql(calls(clientQuery)).some((s) => /INSERT INTO users/.test(s))).toBe(false);

    clientQuery.mockReset();
    withCard(card({ external_source: 'visitkamchatka' }), happy);
    res = await POST(post(`/api/admin/operators/${ID}/account`, {}), params);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(IMPORTED_CARD_TEXT);
    expect(sql(calls(clientQuery)).some((s) => /INSERT INTO users/.test(s))).toBe(false);

    clientQuery.mockReset();
    withCard(card({ external_source: 'admin' }), happy);
    res = await POST(post(`/api/admin/operators/${ID}/account`, {}), params);
    expect(res.status).toBe(200);
  });

  it('исходник: общий генератор пароля, пароль не в логе, согласие не пишется, тексты ошибок русские', () => {
    const src = read(ACCOUNT);
    expect(src).toMatch(/import \{ generatePassword \} from '@\/app\/api\/admin\/operators\/create\/route'/);
    expect(src).toMatch(/force_password_change: true/);
    expect(src).not.toMatch(/pd_consent/);
    expect(src).not.toMatch(/console\.(log|error|warn)\([^)]*oneTimePassword/);
    expect(src).not.toMatch(/sendEmail/);
    expect(src).not.toMatch(/\.min\(2\)|\.max\(255\)/);
  });
});

/* ─── 7. ссылка сброса из админки ────────────────────────────────────────── */

describe('POST /api/admin/operators/[id]/reset-link', () => {
  const ID = '41e2c8f8-2d29-41b8-87a7-46ffd78b65d5';
  const params = { params: Promise.resolve({ id: ID }) };

  it('не администратор — ответ requireAdmin как есть, база не трогается', async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce(NextResponse.json({ success: false, error: 'Нет доступа' }, { status: 403 }));
    const { POST } = await import('@/app/api/admin/operators/[id]/reset-link/route');
    const res = await POST(post(`/api/admin/operators/${ID}/reset-link`, {}), params);
    expect(res.status).toBe(403);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('без аккаунта — 409; с аккаунтом — ссылка на сутки с issued_by администратора', async () => {
    const { POST } = await import('@/app/api/admin/operators/[id]/reset-link/route');
    poolQuery.mockResolvedValue({ rows: [{ name: 'Край Вулканов', user_id: null }] });
    let res = await POST(post(`/api/admin/operators/${ID}/reset-link`, {}), params);
    expect(res.status).toBe(409);

    poolQuery.mockReset();
    poolQuery.mockImplementation(async (s) => (/FROM partners/.test(s) ? { rows: [{ name: 'Край Вулканов', user_id: 'u-7' }] } : { rows: [], rowCount: 1 }));
    const before = Date.now();
    res = await POST(post(`/api/admin/operators/${ID}/reset-link`, {}), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.link).toMatch(/\/auth\/reset-password\?token=/);
    expect(body.data.message).toContain(body.data.link);
    expect(body.data.message).toContain('сутки');
    expect(body.data.message).not.toMatch(/@|\+7/);
    const ins = calls(poolQuery).find(([s]) => /INSERT INTO password_reset_tokens/.test(s))!;
    expect((ins[1] as unknown[])[0]).toBe('u-7');
    expect((ins[1] as unknown[])[3]).toBe('admin-0000');
    const expires = new Date(body.data.expires_at).getTime();
    expect(expires).toBeGreaterThanOrEqual(before + 24 * 60 * 60_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60_000 + 5_000);
  });

  it('исходник: суточный срок, выдавший записан', () => {
    const src = read(RESET_LINK);
    expect(src).toMatch(/ADMIN_ISSUED_TTL_MS/);
    expect(src).toMatch(/issuedBy: auth\.userId/);
  });
});

/* ─── 8. список админки видит карточку без аккаунта ──────────────────────── */

describe('список операторов в админке', () => {
  it('LEFT JOIN users с has_account и external_source; карточка без пользователя не прячется', () => {
    const src = read(ADMIN_LIST);
    expect(src).toMatch(/LEFT JOIN users u ON u\.id = p\.user_id/);
    expect(src).not.toMatch(/\n\s+JOIN users u/);
    expect(src).toMatch(/\(u\.id IS NOT NULL\)\s+AS has_account/);
    expect(src).toMatch(/p\.external_source,/);
  });

  it('панель: кнопка по has_account из списка родителя, только своим операторам, пароль под маской, статус none', () => {
    const ui = read(ADMIN_UI);
    expect(ui).toMatch(/has_account: boolean/);
    expect(ui).toMatch(/external_source: string \| null/);
    expect(ui).toMatch(/email: string \| null/);
    expect(ui).toMatch(/type ProfileStatus = 'none' \| 'pending' \| 'approved' \| 'rejected'/);
    expect(ui).toMatch(/none:\s+'Без заявки'/);
    expect(ui).toMatch(/function AccountPanel/);
    expect(ui).toMatch(/const hasAccount = op\.has_account;/);
    expect(ui).not.toMatch(/useState\(op\.has_account\)/);
    expect(ui).toMatch(/\{!hasAccount \? \(\s*creatable\.ok \? \(/);
    expect(ui).toMatch(/op\.category !== 'operator'/);
    expect(ui).toMatch(/op\.external_source !== 'admin'/);
    expect(ui).toMatch(/onAccountCreated\(op\.id, json\.data\.email/);
    expect(ui).toMatch(/has_account: true, email/);
    expect(ui).toMatch(/<Sensitive>\{state\.password\}<\/Sensitive>/);
    expect(ui).toMatch(/\/api\/admin\/operators\/\$\{op\.id\}\/\$\{path\}/);
    expect(ui).toMatch(/'account' \| 'reset-link'/);
    expect(ui).toMatch(/<AccountPanel op=\{op\} onAccountCreated=\{onAccountCreated\} \/>/);
  });
});
