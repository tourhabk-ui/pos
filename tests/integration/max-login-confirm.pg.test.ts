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
});
