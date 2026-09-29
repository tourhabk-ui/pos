/**
 * Привязка оператора к мессенджеру по ссылке (решение владельца 29.09).
 *
 * Повод: перепись operator-reach 11.09 — у обоих операторов с живыми турами
 * нет ни Telegram, ни MAX, и любая заявка уходит в пустоту. Сторож держит
 * связку целиком (§10.09): токен → обработчик бота → запись туда, где читает
 * доставка → видимость в админке.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const poolQueryMock = vi.hoisted(() => vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>());
const tgSendMock = vi.hoisted(() => vi.fn<(m: { chatId: string; text: string }) => Promise<{ success: boolean; error?: string }>>());
const maxSendMock = vi.hoisted(() => vi.fn<(chatId: string | number, text: string) => Promise<{ ok: boolean; error?: string }>>());

vi.mock('@/lib/db-pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => poolQueryMock(sql, params) },
}));
vi.mock('@/lib/notifications/telegram', () => ({
  telegramService: { sendMessage: (m: { chatId: string; text: string }) => tgSendMock(m) },
}));
vi.mock('@/lib/notifications/max-channel', () => ({
  maxSendDm: (chatId: string | number, text: string) => maxSendMock(chatId, text),
}));

import {
  createPartnerLinkToken, verifyPartnerLinkToken, buildPartnerChannelLinks,
  partnerTokenFromStart, PARTNER_LINK_PREFIX, PARTNER_LINK_TTL_MS,
} from '@/lib/partners/channel-link';
import { generateConnectToken } from '@/lib/telegram/connect-token';
import { bindPartnerChannel, bindReplyText } from '@/lib/partners/bind-channel';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const PID = '3f2b8c1a-9d4e-4b7a-8c21-0e5f6a7b8c9d';
const NOW = Date.UTC(2026, 8, 29, 6, 0);

beforeEach(() => {
  vi.stubEnv('JWT_SECRET', 'test-secret-long-enough-0123456789');
  vi.stubEnv('CONNECT_TOKEN_SECRET', '');
  vi.stubEnv('TELEGRAM_CHAT_ID', '-100500');
  poolQueryMock.mockReset();
  tgSendMock.mockReset();
  tgSendMock.mockResolvedValue({ success: true });
  maxSendMock.mockReset();
  maxSendMock.mockResolvedValue({ ok: true });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('токен ссылки', () => {
  it('туда и обратно — тот же партнёр', () => {
    const t = createPartnerLinkToken(PID, NOW);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(verifyPartnerLinkToken(t.token, NOW + 1000)).toEqual({ ok: true, partnerId: PID });
  });

  it('влезает в параметр start Telegram: ≤64 символов из [A-Za-z0-9_-]', () => {
    const t = createPartnerLinkToken(PID, NOW);
    if (!t.ok) throw new Error('нет токена');
    const start = `${PARTNER_LINK_PREFIX}${t.token}`;
    expect(start.length).toBeLessThanOrEqual(64);
    expect(start).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('срок — 72 часа, после него «устарела», а не «подделка»', () => {
    const t = createPartnerLinkToken(PID, NOW);
    if (!t.ok) throw new Error('нет токена');
    expect(PARTNER_LINK_TTL_MS).toBe(72 * 3600 * 1000);
    expect(verifyPartnerLinkToken(t.token, NOW + PARTNER_LINK_TTL_MS - 60_000).ok).toBe(true);
    expect(verifyPartnerLinkToken(t.token, NOW + PARTNER_LINK_TTL_MS + 120_000)).toEqual({ ok: false, reason: 'expired' });
  });

  it('подменённый символ — bad_signature', () => {
    const t = createPartnerLinkToken(PID, NOW);
    if (!t.ok) throw new Error('нет токена');
    const flipped = t.token.slice(0, 5) + (t.token[5] === 'A' ? 'B' : 'A') + t.token.slice(6);
    expect(verifyPartnerLinkToken(flipped, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('чужой секрет — bad_signature', () => {
    const t = createPartnerLinkToken(PID, NOW);
    if (!t.ok) throw new Error('нет токена');
    vi.stubEnv('JWT_SECRET', 'another-secret-long-enough-987654');
    expect(verifyPartnerLinkToken(t.token, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('токен привязки ЧЕЛОВЕКА здесь не проходит (доменное разделение)', () => {
    const userToken = generateConnectToken(PID);
    expect(verifyPartnerLinkToken(userToken, NOW).ok).toBe(false);
  });

  it('без секрета ссылка не выдаётся и не проверяется — запасного dev-ключа нет', () => {
    vi.stubEnv('JWT_SECRET', '');
    expect(createPartnerLinkToken(PID, NOW)).toEqual({ ok: false, reason: 'no_secret' });
    expect(verifyPartnerLinkToken('x'.repeat(43), NOW)).toEqual({ ok: false, reason: 'no_secret' });
    expect(read('lib/partners/channel-link.ts')).not.toMatch(/dev-connect-secret/);
  });

  it('мусор — malformed, не исключение', () => {
    for (const bad of ['', 'abc', 'x'.repeat(44), '!'.repeat(43)]) {
      expect(verifyPartnerLinkToken(bad, NOW)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('не UUID — ссылки нет', () => {
    expect(createPartnerLinkToken('42', NOW)).toEqual({ ok: false, reason: 'bad_partner_id' });
  });

  it('ссылки ведут только на своих ботов, посторонний хост из env игнорируется', () => {
    vi.stubEnv('NEXT_PUBLIC_MAX_BOT_LINK', 'https://evil.example/bot');
    vi.stubEnv('NEXT_PUBLIC_TELEGRAM_BOT_USERNAME', 'evil.example/x');
    const l = buildPartnerChannelLinks(PID, NOW);
    if (!l.ok) throw new Error('нет ссылок');
    expect(l.max.startsWith('https://max.ru/')).toBe(true);
    expect(l.telegram.startsWith('https://t.me/kuzmichai_bot?start=op_')).toBe(true);
    const tok = partnerTokenFromStart(new URL(l.telegram).searchParams.get('start') ?? '');
    expect(tok && verifyPartnerLinkToken(tok, NOW).ok).toBe(true);
  });
});

describe('запись канала', () => {
  it('Telegram — в колонку доставки И зеркалом в contacts JSONB', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ name: 'Камчатская рыбалка', previous: null }] });
    const r = await bindPartnerChannel(PID, 'telegram', 12345);
    expect(r).toEqual({ ok: true, partnerName: 'Камчатская рыбалка', previousChatId: null, rebound: false });
    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(sql).toMatch(/SET telegram_chat_id = \$1::bigint/);
    expect(sql).toMatch(/jsonb_build_object\('telegram_chat_id', \$1::text\)/);
    expect(params).toEqual(['12345', PID]);
    // Администратор узнаёт о подключении; прежнего чата не было — ему нечего слать.
    expect(tgSendMock).toHaveBeenCalledTimes(1);
    expect(tgSendMock.mock.calls[0][0].chatId).toBe('-100500');
  });

  it('MAX — в max_chat_id', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ name: 'Рафтинг', previous: null }] });
    await bindPartnerChannel(PID, 'max', -900000000123);
    expect(poolQueryMock.mock.calls[0][0]).toMatch(/SET max_chat_id = \$1::bigint/);
  });

  it('перепривязка не молчит: пишут и администратору, и ПРЕЖНЕМУ чату', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ name: 'Рафтинг', previous: '111' }] });
    const r = await bindPartnerChannel(PID, 'max', 222);
    expect(r.ok && r.rebound).toBe(true);
    expect(tgSendMock.mock.calls[0][0].text).toMatch(/ПЕРЕНЕСЕНЫ/);
    expect(maxSendMock).toHaveBeenCalledWith('111', expect.stringMatching(/больше не приходят/));
  });

  it('тот же чат повторно — не перепривязка', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ name: 'Рафтинг', previous: '222' }] });
    const r = await bindPartnerChannel(PID, 'max', 222);
    expect(r.ok && r.rebound).toBe(false);
    expect(maxSendMock).not.toHaveBeenCalled();
  });

  it('партнёра нет — not_found; база упала — db_error с SQLSTATE в логе', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    expect(await bindPartnerChannel(PID, 'telegram', 1)).toEqual({ ok: false, reason: 'not_found' });

    poolQueryMock.mockImplementation(async () => { throw Object.assign(new Error('x'), { code: '57P01' }); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await bindPartnerChannel(PID, 'telegram', 1)).toEqual({ ok: false, reason: 'db_error' });
    const logged = errSpy.mock.calls.flat().join(' ');
    errSpy.mockRestore();
    expect(logged).toMatch(/SQLSTATE=57P01/);
  });

  it('ответ в Telegram честно говорит, что ПД туриста приходят только в MAX', () => {
    const t = bindReplyText('telegram', { ok: true, partnerName: 'X', previousChatId: null, rebound: false });
    expect(t).toMatch(/только в MAX/);
  });
});

describe('обработчики ботов', () => {
  it('Telegram: /start op_ разбирается ДО link_ и пишет в партнёра', () => {
    const src = read('app/api/telegram/webhook/route.ts');
    const op = src.indexOf('partnerTokenFromStart(arg)');
    const link = src.indexOf("arg.startsWith('link_')");
    expect(op).toBeGreaterThan(0);
    expect(op).toBeLessThan(link);
    expect(src).toMatch(/bindPartnerChannel\(check\.partnerId, 'telegram', update\.message\.chat\.id\)/);
  });

  it('MAX: привязка только по заверенному источнику апдейта', () => {
    const src = read('app/api/max/kuzmich/route.ts');
    const i = src.indexOf("bindPartnerChannel(check.partnerId, 'max'");
    expect(i).toBeGreaterThan(0);
    // Ближайший гейт перед разбором токена, и его блок между ними не закрыт.
    // Гейт входа выше по файлу не в счёт: его блок закрывается раньше.
    const k = src.lastIndexOf('partnerTokenFromStart(update.payload)', i);
    expect(k).toBeGreaterThan(0);
    const gate = src.lastIndexOf('if (opts?.verifiedOrigin === true', k);
    expect(gate).toBeGreaterThan(0);
    expect(src.slice(gate, k)).not.toMatch(/\n  \}\n/);
  });
});

describe('админка видит то же, что доставка', () => {
  it('ссылку выдаёт только администратор', () => {
    expect(read('app/api/admin/operators/[id]/channel-link/route.ts')).toMatch(/requireAdmin\(request\)/);
  });

  it('состояние каналов — по колонкам, а не по contacts JSONB', () => {
    expect(read('app/api/admin/operators/route.ts')).toMatch(/\(p\.telegram_chat_id IS NOT NULL\) AS has_telegram/);
    expect(read('app/api/admin/operators/route.ts')).toMatch(/\(p\.max_chat_id IS NOT NULL\)\s+AS has_max/);
    const ui = read('app/hub/admin/operators/_OperatorsClient.tsx');
    expect(ui).toMatch(/channel-link/);
    // Ручное поле, писавшее чат только в JSONB, из карточки убрано.
    expect(ui).not.toMatch(/placeholder="telegram_chat_id/);
  });

  it('ручной путь пишет чат и в колонку', () => {
    expect(read('app/api/admin/operators/[id]/contacts/route.ts')).toMatch(/telegram_chat_id = CASE WHEN \$3::boolean THEN \$4::bigint/);
  });
});

/**
 * Кто ещё читает чат из contacts JSONB вместо колонки. Пока они есть, зеркало
 * в bind-channel обязано жить; список может только сокращаться — перевели
 * читателя на колонку (lib/partners/reach), уберите его отсюда. Приёмник оплат
 * — §7, «не трогать»: переводится только решением владельца.
 */
const KNOWN_JSONB_TELEGRAM_READERS = [
  'app/api/admin/operators/[id]/contacts/route.ts',
  'app/api/admin/operators/[id]/route.ts',
  'app/api/admin/operators/route.ts',
  'app/api/cron/leads-followup/route.ts',
  'app/api/hub/operator/payments/webhook/route.ts',
  'app/api/telegram/webhook/route.ts',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('читатели чата из JSONB', () => {
  it('новых нет, а зеркало живо, пока старые есть', () => {
    const root = process.cwd();
    const found = [...walk(join(root, 'app')), ...walk(join(root, 'lib'))]
      .filter(f => /contacts->>'telegram_chat_id'/.test(readFileSync(f, 'utf-8').replace(/^\s*(\/\/|\*|--).*$/gm, '')))
      .map(f => f.slice(root.length + 1))
      .filter(f => f !== 'lib/partners/bind-channel.ts')
      .sort();
    const unknown = found.filter(f => !KNOWN_JSONB_TELEGRAM_READERS.includes(f));
    expect(unknown, 'новый читатель contacts->>telegram_chat_id — читай колонку через lib/partners/reach').toEqual([]);
    const stale = KNOWN_JSONB_TELEGRAM_READERS.filter(f => !found.includes(f));
    expect(stale, 'читатель переведён на колонку — убери его из списка').toEqual([]);
    if (found.length > 0) {
      expect(read('lib/partners/bind-channel.ts')).toMatch(/jsonb_build_object\('telegram_chat_id'/);
    }
  });
});
