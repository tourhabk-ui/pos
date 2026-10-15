// @vitest-environment node
/**
 * Сторож внесения в каталог MCP ModelScope (魔搭 MCP广场) — находка аудита
 * 15.10, CN-modelscope.
 *
 * Заявка подана 14.10 формой без аккаунта; проверять внесение было нечем,
 * кроме страницы каталога, которая ставит наше имя в <title> для любого
 * адреса. Проверка — открытый API каталога (lib/mcp/modelscope-listing.ts).
 *
 * Судится поведение: функция зовётся с подменённым fetch на трёх ответах
 * каталога — внесены, не внесены, контроль мёртв — и на отказах по дороге.
 * Главное, что держится (§4.0): ноль по «vedar» без живого контрольного
 * поиска — «не смог проверить», а не «нас нет»; и GET по угаданному id как
 * доказательство отсутствия не делается вовсе.
 *
 * Ответы ниже — по форме настоящих ответов API 15.10 (поиск «amap» —
 * total_count 13; карточка @amap/amap-maps — is_hosted, server_config).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  checkModelScopeListing,
  reportModelScopeListing,
  renderModelScopeSummary,
  cardUrl,
  MODELSCOPE_SERVERS_API,
  type FetchLike,
} from '@/lib/mcp/modelscope-listing';

interface Call { method: string; url: string; body: unknown }

type Answer = { status: number; body: unknown } | Error;

function searchAnswer(total: number, items: Array<Record<string, unknown>> = []): Answer {
  return { status: 200, body: { success: true, request_id: 'r', data: { mcp_server_list: items, total_count: total } } };
}

const OUR_ITEM = {
  id: 'vedar/vedar-kamchatka',
  publisher: 'vedar/vedar-kamchatka',
  name: 'Vedar（维达尔）— 堪察加旅游平台',
  chinese_name: 'Vedar（维达尔）— 堪察加旅游平台',
  locales: { en: { name: 'vedar-kamchatka' } },
};

const OUR_CONFIG = [{ mcpServers: { vedar: { type: 'streamable_http', url: 'https://vedarai.ru/api/mcp' } } }];

function cardAnswer(isHosted: unknown): Answer {
  return { status: 200, body: { success: true, data: { id: OUR_ITEM.id, is_hosted: isHosted, server_config: OUR_CONFIG } } };
}

/**
 * Подменённый каталог: поиск отвечает по слову запроса, карточка — по адресу.
 * Всё, что не предусмотрено, — 404, как у настоящего API на неизвестный путь.
 */
function fakeCatalog(answers: { search: Record<string, Answer>; cards?: Record<string, Answer> }) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = init.body !== undefined ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method: init.method, url, body });
    let a: Answer | undefined;
    if (init.method === 'PUT' && url === MODELSCOPE_SERVERS_API) {
      const q = (body as { search?: string } | undefined)?.search ?? '';
      a = answers.search[q];
    } else if (init.method === 'GET') {
      a = answers.cards?.[url];
    }
    if (a instanceof Error) throw a;
    const ans = a ?? { status: 404, body: '404 page not found' };
    const text = typeof ans.body === 'string' ? ans.body : JSON.stringify(ans.body);
    return { ok: ans.status >= 200 && ans.status < 300, status: ans.status, text: async () => text };
  };
  return { fetchImpl, calls };
}

describe('ModelScope: три исхода внесения', () => {
  it('внесены: id берётся из ответа поиска, карточка читается по нему, режим хостинга', async () => {
    const { fetchImpl, calls } = fakeCatalog({
      search: { vedar: searchAnswer(1, [OUR_ITEM]) },
      cards: { [`${MODELSCOPE_SERVERS_API}/vedar/vedar-kamchatka`]: cardAnswer(true) },
    });
    const r = await checkModelScopeListing(fetchImpl);
    expect(r).toEqual({
      outcome: 'listed',
      id: 'vedar/vedar-kamchatka',
      alsoFound: [],
      card: { isHosted: true, serverConfig: OUR_CONFIG, serverUrls: ['https://vedarai.ru/api/mcp'] },
      cardError: null,
    });
    // Запрос поиска — ровно тот, что найден разведкой: PUT с полем search.
    expect(calls[0]).toEqual({
      method: 'PUT',
      url: 'https://www.modelscope.cn/openapi/v1/mcp/servers',
      body: { search: 'vedar', page_number: 1, page_size: 10 },
    });
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'GET']);

    const rep = reportModelScopeListing(r);
    expect(rep.exitCode).toBe(0);
    expect(rep.annotation).toMatch(/^::notice::/);
    const md = renderModelScopeSummary(rep);
    expect(md).toContain('vedar/vedar-kamchatka');
    expect(md).toContain('https://vedarai.ru/api/mcp');
  });

  it('внесены только показом (仅分发展示): зелёный, но с предупреждением про Cherry Studio и Kimi', async () => {
    const { fetchImpl } = fakeCatalog({
      search: { vedar: searchAnswer(1, [OUR_ITEM]) },
      cards: { [`${MODELSCOPE_SERVERS_API}/vedar/vedar-kamchatka`]: cardAnswer(false) },
    });
    const r = await checkModelScopeListing(fetchImpl);
    expect(r.outcome).toBe('listed');
    const rep = reportModelScopeListing(r);
    expect(rep.exitCode).toBe(0);
    expect(rep.annotation).toMatch(/^::warning::/);
    expect(rep.annotation).toContain('Cherry Studio');
  });

  it('внесены, но карточка не прочиталась: внесение — факт, режим — «не знаю», а не «хостинг»', async () => {
    const { fetchImpl } = fakeCatalog({
      search: { vedar: searchAnswer(1, [OUR_ITEM]) },
      cards: { [`${MODELSCOPE_SERVERS_API}/vedar/vedar-kamchatka`]: { status: 502, body: 'Bad Gateway' } },
    });
    const r = await checkModelScopeListing(fetchImpl);
    expect(r.outcome).toBe('listed');
    if (r.outcome !== 'listed') return;
    expect(r.card).toBeNull();
    expect(r.cardError).toContain('HTTP 502');
    const rep = reportModelScopeListing(r);
    expect(rep.exitCode).toBe(0);
    expect(rep.annotation).toMatch(/^::warning::/);
    expect(rep.annotation).not.toContain('режим хостинга');
  });

  it('не внесены: ноль по «vedar» при живом контроле — красный «нас нет», и ни одного GET по догадке', async () => {
    const { fetchImpl, calls } = fakeCatalog({
      search: { vedar: searchAnswer(0), amap: searchAnswer(13, [{ id: '@amap/amap-maps', name: '高德地图' }]) },
    });
    const r = await checkModelScopeListing(fetchImpl);
    expect(r).toEqual({ outcome: 'not_listed', controlTotal: 13 });
    expect(calls.map((c) => [c.method, (c.body as { search?: string } | undefined)?.search])).toEqual([
      ['PUT', 'vedar'],
      ['PUT', 'amap'],
    ]);
    const rep = reportModelScopeListing(r);
    expect(rep.exitCode).toBe(1);
    expect(rep.annotation).toMatch(/^::error::/);
  });

  it('контроль мёртв: ноль и у «amap» — «не смог проверить», а не «нас нет»', async () => {
    const { fetchImpl } = fakeCatalog({ search: { vedar: searchAnswer(0), amap: searchAnswer(0) } });
    const r = await checkModelScopeListing(fetchImpl);
    expect(r.outcome).toBe('unknown');
    const rep = reportModelScopeListing(r);
    expect(rep.exitCode).toBe(1);
    expect(rep.annotation).toMatch(/^::warning::/);
    expect(rep.annotation).not.toMatch(/нас в каталоге нет/);
  });
});

describe('ModelScope: отказы по дороге — «не смог», с причиной', () => {
  it('контроль не ответил (HTTP 502)', async () => {
    const { fetchImpl } = fakeCatalog({ search: { vedar: searchAnswer(0), amap: { status: 502, body: 'Bad Gateway' } } });
    const r = await checkModelScopeListing(fetchImpl);
    expect(r.outcome).toBe('unknown');
    if (r.outcome === 'unknown') expect(r.reason).toContain('HTTP 502');
  });

  it('поиск по нам упал сетью', async () => {
    const { fetchImpl, calls } = fakeCatalog({ search: { vedar: new Error('ECONNRESET') } });
    const r = await checkModelScopeListing(fetchImpl);
    expect(r.outcome).toBe('unknown');
    if (r.outcome === 'unknown') expect(r.reason).toContain('ECONNRESET');
    expect(calls.some((c) => c.method === 'GET')).toBe(false);
  });

  it('ответ не той формы (нет total_count) — не ноль, а отказ', async () => {
    const { fetchImpl } = fakeCatalog({
      search: { vedar: { status: 200, body: { success: true, data: { mcp_server_list: [] } } } },
    });
    const r = await checkModelScopeListing(fetchImpl);
    expect(r.outcome).toBe('unknown');
  });

  it('success: false — отказ, даже при HTTP 200', async () => {
    const { fetchImpl } = fakeCatalog({
      search: { vedar: { status: 200, body: { success: false, data: { mcp_server_list: [], total_count: 0 } } } },
    });
    expect((await checkModelScopeListing(fetchImpl)).outcome).toBe('unknown');
  });

  it('поиск что-то нашёл, но не нас — разобрать глазами, а не «внесены»', async () => {
    const { fetchImpl, calls } = fakeCatalog({
      search: { vedar: searchAnswer(1, [{ id: 'someone/veda-notes', name: 'Veda Notes' }]) },
    });
    const r = await checkModelScopeListing(fetchImpl);
    expect(r.outcome).toBe('unknown');
    if (r.outcome === 'unknown') expect(r.reason).toContain('someone/veda-notes');
    expect(calls.some((c) => c.method === 'GET')).toBe(false);
  });

  it('причина с переводом строки не рвёт команду workflow', () => {
    const rep = reportModelScopeListing({ outcome: 'unknown', reason: 'строка 1\nстрока 2 100%' });
    expect(rep.annotation).not.toContain('\n');
    expect(rep.annotation).toContain('%0A');
    expect(rep.annotation).toContain('100%25');
  });

  it('id с косой чертой и @ — в адресе карточки сегменты кодируются, черта остаётся', () => {
    expect(cardUrl('@amap/amap-maps')).toBe(`${MODELSCOPE_SERVERS_API}/%40amap/amap-maps`);
  });
});

describe('workflow проверки: маркер и ручной запуск, без расписания', () => {
  // Конфиг судится по смыслу (разобранный YAML), не по форме строки.
  const requireCjs = createRequire(import.meta.url);
  const { load } = requireCjs('js-yaml') as { load: (src: string) => unknown };
  const wf = load(readFileSync(join(process.cwd(), '.github/workflows/modelscope-listing.yml'), 'utf-8')) as {
    on: Record<string, unknown>;
    jobs: Record<string, { steps: Array<{ run?: string }> }>;
  };

  it('нового расписания нет: планировщик GitHub душит очередь по их числу (CLAUDE.md §8)', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['push', 'workflow_dispatch']);
    const push = wf.on.push as { branches: string[]; paths: string[] };
    expect(push.branches).toEqual(['main']);
    expect(push.paths).toEqual(['.github/triggers/modelscope-listing.json']);
  });

  it('шаг зовёт скрипт проверки', () => {
    const runs = Object.values(wf.jobs).flatMap((j) => j.steps.map((s) => s.run ?? ''));
    expect(runs.some((r) => r.includes('scripts/modelscope-listing-check.ts'))).toBe(true);
  });
});
