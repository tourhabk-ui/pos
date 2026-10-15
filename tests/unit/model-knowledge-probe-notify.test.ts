/**
 * Ежемесячная проба знания доходит до человека (14.10, владелец: «включай»).
 *
 * Проба по расписанию без потребителя — замер, которого никто не видит:
 * сводку прогона GitHub Actions не читают, и момент «модель нас узнала»,
 * ради которого проба повторяется раз в месяц, прошёл бы мимо (§10.09).
 * Поэтому workflow зовёт роут с ?notify=1, и итог уходит в админский чат
 * Telegram, а прогон, где спросить не удалось никого, пишется пульсом
 * 'failed', а не тишиной.
 *
 * Сторож — вызов роута с подменённой сетью: что ушло в Telegram, что
 * вернулось в ответе, что легло в agent_run_history. Плюс сам текст итога —
 * вызовом digestText на граничных данных.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const { query } = vi.hoisted(() => ({
  query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 })),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));

import { GET, digestText, summarize, type LegResult } from '@/app/api/cron/model-knowledge-probe/route';
import { CRON_REGISTRY } from '@/lib/agents/cron-registry';

const TELEGRAM_HOST = 'api.telegram.org';
const YANDEX_HOST = 'llm.api.cloud.yandex.net';

interface TgBody { chat_id: string; text: string; parse_mode: string }

/**
 * Сеть пробы: Telegram отвечает заданным кодом, YandexGPT — заданным текстом
 * (null — отказом сервера), всё остальное — 503.
 */
function stubNet(opts: { yandex: string | null; telegramStatus?: number }): TgBody[] {
  const sent: TgBody[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes(TELEGRAM_HOST)) {
      sent.push(JSON.parse(String(init?.body)) as TgBody);
      const status = opts.telegramStatus ?? 200;
      return new Response(status === 200 ? '{"ok":true}' : '{"ok":false,"description":"Forbidden: bot was blocked by the user"}', { status });
    }
    if (url.includes(YANDEX_HOST) && opts.yandex !== null) {
      return new Response(JSON.stringify({
        result: { alternatives: [{ status: 'ALTERNATIVE_STATUS_FINAL', message: { role: 'assistant', text: opts.yandex } }] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('unavailable', { status: 503 });
  }));
  return sent;
}

function probe(search = ''): Promise<Response> {
  return GET(new NextRequest(`http://localhost/api/cron/model-knowledge-probe${search}`, {
    headers: { Authorization: 'Bearer cron-test' },
  }));
}

interface ProbeBody {
  ok: boolean;
  summary: { knows: string[]; could_not_ask: string[] };
  notify: { sent: boolean; reason: string } | null;
}

/** Строки agent_run_history, записанные пульсом (logAgentRun — без await). */
async function heartbeats(): Promise<Array<{ agent: unknown; status: unknown; items: unknown }>> {
  await new Promise((r) => setTimeout(r, 0));
  return query.mock.calls
    .filter(([sql]) => String(sql).includes('INSERT INTO agent_run_history'))
    .map(([, params]) => ({ agent: params?.[0], status: params?.[1], items: params?.[5] }));
}

beforeEach(() => {
  query.mockClear();
  vi.stubEnv('CRON_SECRET', 'cron-test');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'tg-test');
  vi.stubEnv('TELEGRAM_CHAT_ID', '-100500');
  vi.stubEnv('TELEGRAM_API_BASE', '');
  // Из семи ног живая только YandexGPT: остальные «спросить нечем», в сеть не ходят.
  vi.stubEnv('DEEPSEEK_API_KEY', '');
  vi.stubEnv('DASHSCOPE_API_KEY', '');
  vi.stubEnv('MOONSHOT_API_KEY', '');
  vi.stubEnv('GLM_API_KEY', '');
  vi.stubEnv('YANDEX_API_KEY', 'y-test');
  vi.stubEnv('YANDEX_FOLDER_ID', 'b1gtestfolder0000000');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('итог пробы уходит в Telegram только по ?notify=1', () => {
  it('модель назвала Камчатку сама — в чат уходит «знают» с цитатой, ответ говорит «доставлен»', async () => {
    const sent = stubNet({ yandex: 'Ведар — туристическая платформа Камчатки: маршруты и туры.' });
    const res = await probe('?notify=1');
    expect(res.status).toBe(200);
    const body = await res.json() as ProbeBody;
    expect(body.ok).toBe(true);
    expect(body.summary.knows).toEqual(['yandex']);
    expect(body.notify).toEqual({ sent: true, reason: 'доставлен' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chat_id: '-100500', parse_mode: 'HTML' });
    expect(sent[0].text).toContain('<b>Знают: yandex</b>');
    expect(sent[0].text).toContain('туристическая платформа Камчатки');
    // Ноги без ключа названы с причиной, а не пропущены.
    expect(sent[0].text).toContain('deepseek: DEEPSEEK_API_KEY не задан');
  });

  it('без ?notify=1 в Telegram не уходит ничего, notify — null', async () => {
    const sent = stubNet({ yandex: 'Ведар — платформа о Камчатке.' });
    const body = await (await probe()).json() as ProbeBody;
    expect(body.ok).toBe(true);
    expect(body.notify).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('Telegram отказал — ответ называет отказ, а не «доставлен»', async () => {
    stubNet({ yandex: 'не знаю', telegramStatus: 403 });
    const body = await (await probe('?notify=1')).json() as ProbeBody;
    expect(body.notify?.sent).toBe(false);
    expect(body.notify?.reason).toMatch(/403/);
  });

  it('спросить не удалось никого — итог всё равно уходит: «замера нет» тоже новость', async () => {
    const sent = stubNet({ yandex: null });
    const body = await (await probe('?notify=1')).json() as ProbeBody;
    expect(body.ok).toBe(false);
    // Семь ног (с 15.10 — тематическая поисковая qwen-search-topic, аудит CN-probe).
    expect(body.summary.could_not_ask).toHaveLength(7);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('Знают: никто');
    expect(sent[0].text).toContain('Спросить не удалось:');
  });
});

describe('пульс в agent_run_history', () => {
  it('спросили хоть одну модель — success с числом спрошенных', async () => {
    stubNet({ yandex: 'не знаю' });
    await probe();
    expect(await heartbeats()).toEqual([{ agent: 'model-knowledge-probe', status: 'success', items: 1 }]);
  });

  it('не спросили никого — failed, а не тишина и не success', async () => {
    stubNet({ yandex: null });
    await probe();
    expect(await heartbeats()).toEqual([{ agent: 'model-knowledge-probe', status: 'failed', items: 0 }]);
  });

  it('пульс пишется под тем agentId, который ждёт реестр', () => {
    const entry = CRON_REGISTRY.find((e) => e.key === 'model-knowledge-probe');
    expect(entry?.agentId).toBe('model-knowledge-probe');
    expect(entry?.workflow).toBe('model-knowledge-probe.yml');
  });
});

describe('текст итога', () => {
  const leg = (over: Partial<LegResult>): LegResult => ({
    provider: 'deepseek', model: null, outcome: 'does_not_know', signal: 'сказала, что не знает',
    old_brand: false, reason: null, latency_ms: 1, answer_excerpt: '不知道。', search: null, ...over,
  });

  it('чужой текст экранируется: разметку ответа модели Telegram не примет за свою', () => {
    const legs = [
      leg({ provider: 'qwen', model: 'qwen<x>', outcome: 'knows', signal: 'назвала Камчатку сама', answer_excerpt: 'Камчатка <script>alert(1)</script> & вулканы' }),
      leg({ provider: 'kimi', outcome: 'could_not_ask', reason: 'http_400 <html>Bad Request</html>', answer_excerpt: null }),
    ];
    const text = digestText(legs, summarize(legs));
    expect(text).toContain('<b>Знают: qwen (qwen&lt;x&gt;)</b>');
    expect(text).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; вулканы');
    expect(text).toContain('kimi: http_400 &lt;html&gt;Bad Request&lt;/html&gt;');
    expect(text).not.toContain('<script>');
    expect(text).not.toContain('<html>');
  });

  it('никто не знает — «никто», с моделями в скобках; прежнее имя названо отдельной строкой', () => {
    const legs = [
      leg({ provider: 'deepseek', model: 'deepseek-v4-pro' }),
      leg({ provider: 'qwen', model: 'qwen3.8-max', outcome: 'knows', signal: 'назвала прежнее имя платформы', old_brand: true, answer_excerpt: null }),
    ];
    expect(digestText([legs[0]], summarize([legs[0]]))).toContain('Знают: никто');
    expect(digestText([legs[0]], summarize([legs[0]]))).toContain('Не знают: deepseek (deepseek-v4-pro)');
    expect(digestText(legs, summarize(legs))).toContain('Под прежним именем платформы: qwen');
  });

  it('длинный ответ и длинная причина режутся, а не раздувают сообщение', () => {
    const legs = [
      leg({ provider: 'yandex', outcome: 'knows', signal: 'назвала Камчатку сама', answer_excerpt: `Камчатка ${'а'.repeat(500)}` }),
      leg({ provider: 'glm', outcome: 'could_not_ask', reason: 'б'.repeat(500), answer_excerpt: null }),
    ];
    const text = digestText(legs, summarize(legs));
    expect(text.length).toBeLessThan(900);
    expect(text).not.toContain('а'.repeat(300));
    expect(text).not.toContain('б'.repeat(200));
  });
});
