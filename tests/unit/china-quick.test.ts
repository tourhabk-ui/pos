/**
 * Китайский контур, быстрые правки из репозитория (аудит 15.10, CN-quick;
 * карт-бланш владельца 15.10). Всё судится вызовом и данными, не текстом
 * исходника (CLAUDE.md §4); экран /zh — рендером в zh-quick.test.tsx.
 *
 * ── Что держится ──────────────────────────────────────────────────────────
 *
 * 1. Перепись краулеров видит китайский вход: /zh и /sitemap.xml пишутся
 *    счётчиком по семейству, люди на /zh — нет (их считает page_views);
 *    всё под /zh — одной меткой /zh/*; перепись больше не называет sitemap
 *    несчитаемым.
 * 2. Content-Language: zh-CN — заголовком на /zh и /zh/<…> и только там
 *    (сопоставлением путей тем же матчером, что у Next).
 * 3. IndexNow для /zh: роут indexnow-plans шлёт и китайские страницы из
 *    lib/zh/pages, итог — в ai_actions_log с адресами и источником; sitemap
 *    берёт /zh из того же списка.
 * 4. Свои пробы моста отдельно от спроса КНР: workflow задаёт мосту имя
 *    vedar-mcp-bridge-probe, мост собирает из него имя клиента, журнал
 *    относит его к проверкам; имя по умолчанию — спрос.
 * 5. Перепись A2A: только чтение, под CRON_SECRET, три исхода, регион КНР/РФ,
 *    внешние отдельно от своих, проверок реестра и проб.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('@/lib/database', () => ({ query: vi.fn(async () => ({ rows: [] })) }));

import { pool } from '@/lib/db-pool';
import { query as dbQuery } from '@/lib/database';
import {
  AGENT_ENTRY_PATHS, recordAgentEntryHit, recordZhEntryHit, zhEntryPath,
} from '@/lib/analytics/agent-entry-hits';
import { GET as sitemapGET } from '@/app/sitemap.xml/route';
import { collectSitemapEntriesWithStatus } from '@/lib/seo/sitemap-entries';
import { NOT_COUNTED, GET as entryCensusGET } from '@/app/api/cron/agent-entry-census/route';
import { GET as a2aCensusGET, summarizeA2aAgents, readDays, type A2aCensusAgentRow } from '@/app/api/cron/a2a-census/route';
import { GET as indexnowGET, deployPageUrls } from '@/app/api/cron/indexnow-plans/route';
import { LOGGED_URLS_MAX, pingIndexNow } from '@/lib/seo/indexnow';
import { PLAN_PRESETS } from '@/lib/plans/presets';
import { ZH_CONTENT_LANGUAGE, ZH_PAGE_PATHS, zhPageUrls } from '@/lib/zh/pages';
import { isProbeClient } from '@/lib/mcp/probe-clients';
import { clientRegion, CHINA_REGION_LABEL } from '@/lib/mcp/china-clients';
import { RU_REGION_LABEL } from '@/lib/mcp/ru-clients';
import { MANUAL_ENDPOINTS } from '@/lib/agents/cron-schedulers';
import { CRON_CAPABILITIES } from '@/lib/agents/cron-capability-registry';
import { externalBinary } from '../helpers/external-binary';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const query = vi.mocked(pool.query);
const logQuery = vi.mocked(dbQuery);

const HUMAN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const BAIDU = 'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)';
const YISOU = 'Mozilla/5.0 (Linux; Android 10) YisouSpider/5.0 Safari/537.36';
const BYTE = 'Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)';

/** Параметры INSERT счётчика из вызовов pool.query: [путь, семейство]. */
const hits = () => query.mock.calls
  .filter(([sql]) => String(sql).includes('INSERT INTO agent_entry_hits'))
  .map(([, params]) => params as unknown[]);

beforeEach(() => {
  query.mockReset();
  query.mockImplementation(async () => ({ rows: [] }) as never);
  logQuery.mockReset();
  logQuery.mockImplementation(async () => ({ rows: [] }) as never);
  process.env.CRON_SECRET = 'test-secret';
});

describe('1. счётчик краулеров видит китайский вход', () => {
  it('/zh: обходчик по семейству считается, браузер человека — нет', () => {
    recordAgentEntryHit('/zh', HUMAN);
    expect(hits()).toEqual([]);
    recordAgentEntryHit('/zh', BAIDU);
    recordAgentEntryHit('/zh', YISOU);
    expect(hits()).toEqual([['/zh', 'baidu'], ['/zh', 'alibaba']]);
  });

  it('машинные файлы, как и раньше, считают всех — отсечка людей только у HTML', () => {
    recordAgentEntryHit('/robots.txt', HUMAN);
    recordAgentEntryHit('/sitemap.xml', HUMAN);
    expect(hits()).toEqual([['/robots.txt', 'browser'], ['/sitemap.xml', 'browser']]);
  });

  it('раздел /zh: сам /zh своей строкой, всё под ним — одной меткой /zh/*; чужой адрес не пишется чужой меткой', () => {
    expect(zhEntryPath('/zh')).toBe('/zh');
    expect(zhEntryPath('/zh/')).toBe('/zh');
    expect(zhEntryPath('/zh/tours/mestechko-dolina-geyzerov?x=1')).toBe('/zh/*');
    expect(zhEntryPath('/zhuk')).toBeNull();
    expect(zhEntryPath('/catalog')).toBeNull();
    recordZhEntryHit('/zh/places/avachinsky', BYTE);
    expect(hits()).toEqual([['/zh/*', 'bytedance']]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    recordZhEntryHit('/catalog', BYTE);
    expect(hits()).toHaveLength(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('[agent-entry-hits]'), '/catalog');
    err.mockRestore();
    // Метки входят в общий список, который читает перепись.
    for (const p of ['/zh', '/zh/*', '/sitemap.xml']) expect(AGENT_ENTRY_PATHS as readonly string[]).toContain(p);
  });

  it('sitemap.xml зовёт счётчик семейством того, кто пришёл, и отдаёт карту как прежде', async () => {
    const res = await sitemapGET(new Request('https://vedarai.ru/sitemap.xml', { headers: { 'user-agent': BAIDU } }));
    expect(res.status).toBe(200);
    expect(hits()).toEqual([['/sitemap.xml', 'baidu']]);
    expect(await res.text()).toContain('<loc>https://vedarai.ru/zh</loc>');
  });

  it('перепись: sitemap и /zh в счёте, люди на /zh названы несчитаемыми вслух', async () => {
    const res = await entryCensusGET(new NextRequest('http://localhost/api/cron/agent-entry-census', {
      headers: { authorization: 'Bearer test-secret' },
    }));
    const body = await res.json() as { counted_paths: string[]; not_counted: string[] };
    expect(body.counted_paths).toEqual(expect.arrayContaining(['/zh', '/zh/*', '/sitemap.xml']));
    expect(body.not_counted).not.toContain('/sitemap.xml');
    expect(NOT_COUNTED.join(' ')).toMatch(/люди на \/zh/);
  });

  it('карта сайта разрешает общий кэш — перепись называет, что видит только промахи, со сроком из заголовка', async () => {
    // Аудит 15.10, W3-china: счётчик стоит в роуте, и повтор, отданный кэшем
    // перед продом, до него не доходит. Малое число по /sitemap.xml нельзя
    // читать как «не ходят», пока перепись этого не говорит.
    const sm = await sitemapGET(new Request('https://vedarai.ru/sitemap.xml', { headers: { 'user-agent': BAIDU } }));
    const cc = (sm.headers.get('cache-control') ?? '').toLowerCase();
    const sMaxAge = /(?:^|,)\s*s-maxage=(\d+)/.exec(cc)?.[1] ?? null;
    const shared = /\bpublic\b/.test(cc) && !/no-store|private/.test(cc) && Number(sMaxAge) > 0;

    const res = await entryCensusGET(new NextRequest('http://localhost/api/cron/agent-entry-census', {
      headers: { authorization: 'Bearer test-secret' },
    }));
    const { not_counted } = await res.json() as { not_counted: string[] };
    const caveat = not_counted.find((c) => c.includes('/sitemap.xml') && /кэш/.test(c));

    if (shared) {
      expect(caveat, 'карта сайта кэшируема, а перепись молчит о промахах кэша').toBeDefined();
      expect(caveat).toContain(`s-maxage=${sMaxAge}`);
      expect(caveat).toMatch(/промахи кэша/);
      expect(caveat).toMatch(/не значит «не ходят»/);
    } else {
      // Карта больше не кэшируется общим кэшем — оговорка о ней стала бы неправдой.
      expect(caveat).toBeUndefined();
    }
    // Сегодня карта сайта кэшируема: ветка «молчит» не должна проходить незаметно.
    expect(shared).toBe(true);
  });
});

describe('2. Content-Language на китайском разделе', () => {
  // Тот же матчер и те же опции, что у Next для headers() (server/lib/router-utils/filesystem).
  const { getPathMatch } = require('next/dist/shared/lib/router/utils/path-match') as {
    getPathMatch: (source: string, opts: Record<string, unknown>) => (path: string) => false | object;
  };
  const config = require(join(ROOT, 'next.config.js')) as {
    headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>>;
  };

  async function contentLanguageFor(path: string): Promise<string[]> {
    const rules = await config.headers();
    return rules
      .filter((r) => getPathMatch(r.source, { strict: true, removeUnnamedParams: true })(path) !== false)
      .flatMap((r) => r.headers.filter((h) => h.key.toLowerCase() === 'content-language').map((h) => h.value));
  }

  it('/zh и /zh/<…> — ровно один zh-CN; соседние адреса без заголовка', async () => {
    expect(await contentLanguageFor('/zh')).toEqual([ZH_CONTENT_LANGUAGE]);
    expect(await contentLanguageFor('/zh/tours/mestechko-dolina-geyzerov')).toEqual([ZH_CONTENT_LANGUAGE]);
    for (const p of ['/', '/catalog', '/zhuk', '/operators/zh']) expect(await contentLanguageFor(p), p).toEqual([]);
  });

  it('корневой <html lang="ru"> не тронут — язык раздела объявлен заголовком и meta, не переездом layout', () => {
    expect(read('app/layout.tsx')).toMatch(/<html lang="ru"/);
  });
});

describe('3. IndexNow для /zh', () => {
  it('один список китайских страниц на sitemap и пинг', async () => {
    expect(ZH_PAGE_PATHS).toContain('/zh');
    expect(zhPageUrls('https://vedarai.ru/')).toEqual(ZH_PAGE_PATHS.map((p) => `https://vedarai.ru${p}`));
    const { entries } = await collectSitemapEntriesWithStatus();
    const urls = entries.map((e) => e.url);
    for (const u of zhPageUrls(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru')) expect(urls).toContain(u);
  });

  it('роут под секретом шлёт планы и /zh, IndexNow принял — итог с адресами и источником в ai_actions_log', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 202 }));
    try {
      const denied = await indexnowGET(new NextRequest('http://localhost/api/cron/indexnow-plans'));
      expect(denied.status).toBe(401);
      expect(fetchSpy).not.toHaveBeenCalled();

      const res = await indexnowGET(new NextRequest('http://localhost/api/cron/indexnow-plans', {
        headers: { authorization: 'Bearer test-secret' },
      }));
      expect(res.status).toBe(200);
      const body = await res.json() as { urls: string[]; groups: { plans: number; zh: number }; submitted: number };
      expect(body.groups).toEqual({ plans: PLAN_PRESETS.length + 1, zh: ZH_PAGE_PATHS.length });
      expect(body.urls.some((u) => u.endsWith('/zh'))).toBe(true);
      expect(body.submitted).toBe(PLAN_PRESETS.length + 1 + ZH_PAGE_PATHS.length);

      // Что ушло в IndexNow — то же, что в ответе.
      const sent = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body)) as { urlList: string[] };
      expect(sent.urlList).toEqual(body.urls);

      // Журнал называет адреса: на вопрос «пинговался ли /zh» отвечает он.
      const [sql, params] = logQuery.mock.calls[0] as unknown as [string, [string, string]];
      expect(sql).toMatch(/INSERT INTO ai_actions_log/);
      expect(params[0]).toBe('indexnow_ping');
      const meta = JSON.parse(params[1]) as { source: string; urls: string[]; submitted: number };
      expect(meta.source).toBe('indexnow-plans');
      expect(meta.urls.some((u) => u.endsWith('/zh'))).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('отказ IndexNow — тоже в журнал с адресами; длинный список — голова и число остальных', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad key', { status: 403 }));
    try {
      const many = Array.from({ length: LOGGED_URLS_MAX + 5 }, (_, i) => `/places/p${i}`);
      const r = await pingIndexNow(many);
      expect(r.ok).toBe(false);
      const [, params] = logQuery.mock.calls[0] as unknown as [string, [string, string]];
      expect(params[0]).toBe('indexnow_failed');
      const meta = JSON.parse(params[1]) as { urls: string[]; urls_more: number; source?: string };
      expect(meta.urls).toHaveLength(LOGGED_URLS_MAX);
      expect(meta.urls_more).toBe(5);
      expect(meta.source).toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('повторов в пинге нет', () => {
    const { all } = deployPageUrls('https://vedarai.ru');
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('4. пробы моста — проверки, а не спрос КНР', () => {
  /** Имя клиента, которое мост соберёт для провайдера при заданном окружении. */
  function bridgeClientName(provider: string, env: Record<string, string>): string {
    const code = [
      'import importlib.util, sys',
      `spec = importlib.util.spec_from_file_location("bridge", ${JSON.stringify(join(ROOT, 'integrations/vedar-mcp-bridge/vedar_mcp_bridge.py'))})`,
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      `sys.stdout.write(m.client_name(${JSON.stringify(provider)}))`,
    ].join('\n');
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'MCP_CLIENT_NAME'));
    return execFileSync('python3', ['-I', '-B', '-c', code], { env: { ...clean, ...env }, encoding: 'utf-8' });
  }

  // Без python3 тест прежде писал в лог и делал return — зелёный без
  // проверки (аудит 15.10, W3-china, §4.0). Теперь вне CI — пропуск с
  // причиной в имени, в CI — отказ (tests/helpers/external-binary).
  const PY = externalBinary('python3');

  it.skipIf(PY.skip)(PY.title('workflow задаёт мосту имя пробы, и журнал относит клиента к проверкам; без него — спрос'), () => {
    PY.require('имя клиента моста');
    const wf = read('.github/workflows/china-bridge-probe.yml');
    const base = /^\s*MCP_CLIENT_NAME:\s*(\S+)\s*$/m.exec(wf)?.[1];
    expect(base).toBe('vedar-mcp-bridge-probe');

    const probe = bridgeClientName('deepseek', { MCP_CLIENT_NAME: base as string });
    const people = bridgeClientName('deepseek', {});
    expect(probe).toBe('vedar-mcp-bridge-probe/deepseek');
    expect(isProbeClient(probe, null)).toBe(true);
    // Регион остаётся КНР: проба видна в группе КНР, но родом «проверка».
    expect(clientRegion(probe)).toBe(CHINA_REGION_LABEL);
    // Люди, скачавшие мост, — спрос.
    expect(people).toBe('vedar-mcp-bridge/deepseek');
    expect(isProbeClient(people, null)).toBe(false);
    // Пустое значение переменной — не пустое имя.
    expect(bridgeClientName('qwen', { MCP_CLIENT_NAME: '  ' })).toBe('vedar-mcp-bridge/qwen');
  });
});

describe('5. перепись A2A', () => {
  const row = (agent: string, ua_family: string, requests: number, is_self = false): A2aCensusAgentRow => ({
    agent, ua_family, is_self, requests, sends: requests, text_sends: requests, tool_sends: 0,
    completed: requests, rejected: 0, failed: 0, protocol_errors: 0, card_reads: 0, caller_days: 1,
    first_seen: '2026-10-15 10:00', last_seen: '2026-10-15 11:00',
  });
  const ROWS = [
    row('Qwen-Agent', 'other', 5),            // КНР, внешний
    row('deepseek-audit', 'other', 3),        // КНР, проба
    row('GigaChat', 'other', 2),              // РФ, внешний
    row('A2A-Registry-TaskProbe', 'other', 7),// проверка реестра
    row('curl', 'curl', 1),                   // проба по роду
    row('браузер', 'browser', 4, true),       // свой
  ];

  it('регион и род — одним правилом с админ-срезом; внешние отдельно от своих и проб', () => {
    const s = summarizeA2aAgents(ROWS);
    expect(s.window_total).toBe(22);
    expect(s.by_kind).toEqual({
      external: { agents: 2, requests: 7 },
      registry: { agents: 1, requests: 7 },
      probe: { agents: 2, requests: 4 },
      self: { agents: 1, requests: 4 },
    });
    expect(s.china.external).toEqual({ agents: 1, requests: 5 });
    expect(s.china.own_and_probes).toEqual({ agents: 1, requests: 3 });
    expect(s.china.names).toEqual(['Qwen-Agent (external, 5)', 'deepseek-audit (probe, 3)']);
    expect(s.ru.external).toEqual({ agents: 1, requests: 2 });
    expect(s.by_agent.find((a) => a.agent === 'GigaChat')?.region).toBe(RU_REGION_LABEL);
    expect(s.by_agent.find((a) => a.agent === 'A2A-Registry-TaskProbe')?.region).toBeNull();
  });

  it('без секрета — 500; чужой секрет — 401, база не тронута', async () => {
    delete process.env.CRON_SECRET;
    expect((await a2aCensusGET(new NextRequest('http://localhost/api/cron/a2a-census'))).status).toBe(500);
    process.env.CRON_SECRET = 'test-secret';
    const res = await a2aCensusGET(new NextRequest('http://localhost/api/cron/a2a-census', { headers: { authorization: 'Bearer nope' } }));
    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('данные: окно в параметре, только SELECT, ответ с регионами', async () => {
    query.mockImplementation((async (sql: string) => (String(sql).includes('GROUP BY agent')
      ? { rows: ROWS }
      : { rows: [{ since: '2026-10-12', total: 40 }] })) as never);
    const res = await a2aCensusGET(new NextRequest('http://localhost/api/cron/a2a-census?days=7', { headers: { authorization: 'Bearer test-secret' } }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; window_days: number; empty: boolean; china: { external: { requests: number } }; journal_since: string };
    expect(body).toMatchObject({ ok: true, window_days: 7, empty: false, journal_since: '2026-10-12' });
    expect(body.china.external.requests).toBe(5);
    for (const [sql, params] of query.mock.calls) {
      expect(String(sql).trimStart()).toMatch(/^SELECT/);
      if (params) expect(params).toEqual([7]);
    }
  });

  it('пустое окно — с датой начала журнала, а не «никто не ходит»; пустой журнал — своими словами', async () => {
    query.mockImplementation((async (sql: string) => (String(sql).includes('GROUP BY agent')
      ? { rows: [] }
      : { rows: [{ since: '2026-10-12', total: 40 }] })) as never);
    const body = await (await a2aCensusGET(new NextRequest('http://localhost/api/cron/a2a-census', { headers: { authorization: 'Bearer test-secret' } }))).json() as { empty: boolean; note: string };
    expect(body.empty).toBe(true);
    expect(body.note).toContain('2026-10-12');

    query.mockImplementation((async () => ({ rows: [] })) as never);
    const empty = await (await a2aCensusGET(new NextRequest('http://localhost/api/cron/a2a-census', { headers: { authorization: 'Bearer test-secret' } }))).json() as { note: string };
    expect(empty.note).toMatch(/пуст целиком/);
  });

  it('база не ответила — 503 и SQLSTATE в логе, а не пустой список', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockRejectedValue(Object.assign(new Error('relation "a2a_requests" does not exist'), { code: '42P01' }));
    const res = await a2aCensusGET(new NextRequest('http://localhost/api/cron/a2a-census', { headers: { authorization: 'Bearer test-secret' } }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('[a2a-census]'), 'SQLSTATE=42P01', expect.any(String));
    err.mockRestore();
  });

  it('окно 1..90, иначе 30; объявлена ручной и только читающей', () => {
    expect(readDays(null)).toBe(30);
    expect(readDays('90')).toBe(90);
    expect(readDays('0')).toBe(30);
    expect(readDays('91')).toBe(30);
    expect(MANUAL_ENDPOINTS['a2a-census']).toMatchObject({ kind: 'manual', writes: false });
    expect(CRON_CAPABILITIES['a2a-census']).toEqual(['db_read']);
    // Запрет: ни одного пишущего слова в роуте переписи.
    expect(read('app/api/cron/a2a-census/route.ts')).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });
});
