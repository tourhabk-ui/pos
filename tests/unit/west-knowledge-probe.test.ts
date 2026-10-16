// @vitest-environment node
/**
 * Сторож пробы «как нас видят ChatGPT и Grok» (16.10, владелец: «как нас
 * видят грок джипити чат»): lib/ai/west-probe.ts и scripts/west-knowledge-probe.ts.
 *
 * Держится поведением (§4 «Сторож судит поведение»): выбор модели — вызовом
 * на списках id, вопрос модели — на подменённом fetch (что ушло в запрос и что
 * вернулось исходом), прогон — кодом выхода. Ни одного запроса наружу.
 *
 * Главное свойство — §4.0: отказ провайдера, таймаут, нет ключа, нет модели —
 * «спросить не удалось» с причиной, а не «не знает»; ответ без источников у
 * поисковой ноги — «не искала», а не «нас нет»; прогон, где не ответил никто,
 * — красный.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } }));

import { KNOWLEDGE_QUESTION_RU } from '@/app/api/cron/model-knowledge-probe/route';
import {
  KNOWLEDGE_QUESTION_RU_SEARCH,
  TOPIC_QUESTION_EN,
  TOPIC_QUESTION_RU,
  WEST_AGENT_ID,
  WEST_LEGS,
  askWestLeg,
  chooseWestModels,
  markerOverrides,
  pickWestModel,
  readOpenRouterCatalog,
  renderWestSummary,
  runWestProbe,
  westProbeExitCode,
  type WestLegId,
  type WestLegSpec,
} from '@/lib/ai/west-probe';

// ── Подменённая сеть ────────────────────────────────────────────────────

interface Sent {
  url: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

type Reply = { status: number; body: unknown } | 'hang';

/** fetch, который отвечает по обработчику и записывает каждый запрос. */
function fakeFetch(handler: (sent: Sent, n: number) => Reply) {
  const sent: Sent[] = [];
  const impl = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const raw = typeof init?.body === 'string' ? init.body : null;
    const s: Sent = {
      url,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
    };
    sent.push(s);
    const reply = handler(s, sent.length);
    if (reply === 'hang') {
      // Висит, пока не оборвут: так ведёт себя настоящий fetch при обрыве.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status });
  });
  return { impl: impl as unknown as typeof fetch, sent };
}

/** Ответ OpenRouter в его форме: текст, аннотации url_citation, usage. */
function chatReply(opts: {
  text?: string | null;
  urls?: string[];
  model?: string;
  finish?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; reasoning?: number } | null;
}) {
  return {
    model: opts.model ?? 'openai/gpt-5.5-20261001',
    choices: [{
      finish_reason: opts.finish ?? 'stop',
      message: {
        role: 'assistant',
        content: opts.text === undefined ? 'ответ' : opts.text,
        annotations: (opts.urls ?? []).map((url) => ({
          type: 'url_citation',
          url_citation: { url, title: 'заголовок', content: '…', start_index: 0, end_index: 1 },
        })),
      },
    }],
    usage: opts.usage === null ? undefined : {
      prompt_tokens: opts.usage?.prompt_tokens ?? 120,
      completion_tokens: opts.usage?.completion_tokens ?? 340,
      ...(opts.usage?.reasoning !== undefined ? { completion_tokens_details: { reasoning_tokens: opts.usage.reasoning } } : {}),
    },
  };
}

const leg = (id: WestLegId): WestLegSpec => {
  const l = WEST_LEGS.find((x) => x.id === id);
  if (!l) throw new Error(`ноги ${id} нет`);
  return l;
};

const KEY = 'sk-or-test';

// ── (а) Выбор модели ────────────────────────────────────────────────────

describe('выбор модели: сильнейшая общая модель вендора, не id из кода', () => {
  it('OpenAI: gpt-5.5, а не pro / mini / o4 / codex / oss / режим :batch', () => {
    const ids = [
      'openai/gpt-5.5-pro', 'openai/gpt-5.5-mini', 'openai/o4', 'openai/o4-mini', 'openai/gpt-5.4',
      'openai/gpt-5.5:batch', 'openai/gpt-oss-120b', 'openai/gpt-5.6-codex', 'openai/gpt-5.5',
      'openai/gpt-5.5-2026-08-01', 'x-ai/grok-9',
    ];
    expect(pickWestModel(ids, 'openai')).toBe('openai/gpt-5.5');
  });

  it('xAI: grok-4.6, а не grok-4.6-fast и не grok-4.20 (двузначный минор — 4.2, а не 6.0)', () => {
    const ids = ['x-ai/grok-4.6-fast', 'x-ai/grok-code-fast-1', 'x-ai/grok-3-mini', 'x-ai/grok-4.20', 'x-ai/grok-4.6', 'openai/gpt-9'];
    expect(pickWestModel(ids, 'xai')).toBe('x-ai/grok-4.6');
  });

  it('срез настоящего каталога OpenRouter 16.10: gpt-6.1-sol и grok-4.7', () => {
    const ids = [
      'openai/gpt-6.1-sol-pro', 'openai/gpt-6.1-sol', 'openai/gpt-6.1-sol:batch', 'openai/gpt-6-luna', 'openai/gpt-6-sol',
      'openai/gpt-6-astra', 'openai/gpt-chat-latest', 'openai/gpt-5.5', 'openai/o3-pro', 'openai/gpt-5.4-image-2',
      'x-ai/grok-4.7', 'x-ai/grok-4.6', 'x-ai/grok-4.5', 'x-ai/grok-build-0.1', 'x-ai/grok-4.3', 'x-ai/grok-4.3:batch',
      'x-ai/grok-4.20-multi-agent', 'x-ai/grok-4.20',
    ];
    expect(pickWestModel(ids, 'openai')).toBe('openai/gpt-6.1-sol');
    expect(pickWestModel(ids, 'xai')).toBe('x-ai/grok-4.7');
  });

  it('при равной версии — более короткий id', () => {
    expect(pickWestModel(['openai/gpt-5.5-chat', 'openai/gpt-5.5'], 'openai')).toBe('openai/gpt-5.5');
  });

  it('пустой список — null, и выбор называет причину', () => {
    expect(pickWestModel([], 'openai')).toBeNull();
    const none = chooseWestModels({ ok: true, ids: ['google/gemini-3'] });
    expect(none.openai.model).toBeNull();
    expect(none.openai.reason).toMatch(/нет ни одного id с префиксом openai\//);
    const filtered = chooseWestModels({ ok: true, ids: ['x-ai/grok-4.6-fast'] });
    expect(filtered.xai.model).toBeNull();
    expect(filtered.xai.reason).toMatch(/подходящей общей модели среди них нет/);
  });

  it('каталог не прочитан — модели нет, причина названа', () => {
    const r = chooseWestModels({ ok: false, reason: 'HTTP 503 упал' });
    expect(r.openai.model).toBeNull();
    expect(r.openai.reason).toBe('каталог OpenRouter не прочитан: HTTP 503 упал');
  });

  it('маркер сильнее каталога — и при прочитанном каталоге, и при упавшем', () => {
    const ids = ['openai/gpt-6.1-sol', 'openai/gpt-chat-latest', 'x-ai/grok-4.7'];
    const r = chooseWestModels({ ok: true, ids }, { openai: 'openai/gpt-chat-latest' });
    expect(r.openai).toMatchObject({ model: 'openai/gpt-chat-latest', source: 'override', note: null });
    expect(r.xai).toMatchObject({ model: 'x-ai/grok-4.7', source: 'catalog' });
    const unknown = chooseWestModels({ ok: true, ids }, { xai: 'x-ai/grok-9' });
    expect(unknown.xai.model).toBe('x-ai/grok-9');
    expect(unknown.xai.note).toMatch(/такого id нет/);
    const offline = chooseWestModels({ ok: false, reason: 'сеть' }, { openai: 'openai/gpt-5.5' });
    expect(offline.openai.model).toBe('openai/gpt-5.5');
    expect(offline.xai.model).toBeNull();
  });

  it('модели маркера читаются только строками', () => {
    expect(markerOverrides({ models: { openai: ' openai/gpt-5.5 ', xai: 'x-ai/grok-4.7' } }).overrides)
      .toEqual({ openai: 'openai/gpt-5.5', xai: 'x-ai/grok-4.7' });
    const bad = markerOverrides({ models: { openai: 5 } });
    expect(bad.overrides).toEqual({});
    expect(bad.problems[0]).toMatch(/не строка/);
    expect(markerOverrides({ run: 1 }).overrides).toEqual({});
    expect(markerOverrides(null).problems).toEqual([]);
  });

  it('каталог: 200 — список id; не 200 и пустой список — отказ, а не «моделей нет»', async () => {
    const ok = fakeFetch(() => ({ status: 200, body: { data: [{ id: 'openai/gpt-5.5' }, { id: 'x-ai/grok-4.7' }] } }));
    expect(await readOpenRouterCatalog(ok.impl)).toEqual({ ok: true, ids: ['openai/gpt-5.5', 'x-ai/grok-4.7'] });
    expect(ok.sent[0].url).toBe('https://openrouter.ai/api/v1/models');
    const down = fakeFetch(() => ({ status: 503, body: 'upstream down' }));
    expect(await readOpenRouterCatalog(down.impl)).toEqual({ ok: false, reason: 'HTTP 503 upstream down' });
    const empty = fakeFetch(() => ({ status: 200, body: { data: [] } }));
    expect((await readOpenRouterCatalog(empty.impl)).ok).toBe(false);
  });
});

// ── (б) Один вопрос одной модели ────────────────────────────────────────

describe('вопрос с поиском: что уходит в запрос и что возвращается исходом', () => {
  it('200 с источниками: vedarai.ru среди них — «знает», домены разобраны, запрос по контракту', async () => {
    const net = fakeFetch(() => ({
      status: 200,
      body: chatReply({
        text: 'Свободные места смотрите на сайтах туроператоров; обстановку — у КВЕРТ.',
        urls: ['https://www.kscnet.ru/ivs/kvert/', 'https://vedarai.ru/catalog', 'https://www.kscnet.ru/other'],
      }),
    }));
    const r = await askWestLeg('openai', 'openai/gpt-5.5', leg('topic-search-ru'), { fetchImpl: net.impl, apiKey: KEY });
    expect(r.outcome).toBe('knows');
    expect(r.ours_in_sources).toBe(true);
    expect(r.domains).toEqual(['kscnet.ru', 'vedarai.ru']);
    expect(r.sources).toBe(3);
    expect(r.search_count).toBeNull();
    expect(r.engine).toBe('native');
    expect(r.reason).toBeNull();
    expect(r.usage).toEqual({ model: 'openai/gpt-5.5-20261001', prompt_tokens: 120, completion_tokens: 340 });

    expect(net.sent).toHaveLength(1);
    const { url, body, headers } = net.sent[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(body).toMatchObject({
      model: 'openai/gpt-5.5',
      max_tokens: 900,
      temperature: 0.2,
      plugins: [{ id: 'web', engine: 'native', max_results: 8 }],
      messages: [{ role: 'user', content: TOPIC_QUESTION_RU }],
    });
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(headers['X-Title']).toMatch(/west knowledge probe/);
    expect(headers['HTTP-Referer']).toMatch(/^https:\/\/vedarai\.ru/);
  });

  it('искала, нас нет: источники пришли, нашего домена и имени нет — «не знает»', async () => {
    const net = fakeFetch(() => ({ status: 200, body: chatReply({ text: 'Смотрите kamchatka.travel', urls: ['https://kamchatka.travel/'] }) }));
    const r = await askWestLeg('xai', 'x-ai/grok-4.7', leg('topic-search-en'), { fetchImpl: net.impl, apiKey: KEY });
    expect(r.outcome).toBe('does_not_know');
    expect(r.ours_in_sources).toBe(false);
  });

  it('ответ без единого источника — «не искала», а не «нас нет»', async () => {
    const net = fakeFetch(() => ({ status: 200, body: chatReply({ text: 'Не знаю такого сайта.', urls: [] }) }));
    const r = await askWestLeg('openai', 'openai/gpt-5.5', leg('brand-search'), { fetchImpl: net.impl, apiKey: KEY });
    expect(r.outcome).toBe('did_not_search');
  });

  it('400 «engine not supported» — один повтор без движка, движок записан', async () => {
    const net = fakeFetch((_s, n) => (n === 1
      ? { status: 400, body: { error: { code: 400, message: 'Web search engine "native" is not supported for this model' } } }
      : { status: 200, body: chatReply({ text: 'Сайт о Камчатке', urls: ['https://vedarai.ru/'] }) }));
    const r = await askWestLeg('xai', 'x-ai/grok-4.7', leg('brand-search'), { fetchImpl: net.impl, apiKey: KEY });
    expect(net.sent).toHaveLength(2);
    expect(net.sent[0].body?.plugins).toEqual([{ id: 'web', engine: 'native', max_results: 8 }]);
    expect(net.sent[1].body?.plugins).toEqual([{ id: 'web', max_results: 8 }]);
    expect(r.engine).toBe('default');
    expect(r.engine_note).toMatch(/HTTP 400/);
    expect(r.outcome).toBe('knows');
  });

  it('400 не про движок — повтора нет, «спросить не удалось» с телом отказа', async () => {
    const net = fakeFetch(() => ({ status: 400, body: { error: { message: 'x-ai/grok-9 is not a valid model ID' } } }));
    const r = await askWestLeg('xai', 'x-ai/grok-9', leg('topic-search-ru'), { fetchImpl: net.impl, apiKey: KEY });
    expect(net.sent).toHaveLength(1);
    expect(r.outcome).toBe('could_not_ask');
    expect(r.reason).toMatch(/^HTTP 400: .*not a valid model ID/);
  });

  it('500 — «спросить не удалось» с кодом, не «не знает»', async () => {
    const net = fakeFetch(() => ({ status: 500, body: 'Internal Server Error' }));
    const r = await askWestLeg('openai', 'openai/gpt-5.5', leg('brand-search'), { fetchImpl: net.impl, apiKey: KEY });
    expect(r.outcome).toBe('could_not_ask');
    expect(r.reason).toBe('HTTP 500: Internal Server Error');
    expect(r.usage).toBeNull();
    expect(net.sent).toHaveLength(1);
  });

  it('таймаут — «спросить не удалось», запрос оборван', async () => {
    const net = fakeFetch(() => 'hang');
    const r = await askWestLeg('openai', 'openai/gpt-5.5', leg('brand'), { fetchImpl: net.impl, apiKey: KEY, timeoutMs: 30 });
    expect(r.outcome).toBe('could_not_ask');
    expect(r.reason).toMatch(/^таймаут/);
  });

  it('сеть не дошла — «спросить не удалось» с причиной', async () => {
    const impl = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const r = await askWestLeg('openai', 'openai/gpt-5.5', leg('brand'), { fetchImpl: impl, apiKey: KEY });
    expect(r.outcome).toBe('could_not_ask');
    expect(r.reason).toBe('сеть: fetch failed');
  });

  it('нет ключа или нет модели — в сеть не ходим, причина названа', async () => {
    const net = fakeFetch(() => ({ status: 200, body: chatReply({}) }));
    const noKey = await askWestLeg('openai', 'openai/gpt-5.5', leg('brand'), { fetchImpl: net.impl, apiKey: undefined });
    expect(noKey.outcome).toBe('could_not_ask');
    expect(noKey.reason).toMatch(/OPENROUTER_API_KEY не задан/);
    const noModel = await askWestLeg('xai', null, leg('brand'), { fetchImpl: net.impl, apiKey: KEY }, 'каталог OpenRouter не прочитан: сеть');
    expect(noModel.reason).toBe('каталог OpenRouter не прочитан: сеть');
    expect(net.sent).toHaveLength(0);
  });

  it('пустой текст при 200 (потолок ушёл на рассуждение) — «спросить не удалось», токены всё равно в книги', async () => {
    const net = fakeFetch(() => ({
      status: 200,
      body: chatReply({ text: '', finish: 'length', usage: { prompt_tokens: 80, completion_tokens: 900, reasoning: 900 } }),
    }));
    const r = await askWestLeg('xai', 'x-ai/grok-4.7', leg('brand'), { fetchImpl: net.impl, apiKey: KEY });
    expect(r.outcome).toBe('could_not_ask');
    expect(r.reason).toMatch(/finish_reason length, на рассуждение ушло 900 из 900/);
    expect(r.usage?.completion_tokens).toBe(900);
  });

  it('ошибка в теле ответа 200 — «спросить не удалось», а не пустой ответ модели', async () => {
    const net = fakeFetch(() => ({ status: 200, body: { error: { code: 502, message: 'Provider returned error' } } }));
    const r = await askWestLeg('openai', 'openai/gpt-5.5', leg('brand'), { fetchImpl: net.impl, apiKey: KEY });
    expect(r.outcome).toBe('could_not_ask');
    expect(r.reason).toMatch(/ошибка в теле ответа 200: 502 Provider returned error/);
  });
});

describe('вопрос без поиска', () => {
  it('без плагина; назвала Камчатку сама — «знает», сказала «не знаю» — «не знает»', async () => {
    const knows = fakeFetch(() => ({ status: 200, body: chatReply({ text: 'Это платформа для туристов на Камчатке.' }) }));
    const a = await askWestLeg('openai', 'openai/gpt-5.5', leg('brand'), { fetchImpl: knows.impl, apiKey: KEY });
    expect(a.outcome).toBe('knows');
    expect(a.engine).toBeNull();
    expect(knows.sent[0].body).not.toHaveProperty('plugins');
    expect(knows.sent[0].body?.messages).toEqual([{ role: 'user', content: KNOWLEDGE_QUESTION_RU }]);

    const not = fakeFetch(() => ({ status: 200, body: chatReply({ text: 'Не знаю.' }) }));
    const b = await askWestLeg('xai', 'x-ai/grok-4.7', leg('brand'), { fetchImpl: not.impl, apiKey: KEY });
    expect(b.outcome).toBe('does_not_know');
  });
});

describe('вопросы: о сайте — без края, по теме — без нас', () => {
  const brand = /vedar|ведар|维达尔/i;
  const region = /камчат|kamchat/i;

  it('о сайте: адрес есть, «Камчатки» нет; первая нога — тот же вопрос, что у пробы с прода', () => {
    expect(leg('brand').question).toBe(KNOWLEDGE_QUESTION_RU);
    for (const q of [KNOWLEDGE_QUESTION_RU, KNOWLEDGE_QUESTION_RU_SEARCH]) {
      expect(q).toContain('vedarai.ru');
      expect(q).not.toMatch(region);
    }
  });

  it('по теме: край назван, нашего адреса и имени нет ни в каком написании', () => {
    for (const q of [TOPIC_QUESTION_RU, TOPIC_QUESTION_EN]) {
      expect(q).toMatch(region);
      expect(q).not.toMatch(brand);
    }
  });

  it('четыре ноги: одна без поиска, три с поиском', () => {
    expect(WEST_LEGS.map((l) => [l.id, l.search, l.mention])).toEqual([
      ['brand', false, null],
      ['brand-search', true, 'region'],
      ['topic-search-ru', true, 'brand'],
      ['topic-search-en', true, 'brand'],
    ]);
  });
});

// ── (в) Прогон целиком и код выхода ─────────────────────────────────────

const CATALOG = { status: 200, body: { data: [{ id: 'openai/gpt-5.5' }, { id: 'openai/gpt-5.5-pro' }, { id: 'x-ai/grok-4.7' }] } };

describe('прогон: красный только когда не ответил никто', () => {
  it('код выхода на исходах', () => {
    expect(westProbeExitCode([])).toBe(1);
    expect(westProbeExitCode([{ outcome: 'could_not_ask' }, { outcome: 'could_not_ask' }])).toBe(1);
    expect(westProbeExitCode([{ outcome: 'could_not_ask' }, { outcome: 'does_not_know' }])).toBe(0);
    expect(westProbeExitCode([{ outcome: 'did_not_search' }])).toBe(0);
  });

  it('все ноги 500 — замера нет, код 1, книгам писать нечего', async () => {
    const net = fakeFetch((s) => (s.url.endsWith('/models') ? CATALOG : { status: 500, body: 'boom' }));
    const r = await runWestProbe({ fetchImpl: net.impl, apiKey: KEY });
    expect(r.legs).toHaveLength(8);
    expect(r.legs.every((l) => l.outcome === 'could_not_ask')).toBe(true);
    expect(r.exit_code).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ни одну модель спросить не удалось/);
    expect(r.usage_rows).toEqual([]);
  });

  it('OpenAI ответил, xAI нет — замер есть, код 0, в книги — только ответившие, с agent_id', async () => {
    const net = fakeFetch((s) => {
      if (s.url.endsWith('/models')) return CATALOG;
      return s.body?.model === 'openai/gpt-5.5'
        ? { status: 200, body: chatReply({ text: 'Не знаю.', urls: ['https://kamchatka.travel/'], usage: { prompt_tokens: 10, completion_tokens: 20 } }) }
        : { status: 503, body: 'no capacity' };
    });
    const r = await runWestProbe({ fetchImpl: net.impl, apiKey: KEY, now: () => new Date('2026-10-16T00:00:00Z') });
    expect(r.models.openai.model).toBe('openai/gpt-5.5');
    expect(r.models.xai.model).toBe('x-ai/grok-4.7');
    expect(r.exit_code).toBe(0);
    expect(r.summary.could_not_ask).toEqual(['xai/brand', 'xai/brand-search', 'xai/topic-search-ru', 'xai/topic-search-en']);
    expect(r.usage_rows).toHaveLength(4);
    expect(r.usage_rows.every((u) => u.agent_id === WEST_AGENT_ID && u.prompt_tokens === 10 && u.completion_tokens === 20)).toBe(true);
    expect(r.asked_at).toBe('2026-10-16T00:00:00.000Z');
  });

  it('нет ключа — ни одного вопроса в сеть, код 1', async () => {
    const net = fakeFetch((s) => (s.url.endsWith('/models') ? CATALOG : { status: 200, body: chatReply({}) }));
    const r = await runWestProbe({ fetchImpl: net.impl, apiKey: undefined });
    expect(net.sent.filter((s) => s.url.endsWith('/chat/completions'))).toHaveLength(0);
    expect(r.exit_code).toBe(1);
  });

  it('сводка: строка на ногу, чужой текст не ломает таблицу', async () => {
    const net = fakeFetch((s) => (s.url.endsWith('/models')
      ? CATALOG
      : { status: 200, body: chatReply({ text: 'a | b\nc', urls: ['https://kamchatka.travel/'] }) }));
    const md = renderWestSummary(await runWestProbe({ fetchImpl: net.impl, apiKey: KEY }));
    const rows = md.split('\n').filter((l) => l.startsWith('| openai') || l.startsWith('| xai'));
    expect(rows).toHaveLength(8);
    expect(rows[0]).toContain('a \\| b c');
    expect(md).toContain('openai/gpt-5.5 (сильнейшая из каталога)');
  });
});
