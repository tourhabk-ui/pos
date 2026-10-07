/**
 * Сброс пароля и аккаунт партнёра из админки (07.10).
 *
 * Повод: оператора «Край Вулканов» платформа заводит сама (карточка 1174 без
 * пользователя); ему нужен вход с временным паролем и путь «забыл пароль»,
 * которого на платформе не было вовсе — шаблон письма passwordResetEmail
 * лежал в email-templates.ts без единого вызова (§10.09).
 *
 * Сторож держит связку целиком: таблица → библиотека (хеш, одноразовость,
 * срок) → два публичных роута (нейтральный ответ, честное 503 без SMTP,
 * лимиты) → страницы и ссылка со входа → админские роуты (одна транзакция,
 * пароль один раз, без согласия за человека) → список админки видит карточку
 * без аккаунта.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';

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

const post = (url: string, body: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 250)}` },
  });

const sql = (calls: Array<[string, unknown[] | undefined]>) => calls.map(([s]) => s.replace(/\s+/g, ' ').trim());

beforeEach(() => {
  poolQuery.mockReset();
  clientQuery.mockReset();
  clientRelease.mockReset();
  sendEmail.mockReset();
  clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
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

  it('выдача пишет ХЕШ, отзывает прежние, сырой токен только в ссылке', async () => {
    const { issuePasswordResetToken, hashResetToken } = await import('@/lib/auth/password-reset');
    const exec = { query: vi.fn<Q>().mockResolvedValue({ rows: [], rowCount: 0 }) };
    const issued = await issuePasswordResetToken({ userId: 'u-1', issuedBy: 'admin-1' }, exec);
    const calls = exec.query.mock.calls as Array<[string, unknown[] | undefined]>;
    expect(sql(calls)[0]).toMatch(/DELETE FROM password_reset_tokens WHERE user_id = \$1::uuid AND used_at IS NULL/);
    expect(sql(calls)[1]).toMatch(/INSERT INTO password_reset_tokens \(user_id, token_hash, expires_at, issued_by\)/);
    const params = calls[1][1] as unknown[];
    expect(params[1]).toBe(hashResetToken(issued.token));
    expect(params).not.toContain(issued.token);
    expect(params[3]).toBe('admin-1');
    expect(issued.link).toContain(issued.token);
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now() + 55 * 60_000);
  });

  it('погашение: нет строки → invalid, used_at → used, срок → expired; всё с ROLLBACK и release', async () => {
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
      const seen = sql(clientQuery.mock.calls as Array<[string, unknown[] | undefined]>);
      expect(seen[0]).toBe('BEGIN');
      expect(seen.at(-1)).toBe('ROLLBACK');
      expect(seen.some((s) => /UPDATE users/.test(s))).toBe(false);
      expect(clientRelease).toHaveBeenCalledTimes(1);
    }
  });

  it('погашение: живой токен → пароль сменён, флаг снят, токен погашен предикатом в SQL, COMMIT', async () => {
    const { consumePasswordResetToken, hashResetToken } = await import('@/lib/auth/password-reset');
    clientQuery.mockImplementation(async (s) => {
      if (/FOR UPDATE/.test(s)) return { rows: [{ id: '7', user_id: 'u-7', expired: false, used: false }], rowCount: 1 };
      if (/UPDATE password_reset_tokens/.test(s)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const r = await consumePasswordResetToken('tok-tok-tok-tok-tok-tok', 'NovyParol2026');
    expect(r).toEqual({ ok: true, userId: 'u-7' });
    const calls = clientQuery.mock.calls as Array<[string, unknown[] | undefined]>;
    const seen = sql(calls);
    expect(calls[1][1]).toEqual([hashResetToken('tok-tok-tok-tok-tok-tok')]);
    const stamp = seen.find((s) => /UPDATE password_reset_tokens/.test(s))!;
    expect(stamp).toMatch(/SET used_at = NOW\(\) WHERE id = \$1 AND used_at IS NULL AND expires_at > NOW\(\)/);
    const users = seen.find((s) => /UPDATE users/.test(s))!;
    expect(users).toMatch(/password_hash = \$1/);
    expect(users).toMatch(/- 'force_password_change'/);
    expect(calls.find(([s]) => /UPDATE users/.test(s))![1]).toEqual(['hashed:NovyParol2026', 'u-7']);
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
    expect(sql(clientQuery.mock.calls as Array<[string, unknown[] | undefined]>).some((s) => /UPDATE users/.test(s))).toBe(false);
  });

  it('транзакция на одном соединении (pool.connect), не на pool.query', () => {
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

  it('неизвестный адрес — 200 с нейтральным текстом, без выдачи и письма', async () => {
    process.env.SMTP_USER = 'u'; process.env.SMTP_PASS = 'p';
    poolQuery.mockResolvedValue({ rows: [] });
    const { POST, NEUTRAL_TEXT } = await import('@/app/api/auth/forgot-password/route');
    const res = await POST(post('/api/auth/forgot-password', { email: 'nobody@example.test' }));
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe(NEUTRAL_TEXT);
    expect(sql(poolQuery.mock.calls as Array<[string, unknown[] | undefined]>)).toEqual([
      expect.stringMatching(/SELECT id, name FROM users WHERE email = \$1 AND is_active IS DISTINCT FROM FALSE/),
    ]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('известный адрес — тот же текст, письмо со ссылкой на сырой токен, в базе хеш', async () => {
    process.env.SMTP_USER = 'u'; process.env.SMTP_PASS = 'p';
    poolQuery.mockImplementation(async (s) => (/FROM users/.test(s) ? { rows: [{ id: 'u-9', name: 'Эдуард <b>' }] } : { rows: [], rowCount: 0 }));
    sendEmail.mockResolvedValue({ success: true });
    const { POST, NEUTRAL_TEXT } = await import('@/app/api/auth/forgot-password/route');
    const res = await POST(post('/api/auth/forgot-password', { email: 'Known@Example.test' }));
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe(NEUTRAL_TEXT);
    const insert = (poolQuery.mock.calls as Array<[string, unknown[] | undefined]>).find(([s]) => /INSERT INTO password_reset_tokens/.test(s))!;
    const storedHash = (insert[1] as unknown[])[1] as string;
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toBe('known@example.test');
    const m = /token=([A-Za-z0-9_-]+)/.exec(mail.html)!;
    expect(m).not.toBeNull();
    expect(createHash('sha256').update(m[1]).digest('hex')).toBe(storedHash);
    expect(mail.html).not.toContain(storedHash);
    expect(mail.html).toContain('Эдуард &lt;b&gt;');
    expect(mail.subject).toContain('Ведар');
    expect(mail.html).not.toContain('KamHub');
  });

  it('письмо не ушло — 503, а не «отправлено»', async () => {
    process.env.SMTP_USER = 'u'; process.env.SMTP_PASS = 'p';
    poolQuery.mockImplementation(async (s) => (/FROM users/.test(s) ? { rows: [{ id: 'u-9', name: 'Н' }] } : { rows: [], rowCount: 0 }));
    sendEmail.mockResolvedValue({ success: false, error: 'ECONNREFUSED' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { POST } = await import('@/app/api/auth/forgot-password/route');
    const res = await POST(post('/api/auth/forgot-password', { email: 'known@example.test' }));
    expect(res.status).toBe(503);
    expect((await res.json()).success).toBe(false);
    expect(errSpy.mock.calls.flat().join(' ')).not.toContain('known@example.test');
    errSpy.mockRestore();
  });

  it('исходник: два лимита, адрес не попадает в лог, свой шаблон Ведара', () => {
    const src = read(FORGOT);
    expect(src.match(/createRateLimiter\(/g)?.length).toBe(2);
    expect(src).not.toMatch(/console\.(log|error|warn)\([^)]*\bemail\b/);
    expect(src).toMatch(/passwordResetEmailVedar/);
    expect(src).not.toMatch(/email-templates/);
    expect(src.indexOf('mailConfigured()')).toBeLessThan(src.indexOf('FROM users'));
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

  it('исходник: правило пароля общее, сессия не выдаётся, лимит есть', () => {
    const src = read(RESET);
    expect(src).toMatch(/passwordSchema/);
    expect(src).toMatch(/createRateLimiter\(/);
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
  const card = (user_id: string | null, card_email: string | null) =>
    ({ id: ID, name: 'Край Вулканов', category: 'operator', user_id, card_email });

  it('карточка без аккаунта: пользователь + привязка одной транзакцией, пароль один раз', async () => {
    clientQuery.mockImplementation(async (s) => {
      if (/FROM partners/.test(s)) return { rows: [card(null, 'mail@volcanoesland.ru')], rowCount: 1 };
      if (/SELECT id FROM users/.test(s)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO users/.test(s)) return { rows: [{ id: 'u-new' }], rowCount: 1 };
      if (/UPDATE partners/.test(s)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const { POST } = await import('@/app/api/admin/operators/[id]/account/route');
    const res = await POST(post(`/api/admin/operators/${ID}/account`, {}), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.email).toBe('mail@volcanoesland.ru');
    expect(body.data.oneTimePassword).toMatch(/^[A-HJ-NP-Za-km-z2-9]{14}$/);

    const calls = clientQuery.mock.calls as Array<[string, unknown[] | undefined]>;
    const seen = sql(calls);
    expect(seen[0]).toBe('BEGIN');
    expect(seen.at(-1)).toBe('COMMIT');
    const ins = calls.find(([s]) => /INSERT INTO users/.test(s))!;
    const p = ins[1] as unknown[];
    expect(p[0]).toBe('mail@volcanoesland.ru');
    expect(p[1]).toBe(`hashed:${body.data.oneTimePassword}`);
    expect(p[3]).toBe('operator');
    expect(JSON.parse(p[4] as string)).toEqual({ roles: ['operator'], force_password_change: true });
    expect(ins[0]).not.toMatch(/pd_consent/);
    const upd = seen.find((s) => /UPDATE partners/.test(s))!;
    expect(upd).toMatch(/SET user_id = \$1::uuid/);
    expect(upd).toMatch(/AND user_id IS NULL/);
    expect(calls.find(([s]) => /UPDATE partners/.test(s))![1]).toEqual(['u-new', ID]);
    expect(clientRelease).toHaveBeenCalledTimes(1);
  });

  it('аккаунт уже есть — 409 и ROLLBACK; чужой email занят — 409; нет email — 400', async () => {
    const { POST } = await import('@/app/api/admin/operators/[id]/account/route');

    clientQuery.mockImplementation(async (s) => (/FROM partners/.test(s) ? { rows: [card('u-old', 'x@y.z')], rowCount: 1 } : { rows: [], rowCount: 0 }));
    let res = await POST(post(`/api/admin/operators/${ID}/account`, {}), params);
    expect(res.status).toBe(409);
    expect(sql(clientQuery.mock.calls as Array<[string, unknown[] | undefined]>)).not.toContain('COMMIT');

    clientQuery.mockReset();
    clientQuery.mockImplementation(async (s) => {
      if (/FROM partners/.test(s)) return { rows: [card(null, 'x@y.z')], rowCount: 1 };
      if (/SELECT id FROM users/.test(s)) return { rows: [{ id: 'someone' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    res = await POST(post(`/api/admin/operators/${ID}/account`, {}), params);
    expect(res.status).toBe(409);
    expect(sql(clientQuery.mock.calls as Array<[string, unknown[] | undefined]>).some((s) => /INSERT INTO users/.test(s))).toBe(false);

    clientQuery.mockReset();
    clientQuery.mockImplementation(async (s) => (/FROM partners/.test(s) ? { rows: [card(null, null)], rowCount: 1 } : { rows: [], rowCount: 0 }));
    res = await POST(post(`/api/admin/operators/${ID}/account`, {}), params);
    expect(res.status).toBe(400);
  });

  it('исходник: requireAdmin, общий генератор пароля, пароль не в логе, согласие не пишется', () => {
    const src = read(ACCOUNT);
    expect(src).toMatch(/requireAdmin\(request\)/);
    expect(src).toMatch(/import \{ generatePassword \} from '@\/app\/api\/admin\/operators\/create\/route'/);
    expect(src).toMatch(/force_password_change: true/);
    expect(src).not.toMatch(/pd_consent/);
    expect(src).not.toMatch(/console\.(log|error|warn)\([^)]*oneTimePassword/);
    expect(src).not.toMatch(/sendEmail/);
  });
});

/* ─── 7. ссылка сброса из админки ────────────────────────────────────────── */

describe('POST /api/admin/operators/[id]/reset-link', () => {
  const ID = '41e2c8f8-2d29-41b8-87a7-46ffd78b65d5';
  const params = { params: Promise.resolve({ id: ID }) };

  it('без аккаунта — 409; с аккаунтом — ссылка на сутки с issued_by администратора', async () => {
    const { POST } = await import('@/app/api/admin/operators/[id]/reset-link/route');
    poolQuery.mockResolvedValue({ rows: [{ name: 'Край Вулканов', user_id: null }] });
    let res = await POST(post(`/api/admin/operators/${ID}/reset-link`, {}), params);
    expect(res.status).toBe(409);

    poolQuery.mockReset();
    poolQuery.mockImplementation(async (s) => (/FROM partners/.test(s) ? { rows: [{ name: 'Край Вулканов', user_id: 'u-7' }] } : { rows: [], rowCount: 0 }));
    res = await POST(post(`/api/admin/operators/${ID}/reset-link`, {}), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.link).toMatch(/\/auth\/reset-password\?token=/);
    expect(body.data.message).toContain(body.data.link);
    expect(body.data.message).not.toMatch(/@|\+7/);
    const ins = (poolQuery.mock.calls as Array<[string, unknown[] | undefined]>).find(([s]) => /INSERT INTO password_reset_tokens/.test(s))!;
    expect((ins[1] as unknown[])[0]).toBe('u-7');
    expect((ins[1] as unknown[])[3]).toBe('admin-0000');
    const expires = new Date(body.data.expires_at).getTime();
    expect(expires).toBeGreaterThan(Date.now() + 23 * 60 * 60_000);
  });

  it('исходник: requireAdmin и суточный срок', () => {
    const src = read(RESET_LINK);
    expect(src).toMatch(/requireAdmin\(request\)/);
    expect(src).toMatch(/ADMIN_ISSUED_TTL_MS/);
    expect(src).toMatch(/issuedBy: auth\.userId/);
  });
});

/* ─── 8. список админки видит карточку без аккаунта ──────────────────────── */

describe('список операторов в админке', () => {
  it('LEFT JOIN users с признаком has_account; карточка без пользователя не прячется', () => {
    const src = read(ADMIN_LIST);
    expect(src).toMatch(/LEFT JOIN users u ON u\.id = p\.user_id/);
    expect(src).not.toMatch(/\n\s+JOIN users u/);
    expect(src).toMatch(/\(u\.id IS NOT NULL\)\s+AS has_account/);
    const ui = read(ADMIN_UI);
    expect(ui).toMatch(/has_account: boolean/);
    expect(ui).toMatch(/email: string \| null/);
    expect(ui).toMatch(/function AccountPanel/);
    expect(ui).toMatch(/\/api\/admin\/operators\/\$\{op\.id\}\/\$\{path\}/);
    expect(ui).toMatch(/'account' \| 'reset-link'/);
    expect(ui).toMatch(/<AccountPanel op=\{op\} \/>/);
  });
});
