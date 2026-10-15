/**
 * Тревога считается отправленной только если Telegram ответил.
 *
 * Правило вывел Watchdog 30.08: до того у него стоял `catch { // Silent
 * fail }`, ответ не читался, и тревога могла собраться и не уйти при зелёном
 * прогоне. Сторож без исправного рупора неотличим от сторожа, которому не о
 * чем доложить.
 *
 * Находка аудита 08.09: правило осталось жить в ОДНОМ файле. Евалы Кузьмича
 * писали `alerts_sent: alertText !== null` — то есть «мы решили тревожить»
 * выдавалось за «доставлено», — а сканер противоречий о безопасности слал
 * `.catch(() => {})` без проверки `res.ok`.
 *
 * Находка аудита 15.10 (P4-01): сторож был слеп там, где цена выше всего.
 * Отправителя он искал по имени переменной (`bot${token}`) и не смотрел в
 * `lib/notifications/` и `/telegram/` вовсе — поэтому SOS-рука, крон выплат
 * (`bot${botToken}`), четыре исполнителя инициатив и алерт бюджета LLM
 * (`lib/telegram/admin-notify.ts`) в долг не попадали. А health и
 * safety-ingest, стоявшие в долге, писали «предупреждён» (`alert_sent`,
 * `markAlerted`) после отправки, ответ которой не читали: недоставленная
 * тревога глушилась на 12 часов, как доставленная.
 *
 * Теперь отправитель опознаётся по адресу Bot API (хост Telegram и метод
 * `sendMessage`), без исключений по каталогу. Кому можно слать мимо общего
 * отправителя — явный список С ПРИЧИНОЙ; остальное — замороженный долг,
 * который может только СОКРАЩАТЬСЯ (тот же приём, что у
 * waterfall-sentinel-debt и schema-coverage: долг, который видно, лечится).
 * Вторая половина файла — поведение: при ответе Telegram «не принял» крон не
 * пишет, что предупредил.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

/**
 * Прямые отправители, которым это разрешено, — с причиной. Причина обязана
 * объяснять, почему общий отправитель здесь не годится или не нужен; «так
 * исторически» причиной не считается.
 */
const ALLOWED_DIRECT: Readonly<Record<string, string>> = {
  'lib/notifications/tg-send.ts':
    'сам общий отправитель: читает ответ Telegram и возвращает исход доставки',
  'app/api/safety/sos/route.ts':
    'SOS-рука, CLAUDE.md §7 «НЕ ТРОГАТЬ» (только через staging): ответ читает сама — notified = tgRes.ok, отказ пишет в лог; перевод на tgSend дал бы только общий таймаут, а не новую честность',
  'lib/notifications/telegram-channel.ts':
    'посты в публичный канал, а не тревоги: свой исход { ok: data.ok, error } возвращается вызывающему',
  'lib/notifications/telegram.ts':
    'TelegramService — клиент бота для ответов человеку с клавиатурами; читает data.ok и возвращает success/error',
  'lib/notifications/pd-alert.ts':
    'развилка ПД MAX/Telegram: заглушка с кнопками, которых у tgSend нет; читает res.ok и возвращает delivered',
  'app/api/telegram/admin/route.ts':
    'вебхук админ-бота: ответ человеку в чате, который он сам открыл, — не тревога, недоставку он видит сам',
  'app/api/telegram/kuzmich/route.ts':
    'вебхук Кузьмича: ответ человеку в чате, который он сам открыл, — не тревога, недоставку он видит сам',
  'app/api/admin/telegram/test/route.ts':
    'служебная диагностика самого канала: ответ Telegram отдаётся администратору как есть',
};

/**
 * Замороженный долг, измеренный, а не угаданный. Только сокращать.
 *
 * 08.09 — двадцать восемь файлов шлют своим кодом; разбирать их одним махом
 * значило бы менять поведение двух десятков поверхностей за раз, не проверив
 * ни одной. Watchdog вычеркнут 09.10 (партнёрам — lib/partners/notice).
 *
 * 15.10 (аудит, P4-01) перемерено по адресу Bot API: вычеркнуты health,
 * safety-ingest (тревога и «предупреждён» — только по доставке), крон выплат
 * и алерт бюджета LLM (только транспорт); вписаны семь, которых прежний
 * поиск не видел: два уведомления о бронях, сводка доступности оператора и
 * четыре исполнителя инициатив. Платёжный приёмник Точки — §7, его не трогают
 * без слова владельца.
 */
const OWN_SENDERS: readonly string[] = [
  'app/api/admin/execute-all/route.ts',
  'app/api/admin/operators/[id]/route.ts',
  'app/api/auth/register-operator/route.ts',
  'app/api/cron/booking-stall-alert/route.ts',
  'app/api/cron/digest/route.ts',
  'app/api/cron/evo/route.ts',
  'app/api/cron/smart-notify/route.ts',
  'app/api/cron/ssr-sentinel/route.ts',
  'app/api/cron/tour-reminder/route.ts',
  'app/api/cron/tour-review-request/route.ts',
  'app/api/payments/tochka/webhook/route.ts',
  'app/api/safety/reports/route.ts',
  'app/api/safety/wishes/route.ts',
  'lib/agents/editor.ts',
  'lib/agents/evo/rescue-agent.ts',
  'lib/agents/execution/handlers/ab-scale-executor.ts',
  'lib/agents/execution/handlers/code-change-executor.ts',
  'lib/agents/execution/handlers/operator-outreach-executor.ts',
  'lib/agents/execution/initiative-executor.ts',
  'lib/agents/safeguards/approval-required.ts',
  'lib/agents/scout-ai-features.ts',
  'lib/agents/scout-digest.ts',
  'lib/agents/scout-innovator.ts',
  'lib/agents/tools/board-executor-tools.ts',
  'lib/agents/volcano/merge-gate.ts',
  'lib/leads/proposal-delivery.ts',
  'lib/notifications/operator-booking.ts',
  'lib/notifications/stay-booking.ts',
  'lib/services/ingest/osm-traces-scout.ts',
  'lib/services/intelligence-monitor.service.ts',
  'lib/telegram/operator-availability.ts',
];

/**
 * Шлёт ли код в Telegram сам: есть хост Bot API (или его переменная) и метод
 * `sendMessage` в адресе. Имя переменной с токеном не важно — прежний поиск
 * по `bot${token}` пропускал `bot${botToken}` и `bot${tgToken}`.
 */
function sendsToTelegramDirectly(code: string): boolean {
  if (!/api\.telegram\.org|TELEGRAM_API_BASE/.test(code)) return false;
  return /\/sendMessage[`'"]/.test(code);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Все, кто шлёт в Telegram своим fetch, — без исключений по каталогу. */
function directSenders(): string[] {
  const found: string[] = [];
  for (const dir of ['lib', 'app']) {
    for (const file of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, file).split('\\').join('/');
      if (sendsToTelegramDirectly(readFileSync(file, 'utf-8'))) found.push(rel);
    }
  }
  return found.sort();
}

describe('доставка тревог: одна реализация, долг только сокращается', () => {
  it('общий отправитель возвращает исход, а не void', () => {
    const SRC = readFileSync('lib/notifications/tg-send.ts', 'utf-8');
    expect(SRC).toMatch(/export type TgSendOutcome = \{ ok: true \} \| \{ ok: false; reason: string \}/);
    expect(SRC).toMatch(/if \(!res\.ok\)/);
    // Ненастроенный канал — тоже недоставка, а не тишина.
    expect(SRC).toContain('тревога никуда не ушла');
  });

  it('опознание отправителя не зависит от имени переменной с токеном', () => {
    const base = "`${process.env.TELEGRAM_API_BASE||'https://api.telegram.org'}/bot";
    // Формы, которые прежний поиск пропускал: SOS-рука и крон выплат.
    expect(sendsToTelegramDirectly(`fetch(${base}\${botToken}/sendMessage\`)`)).toBe(true);
    expect(sendsToTelegramDirectly(`fetch(${base}\${tgToken}/sendMessage\`)`)).toBe(true);
    // Клиент-класс: хост в одном месте, метод в другом.
    expect(sendsToTelegramDirectly(
      `get baseUrl() { return ${base}\${this.botToken}\`; }\nfetch(\`\${this.baseUrl}/sendMessage\`)`,
    )).toBe(true);
    expect(sendsToTelegramDirectly("fetch('https://api.telegram.org/bot' + t + '/sendMessage')")).toBe(true);
    // Вызов общего отправителя — не своя отправка.
    expect(sendsToTelegramDirectly("import { tgSend } from '@/lib/notifications/tg-send';\nawait tgSend('x', text);")).toBe(false);
    // Только getMe — диагностика, не отправка.
    expect(sendsToTelegramDirectly(`fetch(${base}\${token}/getMe\`)`)).toBe(false);
  });

  it('новых прямых отправителей нет', () => {
    const unexpected = directSenders().filter((f) => !(f in ALLOWED_DIRECT) && !OWN_SENDERS.includes(f));
    expect(unexpected, `новые самодельные отправители (общий — lib/notifications/tg-send.ts): ${unexpected.join(', ')}`).toEqual([]);
  });

  it('починенное вычёркивается тем же коммитом, а не копится в списке', () => {
    const current = new Set(directSenders());
    const stale = [...OWN_SENDERS, ...Object.keys(ALLOWED_DIRECT)].filter((f) => !current.has(f));
    expect(stale, `уже не шлют своим кодом, вычеркни из списка: ${stale.join(', ')}`).toEqual([]);
  });

  it('у каждого разрешённого — причина, и долг с разрешением не пересекается', () => {
    for (const [file, why] of Object.entries(ALLOWED_DIRECT)) {
      expect(why.length, `причина для ${file} пуста или отписка`).toBeGreaterThanOrEqual(40);
    }
    const both = OWN_SENDERS.filter((f) => f in ALLOWED_DIRECT);
    expect(both, `файл и в долге, и в разрешённых: ${both.join(', ')}`).toEqual([]);
  });

  it('SOS-рука остаётся разрешённой: она читает ответ сама', () => {
    // Разрешение держится на этом свойстве. Перестанет читать — разрешение
    // теряет причину, и сторож обязан это заметить, а не ждать аудита.
    const SOS = readFileSync('app/api/safety/sos/route.ts', 'utf-8');
    expect(SOS).toMatch(/notified = tgRes\.ok/);
  });
});

describe('евалы и сканер безопасности отчитываются по доставке', () => {
  it('faithfulness: alerts_sent — это факт доставки', () => {
    const SRC = readFileSync('lib/agents/eval/kuzmich-faithfulness.ts', 'utf-8');
    expect(SRC).toMatch(/alerts_sent: delivery\?\.ok === true/);
    expect(SRC).not.toMatch(/alerts_sent: alertText !== null/);
    expect(SRC).toContain("tgSend('kuzmich-eval'");
  });

  it('red-team: то же самое', () => {
    const SRC = readFileSync('lib/agents/eval/kuzmich-redteam.ts', 'utf-8');
    expect(SRC).toMatch(/alerts_sent: delivery\?\.ok === true/);
    expect(SRC).not.toMatch(/alerts_sent: alertText !== null/);
  });

  it('сканер противоречий о безопасности не шлёт вслепую', () => {
    const SRC = readFileSync('lib/agents/memory-contradiction.ts', 'utf-8');
    expect(SRC).toContain("tgSend('memory-contradiction'");
    expect(SRC).not.toMatch(/\.catch\(\(\) => \{\}\);/);
  });

  it('главный алерт Watchdog идёт общей реализацией', () => {
    const SRC = readFileSync('lib/agents/watchdog.ts', 'utf-8');
    expect(SRC).toContain("tgSendShared('watchdog'");
    // Своей копии проверки ответа у него больше нет — она вынесена.
    expect(SRC).not.toContain('HTTP 200 — единственное доказательство доставки');
  });
});

// ── Поведение: «предупреждён» — только по доставке (аудит 15.10, P4-01) ──────

const h = vi.hoisted(() => ({
  remember: vi.fn(async (_entry: unknown) => undefined),
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  markAlerted: vi.fn(async (_pool: unknown, _keys: string[]) => undefined),
  /** Источник с `<` и `&` в имени — проверка, что простой текст экранирован. */
  DEAD: { key: 'w2_test_source', label: 'Лента <тест> & проба', reason: 'silent' as const, silentHours: 48 },
}));
const { remember, poolQuery, poolConnect, markAlerted, DEAD } = h;

vi.mock('@/lib/agents/memory/agent-memory', () => ({
  agentMemory: { remember: h.remember, get: vi.fn(async () => null) },
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: h.poolQuery, connect: h.poolConnect } }));
vi.mock('@/lib/agents/cron-lease', () => ({
  claimCronWindow: vi.fn(async () => ({ status: 'claimed' })),
  shouldRun: () => true,
  leaseSkipBody: () => ({ ok: true, skipped: true }),
}));
vi.mock('@/lib/agents/cron-heartbeat', () => ({ recordCronRun: vi.fn() }));
vi.mock('@/lib/services/safety/source-health', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/services/safety/source-health')>();
  return {
    ...real,
    recordSourceHealth: vi.fn(async () => undefined),
    loadSourceHealth: vi.fn(async () => []),
    evaluateDeadSources: vi.fn(() => [h.DEAD]),
    dueForAlert: vi.fn((dead: unknown[]) => dead),
    markAlerted: h.markAlerted,
  };
});

/** Telegram «не принял»: так он отвечает на заблокированного бота. */
const TG_REFUSED = () => new Response(
  JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }),
  { status: 403, headers: { 'Content-Type': 'application/json' } },
);
const TG_ACCEPTED = () => new Response(
  JSON.stringify({ ok: true, result: { message_id: 1 } }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
);

describe('тревога отправлена — только когда дошла', () => {
  const fetchMock = vi.fn();
  const envBefore = { ...process.env };

  beforeEach(() => {
    remember.mockClear();
    markAlerted.mockClear();
    poolQuery.mockReset();
    poolConnect.mockReset();
    fetchMock.mockReset();
    // Недоставку tgSend пишет в лог — это и есть его исход; в выводе теста шум.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', fetchMock);
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_CHAT_ID = '-100';
    process.env.TELEGRAM_OWNER_ID = '42';
    process.env.CRON_SECRET = 'cron-test';
    process.env.AI_DAILY_BUDGET_USD = '10';
    delete process.env.TELEGRAM_API_BASE;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env = { ...envBefore };
  });

  /** Был ли среди вызовов fetch запрос к Bot API sendMessage. */
  const tgCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/sendMessage'));

  it('health: Telegram не принял — alert_sent не пишется, исход возвращается', async () => {
    fetchMock.mockImplementation(async () => TG_REFUSED());
    const { deliverHealthAlert } = await import('@/app/api/cron/health/route');
    const outcome = await deliverHealthAlert('WARN: DeepSeek недоступен', ['DeepSeek недоступен']);
    expect(tgCalls()).toHaveLength(1);
    expect(outcome.ok).toBe(false);
    expect(remember).not.toHaveBeenCalled();
  });

  it('health: Telegram принял — дебаунс записан по каждому WARN', async () => {
    fetchMock.mockImplementation(async () => TG_ACCEPTED());
    const { deliverHealthAlert } = await import('@/app/api/cron/health/route');
    const outcome = await deliverHealthAlert('WARN: a\nWARN: b', ['a', 'b']);
    expect(outcome.ok).toBe(true);
    expect(remember).toHaveBeenCalledTimes(2);
    expect(remember.mock.calls.every(([e]) => (e as { memory_type: string }).memory_type === 'alert_sent')).toBe(true);
  });

  it('safety-ingest: Telegram не принял — markAlerted не зовётся', async () => {
    fetchMock.mockImplementation(async () => TG_REFUSED());
    const { watchSourceHealth } = await import('@/app/api/cron/safety-ingest/route');
    await watchSourceHealth([]);
    expect(tgCalls()).toHaveLength(1);
    expect(markAlerted).not.toHaveBeenCalled();
  });

  it('safety-ingest: канал не настроен — тоже недоставка, markAlerted не зовётся', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const { watchSourceHealth } = await import('@/app/api/cron/safety-ingest/route');
    await watchSourceHealth([]);
    expect(tgCalls()).toHaveLength(0);
    expect(markAlerted).not.toHaveBeenCalled();
  });

  it('safety-ingest: Telegram принял — источник помечен, текст экранирован для HTML', async () => {
    fetchMock.mockImplementation(async () => TG_ACCEPTED());
    const { watchSourceHealth } = await import('@/app/api/cron/safety-ingest/route');
    await watchSourceHealth([]);
    expect(markAlerted).toHaveBeenCalledWith(expect.anything(), [DEAD.key]);
    const body = JSON.parse(String((tgCalls()[0][1] as RequestInit).body)) as { text: string };
    expect(body.text).toContain('Лента &lt;тест&gt; &amp; проба');
  });

  const budgetRequest = () => new Request('https://vedarai.ru/api/cron/llm-budget-check', {
    headers: { authorization: 'Bearer cron-test' },
  });

  it('llm-budget-check: Telegram не принял — статус не «alert_sent»', async () => {
    poolQuery.mockResolvedValue({ rows: [{ spent: '12.5', unknown_calls: '0' }] });
    fetchMock.mockImplementation(async () => TG_REFUSED());
    const { GET } = await import('@/app/api/cron/llm-budget-check/route');
    const body = await (await GET(budgetRequest())).json() as { status: string; alert: { ok: boolean } };
    expect(tgCalls()).toHaveLength(1);
    expect(body.status).toBe('alert_not_delivered');
    expect(body.alert.ok).toBe(false);
  });

  it('llm-budget-check: Telegram принял — «alert_sent», адресат — владелец', async () => {
    poolQuery.mockResolvedValue({ rows: [{ spent: '12.5', unknown_calls: '0' }] });
    fetchMock.mockImplementation(async () => TG_ACCEPTED());
    const { GET } = await import('@/app/api/cron/llm-budget-check/route');
    const body = await (await GET(budgetRequest())).json() as { status: string };
    expect(body.status).toBe('alert_sent');
    const sent = JSON.parse(String((tgCalls()[0][1] as RequestInit).body)) as { chat_id: string };
    expect(sent.chat_id).toBe('42');
  });

  it('payouts: релиз не зависит от уведомления, а недоставка видна в ответе', async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (/SELECT id, operator_id, net_amount/.test(sql)) {
        return { rows: [{ id: 'tp-1', operator_id: 'op-1', net_amount: '1500', booking_id: 'b-1' }] };
      }
      if (/COUNT\(\*\)::text AS count/.test(sql)) return { rows: [{ count: '0', total: '0' }] };
      return { rows: [] };
    });
    poolConnect.mockResolvedValue({ query: clientQuery, release: vi.fn() });
    fetchMock.mockImplementation(async () => TG_REFUSED());
    const { GET } = await import('@/app/api/cron/payouts/route');
    const req = new Request('https://vedarai.ru/api/cron/payouts', { headers: { authorization: 'Bearer cron-test' } });
    const res = await GET(req as unknown as Parameters<typeof GET>[0]);
    const body = await res.json() as { ok: boolean; released: number; notice: { ok: boolean } };
    expect(body.ok).toBe(true);
    expect(body.released).toBe(1);
    expect(body.notice.ok).toBe(false);
    expect(clientQuery.mock.calls.some(([sql]) => /SET status\s+= 'RELEASED'/.test(String(sql)))).toBe(true);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql) === 'COMMIT')).toBe(true);
    expect(tgCalls()).toHaveLength(1);
  });
});
