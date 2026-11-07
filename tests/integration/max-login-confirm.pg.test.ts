/**
 * Вход через MAX — только по «Да, это я» того, кто нажал «Старт» (аудит 22.10).
 *
 * Ссылку входа создаёт любой: POST /api/auth/max/start отдаёт nonce и
 * deep-link в бота. До аудита «Старт» по ссылке сразу подтверждал вход.
 * Злоумышленник начинал вход у себя, присылал ссылку жертве («посмотри бота»),
 * жертва жала «Старт» — и браузер злоумышленника, опрашивающий статус,
 * получал JWT аккаунта жертвы.
 *
 * Здесь весь путь исполняется против базы со схемой прода: настоящая сессия,
 * настоящий обработчик бота, настоящий опрос статуса с выдачей JWT. Подменены
 * только API MAX (что бот отправил) и сверка секрета вебхука (её держит
 * lib/max/webhook-url.ts, зона §7, и свой сторож).
 *
 *   «Старт»               → вопрос с кнопками, сайт видит «pending», входа нет;
 *   «Да» другого человека → сессия не подтверждена;
 *   «Нет» владельца       → сессия гаснет, сайт видит «expired»;
 *   «Да» владельца        → вход, JWT выдаётся ровно один раз;
 *   незаверенный источник → «Старт» сессию даже не закрепляет.
 *
 * Без KERNEL_PG_TEST_URL файл честно пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from '../helpers/pg-schema';

const { sent } = vi.hoisted(() => ({
  sent: [] as Array<{ chatId: number; text: string; opts: unknown }>,
}));

vi.mock('@/lib/max/max-fetch', () => ({
  maxBot: () => ({
    api: {
      sendMessageToChat: async (chatId: number, text: string, opts: unknown) => {
        sent.push({ chatId, text, opts });
        return {};
      },
      answerOnCallback: async () => ({}),
    },
  }),
}));

vi.mock('@/lib/max/webhook-url', async (orig) => ({
  ...(await orig<typeof import('@/lib/max/webhook-url')>()),
  isVerifiedMaxWebhook: (url: string) => new URL(url).searchParams.get('verified') === '1',
}));

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[max-login-confirm.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'max_login_confirm_test';
const VICTIM = 710_001;
const STRANGER = 710_002;

interface ButtonRow { type: string; text: string; payload: string }

/** Апдейт в вебхук бота, как его шлёт MAX. */
async function bot(update: Record<string, unknown>, verified = true) {
  const { POST } = await import('@/app/api/max/kuzmich/route');
  const url = `https://vedarai.ru/api/max/kuzmich${verified ? '?verified=1' : ''}`;
  const res = await POST(new NextRequest(url, { method: 'POST', body: JSON.stringify(update) }));
  expect(res.status).toBe(200);
}

const start = (nonce: string, userId: number) => bot({
  update_type: 'bot_started', timestamp: Date.now(), chat_id: userId,
  user: { user_id: userId, name: 'Анна' }, payload: `login-${nonce}`,
});

const press = (payload: string, userId: number) => bot({
  update_type: 'message_callback', timestamp: Date.now(),
  callback: { timestamp: Date.now(), callback_id: `cb-${userId}-${payload.length}`, payload, user: { user_id: userId, name: 'X' } },
  message: { recipient: { chat_id: userId, chat_type: 'dialog' }, body: { mid: 'm', seq: 1, text: null } },
});

/** Опрос статуса — то, что делает браузер, начавший вход. */
async function status(nonce: string): Promise<{ status: string; data?: { token?: string } }> {
  const { GET } = await import('@/app/api/auth/max/status/route');
  const res = await GET(new NextRequest(`https://vedarai.ru/api/auth/max/status?nonce=${encodeURIComponent(nonce)}`));
  return (await res.json()) as { status: string; data?: { token?: string } };
}

async function newSession(): Promise<string> {
  const { createMaxLoginSession } = await import('@/lib/auth/max-login');
  return (await createMaxLoginSession()).nonce;
}

/** Кнопки последнего сообщения бота. */
function lastButtons(): ButtonRow[] {
  const last = sent[sent.length - 1];
  const opts = last?.opts as { attachments?: Array<{ payload?: { buttons?: ButtonRow[][] } }> } | undefined;
  return (opts?.attachments?.[0]?.payload?.buttons ?? []).flat();
}

withPg('вход через MAX подтверждается вопросом в боте (22.10)', () => {
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';
    process.env.MAX_BOT_TOKEN = 'test-max-token';
    process.env.JWT_SECRET = 'test-jwt-secret-for-max-login-confirm-0123456789';
  }, 300_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    const { pool: appPool } = await import('@/lib/db-pool');
    await (appPool as unknown as { end?: () => Promise<void> }).end?.();
  });

  beforeEach(() => {
    sent.length = 0;
  });

  // Ответ словами (05.11): гид набрал «Да, это я» вместо кнопки, и вход не
  // прошёл — фраза ушла помощнику партнёра. Право то же, что у кнопки:
  // пользователь MAX, за которым сессия закреплена «Стартом».
  describe('ответ на вопрос о входе словами', () => {
    let mid = 0;
    const typed = (text: string, userId: number) => bot({
      update_type: 'message_created', timestamp: Date.now(),
      message: {
        recipient: { chat_id: userId, chat_type: 'dialog' },
        sender: { user_id: userId, name: 'Андрей' },
        body: { mid: `typed-login-${userId}-${++mid}`, seq: mid, text },
      },
    });

    it('«Да, это я» текстом тем же человеком — вход подтверждён', async () => {
      const U = 711_001;
      const nonce = await newSession();
      await start(nonce, U);
      sent.length = 0;
      await typed('Да, это я', U);
      expect(sent.map((m) => m.text)).toEqual(['Вход подтверждён. Вернитесь на сайт — вы уже авторизованы.']);
      expect((await status(nonce)).status).toBe('authenticated');
    });

    it('чужой «Да, это я» — не подтверждает; сказано, что входа не ждут', async () => {
      const nonce = await newSession();
      await start(nonce, 711_002);
      sent.length = 0;
      await typed('да это я!', 711_003);
      expect(sent[0].text).toMatch(/Сейчас вход на сайт не ждёт подтверждения/);
      expect((await status(nonce)).status).toBe('pending');
    });

    it('две живые сессии — словами не угадываем, обе ждут кнопки', async () => {
      const U = 711_004;
      const a = await newSession();
      const b = await newSession();
      await start(a, U);
      await start(b, U);
      sent.length = 0;
      await typed('Да, это я', U);
      expect(sent[0].text).toMatch(/Вопросов о входе сейчас несколько/);
      expect((await status(a)).status).toBe('pending');
      expect((await status(b)).status).toBe('pending');
    });

    it('«Нет, не я» текстом — вход отменён', async () => {
      const U = 711_005;
      const nonce = await newSession();
      await start(nonce, U);
      sent.length = 0;
      await typed('Нет, не я', U);
      expect(sent[0].text).toMatch(/^Вход отменён/);
      expect((await status(nonce)).status).not.toBe('authenticated');
    });
  });

  it('«Старт» по ссылке — вопрос с кнопками «Да» и «Нет», сайт входа не получает', async () => {
    const nonce = await newSession();
    await start(nonce, VICTIM);

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('Нажмите «Да, это я», только если вы сами');
    const buttons = lastButtons();
    expect(buttons.map((b) => b.text)).toEqual(['Да, это я', 'Нет, не я']);
    expect(buttons.every((b) => b.payload.endsWith(nonce))).toBe(true);
    expect((await status(nonce)).status).toBe('pending');
  });

  it('«Да» другого пользователя MAX вход не подтверждает', async () => {
    const nonce = await newSession();
    await start(nonce, VICTIM);
    const yes = lastButtons().find((b) => b.text === 'Да, это я')!;

    await press(yes.payload, STRANGER);
    expect(sent[sent.length - 1].text).toContain('устарела или уже использована');
    expect((await status(nonce)).status).toBe('pending');
  });

  it('«Старт» второго человека чужую сессию не перехватывает', async () => {
    const nonce = await newSession();
    await start(nonce, VICTIM);
    sent.length = 0;
    await start(nonce, STRANGER);
    expect(sent[0].text).toContain('устарела или уже использована');
    expect(lastButtons()).toEqual([]);
  });

  it('«Нет» владельца гасит вход: браузер, начавший его, получает «истекла»', async () => {
    const nonce = await newSession();
    await start(nonce, VICTIM);
    const no = lastButtons().find((b) => b.text === 'Нет, не я')!;

    await press(no.payload, VICTIM);
    expect(sent[sent.length - 1].text).toContain('Вход отменён');
    expect((await status(nonce)).status).toBe('expired');

    // И позднее «Да» уже ничего не открывает.
    const yes = `${no.payload.replace('maxlogin_no:', 'maxlogin_ok:')}`;
    await press(yes, VICTIM);
    expect((await status(nonce)).status).toBe('expired');
  });

  it('«Да» владельца — вход, и JWT выдаётся ровно один раз', async () => {
    const nonce = await newSession();
    await start(nonce, VICTIM);
    const yes = lastButtons().find((b) => b.text === 'Да, это я')!;

    await press(yes.payload, VICTIM);
    expect(sent[sent.length - 1].text).toContain('Вход подтверждён');

    const first = await status(nonce);
    expect(first.status).toBe('authenticated');
    expect(typeof first.data?.token).toBe('string');
    expect((await status(nonce)).status).toBe('expired');

    const { rows } = await pool.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM users WHERE max_user_id = $1', [VICTIM],
    );
    expect(rows[0].n).toBe('1');
  });

  it('незаверенный источник: «Старт» сессию не закрепляет, кнопок входа нет', async () => {
    const nonce = await newSession();
    await bot({
      update_type: 'bot_started', timestamp: Date.now(), chat_id: VICTIM,
      user: { user_id: VICTIM, name: 'Анна' }, payload: `login-${nonce}`,
    }, false);
    // Обычное приветствие с темами бот шлёт и так; кнопок входа в нём нет.
    expect(lastButtons().filter((b) => b.payload?.startsWith('maxlogin_'))).toEqual([]);
    const { rows } = await pool.query<{ max_user_id: string | null }>(
      'SELECT max_user_id::text FROM max_login_sessions WHERE nonce = $1', [nonce],
    );
    expect(rows[0].max_user_id).toBeNull();
  });

  // ── Администратор в MAX (слово владельца 23.10, «1а») ─────────────────────
  //
  // Ссылку выдаёт себе сам администратор (POST /api/admin/max-link), «Старт»
  // по ней привязывает человека MAX; права перечитываются на каждом
  // сообщении. Всё — против схемы прода: настоящая выдача, погашение,
  // привязка, ответы с ПД через sendPdAlert в его же MAX.
  describe('администратор в MAX — одноразовая ссылка из админки (23.10)', () => {
    const ADMIN_MAX = 720_001;
    const OTHER_MAX = 720_002;
    let adminId = '';
    let adminToken = '';

    async function issueLink(): Promise<{ status: number; link?: string }> {
      const { POST } = await import('@/app/api/admin/max-link/route');
      const res = await POST(new NextRequest('https://vedarai.ru/api/admin/max-link', {
        method: 'POST', headers: { authorization: `Bearer ${adminToken}` },
      }));
      const body = (await res.json()) as { data?: { link?: string } };
      expect(res.headers.get('cache-control')).toBe('no-store');
      return { status: res.status, link: body.data?.link };
    }

    const startArg = (link: string): string => new URL(link).searchParams.get('start') ?? '';

    const startWith = (payload: string, userId: number, verified = true) => bot({
      update_type: 'bot_started', timestamp: Date.now(), chat_id: userId + 5,
      user: { user_id: userId, name: 'Админ' }, payload,
    }, verified);

    const say = (text: string, userId: number) => bot({
      update_type: 'message_created', timestamp: Date.now(),
      message: {
        sender: { user_id: userId, name: 'Админ' },
        recipient: { chat_id: userId + 5, chat_type: 'dialog' },
        body: { mid: `m-${text.length}`, seq: 1, text },
      },
    });

    async function binding(): Promise<{ max_user_id: string } | undefined> {
      const { rows } = await pool.query<{ max_user_id: string }>(
        'SELECT max_user_id::text FROM admin_max_bindings WHERE user_id = $1', [adminId],
      );
      return rows[0];
    }

    const setAdmin = (on: boolean) => pool.query(
      `UPDATE users SET role = $2,
              preferences = jsonb_build_object('roles', CASE WHEN $3 THEN '["tourist","admin"]'::jsonb ELSE '["tourist"]'::jsonb END)
        WHERE id = $1`,
      [adminId, on ? 'admin' : 'tourist', on],
    );

    beforeAll(async () => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO users (email, name, password_hash, role, preferences)
         VALUES ('max-admin@test.invalid', 'Админ Тест', 'x', 'admin', '{"roles":["tourist","admin"]}')
         RETURNING id::text AS id`,
      );
      adminId = rows[0].id;
      const { createToken } = await import('@/lib/auth/jwt');
      adminToken = await createToken({ userId: adminId, email: 'max-admin@test.invalid', role: 'admin' });
    });

    beforeEach(async () => {
      await setAdmin(true);
      // Снятие роли отзывает сессии — каждая проверка начинает с живой.
      await pool.query('DELETE FROM user_sessions WHERE user_id = $1', [adminId]);
      await pool.query(
        `INSERT INTO user_sessions (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
        [adminId, adminToken],
      );
      await pool.query('DELETE FROM admin_max_bindings');
      await pool.query('DELETE FROM admin_max_link_tokens');
      await pool.query('DELETE FROM admin_tg_bindings');
      await pool.query('DELETE FROM admin_tg_link_tokens');
    });

    it('ссылка → «Старт» → привязан человек MAX, чат знает администратора; ключ в базе — только хеш', async () => {
      const issued = await issueLink();
      expect(issued.status).toBe(200);
      const arg = startArg(issued.link!);
      expect(arg).toMatch(/^adm_[A-Za-z0-9_-]{32}$/);
      const { rows: stored } = await pool.query<{ token_hash: string }>('SELECT token_hash FROM admin_max_link_tokens');
      expect(stored).toHaveLength(1);
      expect(stored[0].token_hash).not.toContain(arg.slice(4));

      await startWith(arg, ADMIN_MAX);
      expect(sent[sent.length - 1].text).toContain('подключён к Ведару как администратор');
      expect(await binding()).toEqual({ max_user_id: String(ADMIN_MAX) });
      // Состояние для админки — ISO 8601: текстовую форму PostgreSQL Safari не разбирает.
      const { adminMaxStatus } = await import('@/lib/max/admin-link');
      const status = await adminMaxStatus(adminId);
      expect(status.bound).toBe(true);
      expect(status.boundAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      sent.length = 0;
      await startWith('', ADMIN_MAX);
      expect(sent[0].text).toContain('Вы подключены как администратор Ведара, Админ Тест');
      expect(sent[0].text).not.toContain('Я Кузьмич');
    });

    it('«заявки» с контактами туриста уходят только в личный MAX администратора, не в рабочий чат', async () => {
      await pool.query(
        `INSERT INTO leads (name, phone, route_title, status, created_at)
         VALUES ('Турист Проверочный', '+70000000001', 'Вулкан Горелый', 'new', NOW() - INTERVAL '3 hours')`,
      );
      await startWith(startArg((await issueLink()).link!), ADMIN_MAX);
      sent.length = 0;
      await say('заявки', ADMIN_MAX);
      // Список с ПД, следом — кнопки «Заявка N» без ПД (фаза 2, 07.11).
      expect(sent).toHaveLength(2);
      expect(sent.map((m) => m.chatId)).toEqual([ADMIN_MAX + 5, ADMIN_MAX + 5]);
      expect(sent[0].text).toContain('Заявки без ответа человека: 1');
      expect(sent[0].text).toContain('1. Турист Проверочный, +70000000001');
      expect(sent[0].text).toContain('больше двух часов');
      expect(sent[1].text).not.toMatch(/Проверочный|70000000001/);
      expect(lastButtons().map((b) => b.text)).toContain('Заявка 1');
      await pool.query(`DELETE FROM leads WHERE phone = '+70000000001'`);
    });

    it('чтение против схемы прода: ни одна команда не отвечает «не прочиталось»', async () => {
      await pool.query(
        `INSERT INTO agent_run_history (agent_id, status, ended_at, metadata)
         VALUES ('watchdog', 'success', NOW() - INTERVAL '10 minutes', '{"alerts":[{"type":"lead_stale"},{"type":"lead_stale"}]}')`,
      );
      const { adminReplyFor } = await import('@/lib/max/admin-read');
      for (const cmd of ['dates', 'bookings', 'leads', 'summary', 'health'] as const) {
        const reply = await adminReplyFor(cmd);
        expect(reply.text, cmd).not.toMatch(/не прочитал|не собрал|не загрузилось/);
      }
      const health = await adminReplyFor('health');
      expect(health.text).toContain('10 мин назад');
      expect(health.text).toContain('тревог: 2 (lead_stale)');
    });

    it('ссылка одна: второе нажатие — «уже использована», привязка не переходит к нажавшему', async () => {
      const arg = startArg((await issueLink()).link!);
      await startWith(arg, ADMIN_MAX);
      await startWith(arg, OTHER_MAX);
      expect(sent[sent.length - 1].text).toContain('уже использована');
      expect((await binding())?.max_user_id).toBe(String(ADMIN_MAX));
    });

    it('тот же человек нажал свою ссылку ещё раз — «уже подключён», без «подключали не вы»', async () => {
      const arg = startArg((await issueLink()).link!);
      await startWith(arg, ADMIN_MAX);
      await startWith(arg, ADMIN_MAX);
      const last = sent[sent.length - 1].text;
      expect(last).toContain('Этот MAX уже подключён');
      expect(last).not.toContain('подключали не вы');
    });

    it('«Отключить» снимает привязку и гасит выданную, но не нажатую ссылку', async () => {
      await startWith(startArg((await issueLink()).link!), ADMIN_MAX);
      const pending = startArg((await issueLink()).link!);
      const { DELETE } = await import('@/app/api/admin/max-link/route');
      const res = await DELETE(new NextRequest('https://vedarai.ru/api/admin/max-link', {
        method: 'DELETE', headers: { authorization: `Bearer ${adminToken}` },
      }));
      expect(await res.json()).toEqual({ success: true, data: { unbound: true } });
      expect(await binding()).toBeUndefined();
      await startWith(pending, OTHER_MAX);
      expect(sent[sent.length - 1].text).toContain('не найдена');
      expect(await binding()).toBeUndefined();
    });

    it('снятие роли в админке отключает MAX и гасит выданные ссылки; вернут роль — подключать заново', async () => {
      await startWith(startArg((await issueLink()).link!), ADMIN_MAX);
      await issueLink();
      await pool.query(
        `INSERT INTO admin_tg_bindings (user_id, telegram_user_id) VALUES ($1, 880009)`,
        [adminId],
      );
      await pool.query(
        `INSERT INTO admin_tg_link_tokens (user_id, token_hash, expires_at)
         VALUES ($1, 'tg-role-off-hash', NOW() + INTERVAL '5 minutes')`,
        [adminId],
      );
      const { applyAdminRoleChange } = await import('@/lib/auth/admin-role-change');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await applyAdminRoleChange(client, adminId, 'tourist', adminId);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      expect(await binding()).toBeUndefined();
      const { rows } = await pool.query('SELECT 1 FROM admin_max_link_tokens WHERE used_at IS NULL');
      expect(rows).toHaveLength(0);
      expect((await pool.query('SELECT 1 FROM admin_tg_bindings WHERE user_id = $1', [adminId])).rows).toHaveLength(0);
      expect((await pool.query('SELECT 1 FROM admin_tg_link_tokens WHERE user_id = $1', [adminId])).rows).toHaveLength(0);
      await setAdmin(true);
      const { findMaxAdmin } = await import('@/lib/max/admin-link');
      expect(await findMaxAdmin(ADMIN_MAX)).toEqual({ outcome: 'none' });
    });

    it('новая ссылка отзывает прежнюю, непогашенную', async () => {
      const first = startArg((await issueLink()).link!);
      await issueLink();
      await startWith(first, ADMIN_MAX);
      expect(sent[sent.length - 1].text).toContain('не найдена');
      expect(await binding()).toBeUndefined();
    });

    it('просроченная ссылка — «устарела», ничего не привязано', async () => {
      const arg = startArg((await issueLink()).link!);
      await pool.query(`UPDATE admin_max_link_tokens SET expires_at = NOW() - INTERVAL '1 second'`);
      await startWith(arg, ADMIN_MAX);
      expect(sent[sent.length - 1].text).toContain('устарела');
      expect(await binding()).toBeUndefined();
    });

    it('роль снята до «Старт» — подключения нет, ссылка погашена', async () => {
      const arg = startArg((await issueLink()).link!);
      await setAdmin(false);
      await startWith(arg, ADMIN_MAX);
      expect(sent[sent.length - 1].text).toContain('больше нет роли администратора');
      expect(await binding()).toBeUndefined();
      const { rows } = await pool.query<{ used: boolean }>('SELECT used_at IS NOT NULL AS used FROM admin_max_link_tokens');
      expect(rows.map((r) => r.used)).toEqual([true]);
    });

    it('роль снята после подключения — следующий «Старт» встречает туриста, а не администратора', async () => {
      await startWith(startArg((await issueLink()).link!), ADMIN_MAX);
      await setAdmin(false);
      sent.length = 0;
      await startWith('', ADMIN_MAX);
      expect(sent[0].text).toContain('Я Кузьмич');
      expect(sent.map((x) => x.text).join('\n')).not.toContain('администратор');
      const { findMaxAdmin } = await import('@/lib/max/admin-link');
      expect(await findMaxAdmin(ADMIN_MAX)).toEqual({ outcome: 'none' });
    });

    it('снятому администратору новая ссылка не выдаётся', async () => {
      await setAdmin(false);
      const { issueAdminMaxLink } = await import('@/lib/max/admin-link');
      expect(await issueAdminMaxLink(adminId)).toEqual({ ok: false, reason: 'not_admin' });
      const { rows } = await pool.query('SELECT 1 FROM admin_max_link_tokens');
      expect(rows).toHaveLength(0);
    });

    it('незаверенный апдейт со ссылкой ничего не привязывает и говорит это', async () => {
      vi.stubEnv('MAX_WEBHOOK_SECRET', '');
      try {
        const arg = startArg((await issueLink()).link!);
        await startWith(arg, ADMIN_MAX, false);
        const { UNVERIFIED_START_REPLY } = await import('@/lib/max/verified-press');
        expect(sent[sent.length - 1].text).toBe(UNVERIFIED_START_REPLY.admin);
        expect(await binding()).toBeUndefined();
        const { rows } = await pool.query<{ used: boolean }>('SELECT used_at IS NOT NULL AS used FROM admin_max_link_tokens');
        expect(rows.map((r) => r.used)).toEqual([false]);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    // Обещание «снимут роль на сайте — снимутся и здесь» держит не только
    // applyAdminRoleChange (он стирает привязку), но и сам запрос на каждом
    // сообщении: роль могут снять и другим путём — правкой preferences.roles,
    // прямым SQL, будущим роутом, — а привязка останется. Тогда отвечать
    // перестаёт кабинет, потому что findTelegramAdmin заново читает роль.
    it('Telegram: роль снята прямым UPDATE мимо applyAdminRoleChange — привязка осталась, кабинета больше нет', async () => {
      const TG = 880_002;
      await pool.query(
        'INSERT INTO admin_tg_bindings (user_id, telegram_user_id) VALUES ($1, $2)',
        [adminId, TG],
      );
      const { findTelegramAdmin } = await import('@/lib/telegram/admin-link');
      const { handleTelegramAdminTurn, telegramAdminCallbackGate } = await import('@/lib/telegram/admin-chat');

      expect(await findTelegramAdmin(TG)).toEqual({ outcome: 'admin', userId: adminId, name: 'Админ Тест' });
      const before: string[] = [];
      const turnBefore = await handleTelegramAdminTurn({
        text: 'Что умеешь?', fromId: TG, reply: async (text) => { before.push(text); },
      });
      expect(turnBefore).toBe('handled');
      expect(before.join('\n')).toContain('Кабинет администратора');
      expect(await telegramAdminCallbackGate(TG, false)).toBe('allow');

      await setAdmin(false);
      const { rows: still } = await pool.query<{ telegram_user_id: string }>(
        'SELECT telegram_user_id::text FROM admin_tg_bindings WHERE user_id = $1', [adminId],
      );
      expect(still).toEqual([{ telegram_user_id: String(TG) }]);

      expect(await findTelegramAdmin(TG)).toEqual({ outcome: 'none' });
      const after: string[] = [];
      const turnAfter = await handleTelegramAdminTurn({
        text: 'Что умеешь?', fromId: TG, reply: async (text) => { after.push(text); },
      });
      // 'pass' — сообщение уходит обычным путём вебхука, кабинет молчит.
      expect(turnAfter).toBe('pass');
      expect(after).toEqual([]);
      expect(await telegramAdminCallbackGate(TG, false)).toBe('deny');

      // Второй путь снятия — правка preferences.roles. Администратор, который
      // переключил активную роль на туриста, ролью владеет («активная роль или
      // собственные роли», ownsAdminSql) — убрали admin из его ролей, и кабинет
      // закрылся, хотя колонку role никто не трогал.
      await pool.query(
        `UPDATE users SET role = 'tourist', preferences = jsonb_build_object('roles', '["tourist","admin"]'::jsonb) WHERE id = $1`,
        [adminId],
      );
      expect((await findTelegramAdmin(TG)).outcome).toBe('admin');
      await pool.query(
        `UPDATE users SET preferences = jsonb_build_object('roles', '["tourist"]'::jsonb) WHERE id = $1`,
        [adminId],
      );
      expect(await findTelegramAdmin(TG)).toEqual({ outcome: 'none' });
      expect(await handleTelegramAdminTurn({ text: 'Что умеешь?', fromId: TG, reply: async (text) => { after.push(text); } }))
        .toBe('pass');
      expect(after).toEqual([]);
    });

    it('Telegram: ссылка adt_ гасится, привязан человек, в базе только хеш', async () => {
      const { issueAdminTelegramLink, consumeAdminTelegramLink } = await import('@/lib/telegram/admin-link');
      const { hashAdminLinkToken } = await import('@/lib/max/admin-link');
      const issued = await issueAdminTelegramLink(adminId, 'kuzmichai_bot');
      expect(issued.ok).toBe(true);
      if (!issued.ok) return;
      const arg = new URL(issued.link).searchParams.get('start') ?? '';
      expect(arg).toMatch(/^adt_[A-Za-z0-9_-]{32}$/);
      const token = arg.slice('adt_'.length);
      const { rows: stored } = await pool.query<{ token_hash: string }>('SELECT token_hash FROM admin_tg_link_tokens');
      expect(stored).toHaveLength(1);
      expect(stored[0].token_hash).toBe(hashAdminLinkToken(token));
      expect(stored[0].token_hash).not.toContain(token);

      const consumed = await consumeAdminTelegramLink(token, 880_001);
      expect(consumed).toEqual({ ok: true, userId: adminId, movedFromUserId: null });
      const bound = await pool.query<{ telegram_user_id: string }>(
        'SELECT telegram_user_id::text FROM admin_tg_bindings WHERE user_id = $1',
        [adminId],
      );
      expect(bound.rows[0]?.telegram_user_id).toBe('880001');

      const again = await consumeAdminTelegramLink(token, 880_001);
      expect(again).toEqual({ ok: false, reason: 'already_yours' });
    });

    // ── Фаза 2 (07.11): действие с кнопкой подтверждения ──────────────────
    //
    // «Заявка N» → карточка без ПД → «Связался» → вопрос «Да / Не надо» на
    // 15 минут → «Да» исполняет то же правило, что кабинет оператора. Всё на
    // схеме прода: таблица вопросов 1400, захват строки, снятие прежнего
    // вопроса, права администратора на каждом нажатии.
    describe('действие администратора с кнопкой подтверждения (фаза 2, 07.11)', () => {
      const LEAD_PHONE = '+70000000002';
      let leadId = '';

      const pressAs = (payload: string, userId = ADMIN_MAX, chatType = 'dialog') => bot({
        update_type: 'message_callback', timestamp: Date.now(),
        callback: {
          timestamp: Date.now(), callback_id: `cb-${userId}-${payload}`, payload, user: { user_id: userId, name: 'Админ' },
        },
        message: { recipient: { chat_id: userId + 5, chat_type: chatType }, body: { mid: `m-${payload}`, seq: 1, text: null } },
      });
      const leadStatus = async () =>
        (await pool.query<{ status: string }>('SELECT status FROM leads WHERE id = $1', [leadId])).rows[0]?.status;
      const actionRows = async () => (await pool.query<{
        admin_user_id: string; chat_id: string; status: string; action: string; used: boolean; outcome: unknown;
      }>(
        `SELECT admin_user_id::text, chat_id::text, status, action, used_at IS NOT NULL AS used, outcome
           FROM admin_chat_actions ORDER BY created_at, id`,
      )).rows;
      // Свой номер сообщения: повтор того же mid бот отсекает (lib/max/update-dedup).
      let seq = 0;
      const sayFresh = (text: string) => bot({
        update_type: 'message_created', timestamp: Date.now(),
        message: {
          sender: { user_id: ADMIN_MAX, name: 'Админ' },
          recipient: { chat_id: ADMIN_MAX + 5, chat_type: 'dialog' },
          body: { mid: `m-act-${++seq}`, seq: 1, text },
        },
      });
      const yesButton = () => lastButtons().find((b) => b.payload.startsWith('ad:y:'));
      const lastText = () => sent[sent.length - 1]?.text ?? '';
      // Кнопка отметки — запись: подписана ключом бота, как её выдаёт карточка.
      const mark = async (action: 'contacted' | 'converted' | 'lost') =>
        (await import('@/lib/max/admin-actions')).adminLeadPayload(action, leadId);

      beforeEach(async () => {
        await pool.query('DELETE FROM admin_chat_actions');
        await pool.query('DELETE FROM leads WHERE phone = $1', [LEAD_PHONE]);
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO leads (name, phone, route_title, status, group_size, created_at)
           VALUES ('Тест', $1, 'Вулкан Горелый', 'new', 2, NOW() - INTERVAL '3 hours')
           RETURNING id::text AS id`,
          [LEAD_PHONE],
        );
        leadId = rows[0].id;
        await startWith(startArg((await issueLink()).link!), ADMIN_MAX);
        sent.length = 0;
      });

      afterAll(async () => {
        await pool.query('DELETE FROM admin_chat_actions');
        await pool.query('DELETE FROM leads WHERE phone = $1', [LEAD_PHONE]);
      });

      it('список → «Заявка 1» → «Связался» → «Да»: заявка отмечена, решение в журнале; ПД нет в карточке и вопросе', async () => {
        await sayFresh('заявки');
        const open = lastButtons().find((b) => b.text === 'Заявка 1');
        expect(open?.payload).toBe(`ad:o:${leadId}`);

        sent.length = 0;
        await pressAs(open!.payload);
        expect(lastText()).toContain('«Вулкан Горелый», 2 чел');
        expect(lastText()).not.toMatch(/Тест|70000000002/);
        const contacted = lastButtons().find((b) => b.text === 'Связался');
        // Отметка — запись: payload с хвостом срока и подписи.
        expect(contacted?.payload.split('~')).toHaveLength(3);
        expect(contacted?.payload.split('~')[0]).toBe(`ad:k:${leadId}`);
        expect(yesButton()).toBeUndefined();

        sent.length = 0;
        await pressAs(contacted!.payload);
        expect(lastText()).toContain('Отметить заявку «Вулкан Горелый», 2 чел');
        expect(lastText()).not.toMatch(/Тест|70000000002/);
        // До «Да» заявка не меняется.
        expect(await leadStatus()).toBe('new');
        const yes = yesButton();
        expect(yes).toBeDefined();

        sent.length = 0;
        await pressAs(yes!.payload);
        expect(lastText()).toContain('Заявка отмечена');
        expect(await leadStatus()).toBe('contacted');
        const rows = await actionRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          admin_user_id: adminId, chat_id: String(ADMIN_MAX + 5), status: 'done', action: 'contacted', used: true,
        });
        expect(rows[0].outcome).toMatchObject({ kind: 'lead_done', lead: leadId, status: 'contacted', changed: true });

        // Повтор «Да» — прежний итог, второго исполнения нет.
        sent.length = 0;
        await pressAs(yes!.payload);
        expect(lastText()).toContain('Уже нажато раньше');
        expect((await actionRows()).map((r) => r.status)).toEqual(['done']);
      });

      it('просроченный вопрос ничего не делает и новым вопросом не становится', async () => {
        await pressAs(await mark('contacted'));
        const yes = yesButton()!;
        await pool.query(`UPDATE admin_chat_actions SET expires_at = NOW() - INTERVAL '1 minute'`);
        sent.length = 0;
        await pressAs(yes.payload);
        expect(lastText()).toContain('Вопрос устарел');
        expect(await leadStatus()).toBe('new');
        expect((await actionRows()).map((r) => r.status)).toEqual(['ready']);
      });

      it('новый вопрос снимает прежний: «Да» под старым не исполняется', async () => {
        await pressAs(await mark('contacted'));
        const first = yesButton()!;
        await pressAs(await mark('lost'));
        sent.length = 0;
        await pressAs(first.payload);
        expect(lastText()).toContain('заменён');
        expect(await leadStatus()).toBe('new');
        expect((await actionRows()).map((r) => r.status)).toEqual(['superseded', 'ready']);
      });

      it('«Не надо» — заявка без изменений, «Да» после него не исполняется', async () => {
        await pressAs(await mark('converted'));
        const yes = yesButton()!;
        const no = lastButtons().find((b) => b.payload.startsWith('ad:n:'))!;
        await pressAs(no.payload);
        expect(lastText()).toContain('без изменений');
        sent.length = 0;
        await pressAs(yes.payload);
        expect(lastText()).toContain('отменено');
        expect(await leadStatus()).toBe('new');
      });

      it('снятая роль администратора гасит живой вопрос', async () => {
        await pressAs(await mark('converted'));
        const yes = yesButton()!;
        await setAdmin(false);
        sent.length = 0;
        await pressAs(yes.payload);
        expect(lastText()).toContain('у администратора Ведара');
        expect(await leadStatus()).toBe('new');
        expect((await actionRows()).map((r) => r.status)).toEqual(['ready']);
      });

      it('чужой человек MAX и группа — отказ, ничего не записано', async () => {
        await pressAs(await mark('contacted'));
        const yes = yesButton()!;
        sent.length = 0;
        await pressAs(yes.payload, OTHER_MAX);
        expect(lastText()).toContain('у администратора Ведара');
        await pressAs(yes.payload, ADMIN_MAX, 'chat');
        expect(lastText()).toContain('личном диалоге');
        await pressAs(await mark('lost'), OTHER_MAX);
        expect(await leadStatus()).toBe('new');
        expect((await actionRows()).map((r) => r.status)).toEqual(['ready']);
      });

      it('другой администратор чужой вопрос не исполняет', async () => {
        await pool.query(`DELETE FROM users WHERE email = 'max-admin-2@test.invalid'`);
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO users (email, name, password_hash, role, preferences)
           VALUES ('max-admin-2@test.invalid', 'Второй Админ', 'x', 'admin', '{"roles":["tourist","admin"]}')
           RETURNING id::text AS id`,
        );
        await pool.query('INSERT INTO admin_max_bindings (user_id, max_user_id) VALUES ($1, $2)', [rows[0].id, OTHER_MAX]);
        await pressAs(await mark('contacted'));
        const yes = yesButton()!;
        sent.length = 0;
        await pressAs(yes.payload, OTHER_MAX);
        expect(lastText()).toContain('не найден');
        expect(await leadStatus()).toBe('new');
        expect((await actionRows()).map((r) => r.status)).toEqual(['ready']);
      });

      it('кнопка без подписи или с чужой подписью отвергается до разбора: вопроса нет, заявка не тронута', async () => {
        vi.stubEnv('CALLBACK_LEGACY_UNTIL_MS', '1');
        try {
          await pressAs(await mark('contacted'));
          const yes = yesButton()!;
          const [bare] = yes.payload.split('~');
          sent.length = 0;
          // Собранное руками «Да» без хвоста.
          await pressAs(bare);
          expect(lastText()).toContain('Кнопка устарела');
          // Хвост от одной кнопки на другой: «Не надо» подписью «Да».
          await pressAs(yes.payload.replace('ad:y:', 'ad:n:'));
          expect(lastText()).toContain('не удалось проверить');
          // Отметка без подписи не заводит вопроса.
          await pressAs(`ad:l:${leadId}`);
          expect(lastText()).toContain('Кнопка устарела');
          expect(await leadStatus()).toBe('new');
          expect((await actionRows()).map((r) => `${r.action}:${r.status}`)).toEqual(['contacted:ready']);
          // Настоящая кнопка по-прежнему работает.
          await pressAs(yes.payload);
          expect(lastText()).toContain('Заявка отмечена');
          expect(await leadStatus()).toBe('contacted');
        } finally {
          vi.unstubAllEnvs();
        }
      });

      it('незаверенное нажатие не засчитано', async () => {
        await bot({
          update_type: 'message_callback', timestamp: Date.now(),
          callback: { timestamp: Date.now(), callback_id: 'cb-unverified', payload: await mark('contacted'), user: { user_id: ADMIN_MAX, name: 'Админ' } },
          message: { recipient: { chat_id: ADMIN_MAX + 5, chat_type: 'dialog' }, body: { mid: 'm-unv', seq: 1, text: null } },
        }, false);
        expect(lastText()).toContain('не засчитано');
        expect(await actionRows()).toEqual([]);
      });
    });

    // ── Фаза 2б (07.11): даты за оператора ─────────────────────────────────
    //
    // Слово владельца: оператор говорит «12.11 есть 6 мест», администратор
    // открывает дату в MAX, оператору приходит сообщение, что дату открыли
    // вы. Та же грамматика и та же запись, что у оператора; всё на схеме прода.
    describe('даты за оператора: фраза → вопрос → «Да» (фаза 2б, 07.11)', () => {
      const OP_A_MAX = 740_001;
      const partner = { a: '', b: '' };
      const tour = { gorely: '', avaA: '', avaB: '' };
      // Дни через два месяца: всегда впереди и в пределах года, один месяц на фразу.
      const GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
      const kam = new Date(Date.now() + 12 * 3_600_000);
      const y0 = kam.getUTCFullYear();
      const m0 = kam.getUTCMonth() + 2;
      const year = y0 + Math.floor(m0 / 12);
      const month = m0 % 12;
      const iso = (d: number) => `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const words = (...days: number[]) => `${days.slice(0, -1).join(', ')}${days.length > 1 ? ' и ' : ''}${days[days.length - 1]} ${GEN[month]}`;

      let seq = 0;
      const sayFresh = (text: string) => bot({
        update_type: 'message_created', timestamp: Date.now(),
        message: {
          sender: { user_id: ADMIN_MAX, name: 'Админ' },
          recipient: { chat_id: ADMIN_MAX + 5, chat_type: 'dialog' },
          body: { mid: `m-dates-${++seq}`, seq: 1, text },
        },
      });
      const pressAs = (payload: string, userId = ADMIN_MAX) => bot({
        update_type: 'message_callback', timestamp: Date.now(),
        callback: { timestamp: Date.now(), callback_id: `cbd-${++seq}`, payload, user: { user_id: userId, name: 'Админ' } },
        message: { recipient: { chat_id: userId + 5, chat_type: 'dialog' }, body: { mid: `m-press-${seq}`, seq: 1, text: null } },
      });
      const lastText = () => sent[sent.length - 1]?.text ?? '';
      const yesButton = () => lastButtons().find((b) => b.payload.startsWith('ad:y:'));
      const slots = async (tourId: string) => (await pool.query<{ date: string; slots: number; cancelled: boolean | null }>(
        `SELECT date::text AS date, available_slots AS slots, is_cancelled AS cancelled
           FROM tour_availability WHERE operator_tour_id = $1 AND deleted_at IS NULL ORDER BY date`,
        [tourId],
      )).rows;
      const datesRows = async () => (await pool.query<{
        status: string; subject_id: string | null; admin_user_id: string; params: { operator?: string } | null;
        outcome: { kind?: string; written?: number; notified?: string } | null;
      }>(
        `SELECT status, subject_id, admin_user_id::text, params, outcome
           FROM admin_chat_actions WHERE subject_kind = 'tour' ORDER BY created_at, id`,
      )).rows;

      async function addPartner(name: string, maxChatId: number | null): Promise<string> {
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO partners (name, category, contact, max_chat_id) VALUES ($1, 'operator', '{}'::jsonb, $2) RETURNING id::text AS id`,
          [name, maxChatId],
        );
        return rows[0].id;
      }
      async function addTour(operatorId: string, title: string): Promise<string> {
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO operator_tours (operator_id, title, slug, activity_type, base_price, price_unit, min_participants,
                                       max_participants, duration_hours, difficulty, is_active, is_published)
           VALUES ($1, $2, $3, 'hiking', 5000, 'per_person', 1, 10, 8, 'easy', TRUE, TRUE) RETURNING id::text AS id`,
          [operatorId, title, `adm-dates-${Math.random().toString(36).slice(2, 10)}`],
        );
        return rows[0].id;
      }

      beforeAll(async () => {
        partner.a = await addPartner('Тест Оператор А', OP_A_MAX);
        partner.b = await addPartner('Тест Оператор Б', null);
        tour.gorely = await addTour(partner.a, 'Тестовый поход на Кракатау');
        tour.avaA = await addTour(partner.a, 'Восхождение на Бромо');
        tour.avaB = await addTour(partner.b, 'Бромо и Верблюд');
      });

      beforeEach(async () => {
        await pool.query('DELETE FROM admin_chat_actions');
        await pool.query('DELETE FROM tour_availability WHERE operator_tour_id = ANY($1::bigint[])', [Object.values(tour)]);
        await startWith(startArg((await issueLink()).link!), ADMIN_MAX);
        sent.length = 0;
      });

      it('фраза → превью без записи → «Да»: даты открыты тем же правилом, журнал, оператору сообщение без ПД', async () => {
        await sayFresh(`открой ${words(10, 12)} на Кракатау, 6 мест`);
        expect(lastText()).toContain('Оператор: «Тест Оператор А»');
        expect(lastText()).toContain('Тур: «Тестовый поход на Кракатау»');
        expect(lastText()).toContain('Откроются (2)');
        expect(lastText()).toContain('Оператору придёт сообщение, что даты открыли вы');
        // До «Да» ничего не записано.
        expect(await slots(tour.gorely)).toEqual([]);
        expect((await datesRows()).map((r) => r.status)).toEqual(['ready']);
        const yes = yesButton()!;
        expect(yes.payload.split('~')).toHaveLength(3);

        sent.length = 0;
        await pressAs(yes.payload);
        expect(lastText()).toContain('Готово: даты открыты за оператора «Тест Оператор А»');
        expect(lastText()).toContain('Оператору сообщил в MAX');
        expect(await slots(tour.gorely)).toEqual([
          { date: iso(10), slots: 6, cancelled: false },
          { date: iso(12), slots: 6, cancelled: false },
        ]);
        const toOperator = sent.filter((m) => m.chatId === OP_A_MAX);
        expect(toOperator).toHaveLength(1);
        expect(toOperator[0].text).toContain('Администратор Ведара открыл даты на ваш тур «Тестовый поход на Кракатау»');
        expect(toOperator[0].text).toContain('по 6 мест');
        const [row] = await datesRows();
        expect(row).toMatchObject({ status: 'done', subject_id: tour.gorely, admin_user_id: adminId });
        expect(row.params?.operator).toBe(partner.a);
        expect(row.outcome).toMatchObject({ kind: 'done', written: 2, notified: 'max' });

        // Повтор «Да» — прежний итог, второй записи и второго сообщения оператору нет.
        sent.length = 0;
        await pressAs(yes.payload);
        expect(lastText()).toContain('Уже нажато раньше');
        expect(sent.filter((m) => m.chatId === OP_A_MAX)).toHaveLength(0);
        expect((await datesRows()).map((r) => r.status)).toEqual(['done']);
      });

      it('одно название у двух операторов — выбор кнопкой; оператор без мессенджера назван', async () => {
        await sayFresh(`открой ${words(10, 12)} на Бромо, 6 мест`);
        expect(lastText()).toContain('Бромо и Верблюд — Тест Оператор Б');
        expect(lastText()).toContain('Восхождение на Бромо — Тест Оператор А');
        expect((await datesRows()).map((r) => [r.status, r.subject_id])).toEqual([['draft', null]]);

        const lines = lastText().split('\n');
        const indexB = lines.filter((l) => /^\d+\. /.test(l)).findIndex((l) => l.includes('Тест Оператор Б'));
        const choice = lastButtons().filter((b) => b.payload.startsWith('ad:t:'))[indexB]!;
        expect(choice.payload.split('~')).toHaveLength(3);

        // Кнопка выбора без подписи — отказ до разбора, черновик не тронут.
        vi.stubEnv('CALLBACK_LEGACY_UNTIL_MS', '1');
        try {
          await pressAs(choice.payload.split('~')[0]!);
          expect(lastText()).toContain('Кнопка устарела');
        } finally {
          vi.unstubAllEnvs();
        }
        expect((await datesRows()).map((r) => r.status)).toEqual(['draft']);

        await pressAs(choice.payload);
        expect(lastText()).toContain('Оператор: «Тест Оператор Б»');
        expect(lastText()).toContain('Тур: «Бромо и Верблюд»');
        expect(await slots(tour.avaB)).toEqual([]);
        const yesB = yesButton()!;
        sent.length = 0;
        await pressAs(yesB.payload);
        expect(lastText()).toContain('за оператора «Тест Оператор Б»');
        expect(lastText()).toContain('не подключён ни MAX, ни Telegram — сообщите ему сами');
        expect((await slots(tour.avaB)).map((r) => r.date)).toEqual([iso(10), iso(12)]);
        expect(await slots(tour.avaA)).toEqual([]);
        expect((await datesRows())[0]).toMatchObject({ status: 'done', subject_id: tour.avaB, outcome: { notified: 'none' } });
      });

      it('выбор тура под снятым вопросом — прежний итог словами, без нового превью', async () => {
        await sayFresh(`открой ${words(10)} на Бромо, 6 мест`);
        const choices = lastButtons().filter((b) => b.payload.startsWith('ad:t:'));
        const no = lastButtons().find((b) => b.payload.startsWith('ad:n:'))!;
        await pressAs(no.payload);
        expect(lastText()).toContain('Хорошо, даты не открываю');
        await pool.query(
          `INSERT INTO tour_availability (operator_tour_id, date, available_slots, is_cancelled)
           VALUES ($1, $3, 5, FALSE), ($2, $3, 5, FALSE)`,
          [tour.avaA, tour.avaB, iso(10)],
        );
        await pressAs(choices[0]!.payload);
        expect(lastText()).toContain('отменено');
        expect(lastText()).not.toContain('Открывать нечего');
        expect((await datesRows()).map((r) => r.status)).toEqual(['cancelled']);
      });

      it('закрытое оператором не открывает, открытое не трогает, ниже записанного не ставит', async () => {
        await pool.query(
          `INSERT INTO tour_availability (operator_tour_id, date, available_slots, is_cancelled, cancellation_reason)
           VALUES ($1, $2, 6, TRUE, 'Шторм'), ($1, $3, 4, FALSE, NULL)`,
          [tour.gorely, iso(10), iso(12)],
        );
        await sayFresh(`открой ${words(10, 12, 14)} на Кракатау, 6 мест`);
        expect(lastText()).toContain('Закрыты оператором, не открываю (1)');
        expect(lastText()).toContain('открыть их снова может только он');
        expect(lastText()).toContain('Уже открыты, не трогаю (1)');
        expect(lastText()).toContain('Откроются (1)');
        await pressAs(yesButton()!.payload);
        expect(await slots(tour.gorely)).toEqual([
          { date: iso(10), slots: 6, cancelled: true },
          { date: iso(12), slots: 4, cancelled: false },
          { date: iso(14), slots: 6, cancelled: false },
        ]);
      });

      it('новый вопрос снимает прежний, «Не надо» и просроченный ничего не пишут', async () => {
        await sayFresh(`открой ${words(10)} на Кракатау, 6 мест`);
        const first = yesButton()!;
        await sayFresh(`открой ${words(12)} на Кракатау, 8 мест`);
        const second = yesButton()!;
        const no = lastButtons().find((b) => b.payload.startsWith('ad:n:'))!;
        await pressAs(first.payload);
        expect(lastText()).toContain('заменён');
        await pressAs(no.payload);
        expect(lastText()).toContain('Хорошо, даты не открываю');
        await pressAs(second.payload);
        expect(lastText()).toContain('отменено');

        await sayFresh(`открой ${words(14)} на Кракатау, 6 мест`);
        const third = yesButton()!;
        await pool.query(`UPDATE admin_chat_actions SET expires_at = NOW() - INTERVAL '1 minute' WHERE status = 'ready'`);
        await pressAs(third.payload);
        expect(lastText()).toContain('Вопрос устарел');
        expect(await slots(tour.gorely)).toEqual([]);
        expect((await datesRows()).map((r) => r.status)).toEqual(['superseded', 'cancelled', 'ready']);
      });

      it('снятая роль и чужой человек MAX — ничего не записано', async () => {
        await sayFresh(`открой ${words(10)} на Кракатау, 6 мест`);
        const yes = yesButton()!;
        await pressAs(yes.payload, OTHER_MAX);
        expect(lastText()).toContain('у администратора Ведара');
        await setAdmin(false);
        await pressAs(yes.payload);
        expect(lastText()).toContain('у администратора Ведара');
        expect(await slots(tour.gorely)).toEqual([]);
        expect((await datesRows()).map((r) => r.status)).toEqual(['ready']);
      });

      it('дату открыл сам оператор между вопросом и «Да» — «ничего не открыто», оператору не пишем', async () => {
        await sayFresh(`открой ${words(10)} на Кракатау, 6 мест`);
        const yes = yesButton()!;
        await pool.query(
          `INSERT INTO tour_availability (operator_tour_id, date, available_slots, is_cancelled) VALUES ($1, $2, 3, FALSE)`,
          [tour.gorely, iso(10)],
        );
        sent.length = 0;
        await pressAs(yes.payload);
        expect(lastText()).toContain('Ничего не открыто');
        expect(lastText()).toContain('Уже были открыты, не менял (1)');
        expect(sent.filter((m) => m.chatId === OP_A_MAX)).toHaveLength(0);
        expect(await slots(tour.gorely)).toEqual([{ date: iso(10), slots: 3, cancelled: false }]);
        expect((await datesRows())[0]).toMatchObject({ status: 'done', outcome: { written: 0 } });
      });

      it('без тура, без мест и «закрой» — отказ словами, прежний вопрос снят; команда «даты» осталась командой', async () => {
        await sayFresh(`открой ${words(10)} на Кракатау, 6 мест`);
        const yes = yesButton()!;
        await sayFresh(`открой ${words(10, 12)}, 6 мест`);
        expect(lastText()).toContain('Назовите тур словами из его названия');
        await pressAs(yes.payload);
        expect(lastText()).toContain('заменён');
        await sayFresh(`открой ${words(10)} на Кракатау`);
        expect(lastText()).toContain('Сколько мест на каждый выезд');
        await sayFresh(`закрой ${words(10)} на Кракатау`);
        expect(lastText()).toContain('Закрыть дату за оператора из чата нельзя');
        expect((await datesRows()).map((r) => r.status)).toEqual(['superseded']);
        expect(await slots(tour.gorely)).toEqual([]);
        sent.length = 0;
        await sayFresh('даты');
        expect(lastText()).not.toContain('Назовите тур');
        expect((await datesRows()).map((r) => r.status)).toEqual(['superseded']);
      });
    });
  });

  // ── Прокатчик входит на сайт через MAX (владелец 26.10, «Лагуна Прокат») ──
  //
  // Почты у человека нет, MAX есть. Он открывает ссылку подключения op_ в
  // личном диалоге — бот записывает чат для заявок и его самого владельцем
  // ссылки (1336); администратор нажимает «Вход через MAX / Telegram»; дальше
  // человек входит обычным «Войти через MAX» и попадает в кабинет перевозчика.
  // Всё против схемы прода: настоящая ссылка HMAC, обработчик бота, роут
  // администратора, опрос входа и роут кабинета.
  describe('прокатчик входит на сайт через MAX — по ссылке подключения (26.10)', () => {
    const OWNER_MAX = 730_001;
    const DIALOG = 9_730_001;
    let adminToken = '';

    beforeAll(async () => {
      process.env.CONNECT_TOKEN_SECRET = 'test-secret-for-partner-links-16';
      const { rows: [admin] } = await pool.query<{ id: string }>(
        `INSERT INTO users (email, name, password_hash, role, preferences)
         VALUES ('rental-admin@test.invalid', 'Админ Проката', 'x', 'admin', '{"roles":["tourist","admin"]}')
         RETURNING id::text AS id`,
      );
      const { createToken } = await import('@/lib/auth/jwt');
      adminToken = await createToken({ userId: admin.id, email: 'rental-admin@test.invalid', role: 'admin' });
      await pool.query(
        `INSERT INTO user_sessions (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
        [admin.id, adminToken],
      );
    });

    async function card(slug: string, owner: number | null = null): Promise<string> {
      const { rows: [p] } = await pool.query<{ id: string }>(
        `INSERT INTO partners (name, category, contact, is_verified, is_public, slug, max_owner_user_id)
         VALUES ($1, 'transfer', '{}', TRUE, TRUE, $1, $2) RETURNING id::text AS id`,
        [slug, owner],
      );
      return p.id;
    }

    async function messengerLogin(partnerId: string) {
      const { POST } = await import('@/app/api/admin/operators/[id]/messenger-login/route');
      const res = await POST(new NextRequest(`https://vedarai.ru/api/admin/operators/${partnerId}/messenger-login`, {
        method: 'POST', headers: { authorization: `Bearer ${adminToken}` },
      }), { params: Promise.resolve({ id: partnerId }) });
      return { status: res.status, body: (await res.json()) as { success: boolean; outcome?: string; via?: string; created?: boolean } };
    }

    const ownerOf = async (partnerId: string) => (await pool.query<{ user_id: string | null }>(
      'SELECT user_id::text AS user_id FROM partners WHERE id = $1', [partnerId],
    )).rows[0].user_id;

    it('ссылку ещё никто не открыл — отказ, аккаунта нет', async () => {
      const partnerId = await card('rental-login-none');
      const r = await messengerLogin(partnerId);
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ success: false, outcome: 'no_opener' });
      expect(await ownerOf(partnerId)).toBeNull();
    });

    it('«Старт» по op_ в диалоге → вход заведён → «Войти через MAX» открывает кабинет перевозчика', async () => {
      const partnerId = await card('rental-login-test');
      const { createPartnerLinkToken, PARTNER_LINK_PREFIX } = await import('@/lib/partners/channel-link');
      const link = createPartnerLinkToken(partnerId);
      if (!link.ok) throw new Error(link.reason);
      await bot({
        update_type: 'bot_started', timestamp: Date.now(), chat_id: DIALOG,
        user: { user_id: OWNER_MAX, name: 'Прокатчик' }, payload: `${PARTNER_LINK_PREFIX}${link.token}`,
      });
      const { rows: [bound] } = await pool.query<{ chat: string; owner: string }>(
        'SELECT max_chat_id::text AS chat, max_owner_user_id::text AS owner FROM partners WHERE id = $1', [partnerId],
      );
      // Чат для заявок — диалог, владелец ссылки — человек, а не чат.
      expect(bound).toEqual({ chat: String(DIALOG), owner: String(OWNER_MAX) });

      const r = await messengerLogin(partnerId);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ success: true, via: 'max', created: true });
      const { rows: [user] } = await pool.query<{
        id: string; role: string; password_hash: string; pd_consent_given: boolean; preferences: { roles?: string[] };
      }>(
        'SELECT id::text AS id, role, password_hash, pd_consent_given, preferences FROM users WHERE max_user_id = $1', [OWNER_MAX],
      );
      expect(user).toMatchObject({ role: 'transfer', password_hash: '', pd_consent_given: false, preferences: { roles: ['transfer'] } });
      expect(await ownerOf(partnerId)).toBe(user.id);

      // Обычный вход через MAX находит этот аккаунт: пароль не нужен.
      const nonce = await newSession();
      await start(nonce, OWNER_MAX);
      await press(lastButtons().find((b) => b.text === 'Да, это я')!.payload, OWNER_MAX);
      const login = await status(nonce);
      expect(login.status).toBe('authenticated');
      const { GET } = await import('@/app/api/hub/carrier/vehicles/route');
      const cabinet = await GET(new NextRequest('https://vedarai.ru/api/hub/carrier/vehicles', {
        headers: { authorization: `Bearer ${login.data!.token!}` },
      }));
      expect(cabinet.status).toBe(200);

      // Повтор — аккаунт уже есть, второго не заводится.
      const again = await messengerLogin(partnerId);
      expect(again).toMatchObject({ status: 409, body: { outcome: 'has_account' } });
      const { rows: [n] } = await pool.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM users WHERE max_user_id = $1', [OWNER_MAX]);
      expect(n.n).toBe('1');
    });

    it('аккаунт туриста получает роль карточки и сохраняет туристскую', async () => {
      const TOURIST_MAX = 730_002;
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, max_user_id) VALUES ('max_730002@max.local', 'Турист', '', 'tourist', $1)`,
        [TOURIST_MAX],
      );
      const partnerId = await card('rental-login-tourist', TOURIST_MAX);
      const r = await messengerLogin(partnerId);
      expect(r).toMatchObject({ status: 200, body: { via: 'max', created: false } });
      const { rows: [user] } = await pool.query<{ id: string; role: string; preferences: { roles?: string[] } }>(
        'SELECT id::text AS id, role, preferences FROM users WHERE max_user_id = $1', [TOURIST_MAX],
      );
      expect(user.role).toBe('transfer');
      expect([...(user.preferences.roles ?? [])].sort()).toEqual(['tourist', 'transfer']);
      expect(await ownerOf(partnerId)).toBe(user.id);
    });

    it('аккаунт администратора не перекрашивается: отказ, роль и карточка прежние', async () => {
      const ADMIN_MAX = 730_003;
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, max_user_id, preferences)
         VALUES ('max_730003@max.local', 'Админ', '', 'tourist', $1, '{"roles":["tourist","admin"]}')`,
        [ADMIN_MAX],
      );
      const partnerId = await card('rental-login-admin', ADMIN_MAX);
      const r = await messengerLogin(partnerId);
      expect(r).toMatchObject({ status: 409, body: { outcome: 'other_role' } });
      const { rows: [user] } = await pool.query<{ role: string }>('SELECT role FROM users WHERE max_user_id = $1', [ADMIN_MAX]);
      expect(user.role).toBe('tourist');
      expect(await ownerOf(partnerId)).toBeNull();
    });
  });
});
