/**
 * Китайский слой для агентов и перепись краулеров (решение владельца 12.10:
 * «го» на вопрос «как нам сделать, чтоб китайские модели знали о нас»).
 *
 * ── Что держится ──────────────────────────────────────────────────────────
 *
 * 1. Один китайский текст (lib/mcp/zh-layer) стоит на всех трёх поверхностях
 *    обнаружения — llms.txt, манифест /.well-known/mcp.json (и страница /mcp),
 *    визитка A2A — и не утверждает ничего, чего нет в коде. Описания
 *    инструментов остаются без иероглифов (английская фраза плюс русское
 *    описание Кузьмича, сторож mcp-tool-descriptions-en).
 * 2. Китайские краулеры названы в robots явными группами и получают
 *    метаданные в <head> (htmlLimitedBots).
 * 3. Реестр семейств ботов один (lib/analytics/bot-detect), им же считает
 *    isBotUserAgent; «sogou» целиком не берётся — его носят и браузеры людей.
 * 4. Перепись входов для агентов: счётчик без UA и IP, пять входов, отказ
 *    базы не глушится; перепись читает и называет, чего не считает.
 * 5. Проба «знает ли модель о нас»: три исхода, вопрос без слова «Камчатка»,
 *    обёртки провайдеров без прямого `await callX`, workflow ждёт свою сборку.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  MCP_TITLE_ZH, MCP_DESCRIPTION_ZH, A2A_DESCRIPTION_ZH, A2A_CHAT_EXAMPLE_ZH, llmsSectionZh,
} from '@/lib/mcp/zh-layer';
import { PUBLIC_MCP_TOOLS } from '@/lib/mcp/public-tools';
import { buildAgentCard, buildLegacyAgentCard, CHAT_SKILL_ID } from '@/lib/a2a/agent-card';
import { BOT_FAMILIES, botFamily, isBotUserAgent } from '@/lib/analytics/bot-detect';
import { AGENT_ENTRY_PATHS, recordAgentEntryHit } from '@/lib/analytics/agent-entry-hits';
import { MANUAL_ENDPOINTS } from '@/lib/agents/cron-schedulers';
import { CRON_CAPABILITIES } from '@/lib/agents/cron-capability-registry';
import { classifyAnswer, summarize, KNOWLEDGE_QUESTION } from '@/app/api/cron/model-knowledge-probe/route';
import { readDays, NOT_COUNTED, CHINESE_FAMILIES } from '@/app/api/cron/agent-entry-census/route';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
import { pool } from '@/lib/db-pool';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const CJK = /[\u4e00-\u9fff]/;
const PHONE = /\+7 ?\d{3}|8 ?\(?\d{3}\)? ?\d{3}/;
const EMAIL = /@(mail\.ru|gmail\.com|yandex\.ru)/;
const BASE = 'https://vedarai.ru';

const query = vi.mocked(pool.query);

beforeEach(() => {
  query.mockReset();
  query.mockImplementation(async () => ({ rows: [] }) as never);
});

describe('китайский текст — один на все поверхности, без выдумки и ПД', () => {
  it('иероглифы, Камчатка, адрес, 112 — и ни телефона, ни почты', () => {
    for (const s of [MCP_TITLE_ZH, MCP_DESCRIPTION_ZH, A2A_DESCRIPTION_ZH, A2A_CHAT_EXAMPLE_ZH]) {
      expect(s).toMatch(CJK);
      expect(s).toMatch(/堪察加/);
      expect(s).not.toMatch(PHONE);
      expect(s).not.toMatch(EMAIL);
      expect(s).not.toMatch(/secret|token|password/i);
    }
    expect(MCP_DESCRIPTION_ZH).toContain('vedarai.ru');
    expect(MCP_DESCRIPTION_ZH).toContain('112');
    // Четыре записи — те же четыре инструмента, что в реестре, по именам.
    for (const t of ['create_lead', 'create_booking_request', 'create_stay_request', 'request_charter']) {
      expect(MCP_DESCRIPTION_ZH).toContain(t);
    }
    // Честно про язык данных: китайского поиска по турам не обещается.
    expect(MCP_DESCRIPTION_ZH).toMatch(/俄文/);
  });

  it('раздел llms.txt называет входы и те же факты о крае, что русский раздел', () => {
    const s = llmsSectionZh(BASE);
    expect(s).toMatch(/^## 中文说明/);
    for (const p of ['/api/mcp', '/.well-known/mcp.json', '/.well-known/agent-card.json', '/api/a2a']) {
      expect(s).toContain(`${BASE}${p}`);
    }
    const ru = read('app/llms.txt/route.ts');
    // 300+ вулканов, 29 действующих, ЮНЕСКО, UTC+12 — из русского раздела.
    expect(ru).toMatch(/300\+ вулканов, 29 действующих/);
    expect(s).toMatch(/300 多座火山（29 座活火山）/);
    expect(ru).toMatch(/UTC\+12/);
    expect(s).toMatch(/UTC\+12/);
    expect(s).toContain('112');
  });

  it('llms.txt печатает раздел целиком', async () => {
    const { GET } = await import('@/app/llms.txt/route');
    const text = await (await GET()).text();
    expect(text).toContain(llmsSectionZh(BASE));
    // Раздел стоит до динамических секций мест, а не в хвосте после контактов.
    expect(text.indexOf('## 中文说明')).toBeLessThan(text.indexOf('## Контакт и API'));
  });

  it('манифест несёт titleZh и descriptionZh, английские поля не тронуты', async () => {
    const { GET } = await import('@/app/.well-known/mcp.json/route');
    const json = await (await GET()).json();
    expect(json.titleZh).toBe(MCP_TITLE_ZH);
    expect(json.descriptionZh).toBe(MCP_DESCRIPTION_ZH);
    expect(json.descriptionEn).not.toMatch(CJK);
    expect(json.title).not.toMatch(CJK);
  });

  it('визитка A2A: описание заканчивается китайским хвостом, у навыка разговора есть китайский пример', () => {
    for (const card of [buildAgentCard(BASE), buildLegacyAgentCard(BASE)]) {
      expect(card.description.endsWith(A2A_DESCRIPTION_ZH)).toBe(true);
      // Русская и английская части не вытеснены.
      expect(card.description).toMatch(/подтверждает человек/);
      expect(card.description).toMatch(/no payment/);
      const chat = card.skills.find((s) => s.id === CHAT_SKILL_ID);
      expect(chat?.examples).toContain(A2A_CHAT_EXAMPLE_ZH);
    }
  });

  it('страница /mcp печатает китайский абзац с lang="zh-CN"', () => {
    const src = read('app/mcp/page.tsx');
    expect(src).toMatch(/lang="zh-CN"/);
    expect(src).toMatch(/\{MCP_TITLE_ZH\}。\{MCP_DESCRIPTION_ZH\}/);
  });

  it('описания инструментов без иероглифов: английский слой и Кузьмич не тронуты', () => {
    for (const t of PUBLIC_MCP_TOOLS) {
      expect(t.description, t.name).not.toMatch(CJK);
      expect(JSON.stringify(t.inputSchema), t.name).not.toMatch(CJK);
    }
  });
});

describe('китайские краулеры: robots и метаданные в <head>', () => {
  const robots = read('app/robots.ts');

  it('пять явных групп с общим DISALLOW; Bytespider был раньше', () => {
    for (const ua of ['Baiduspider', 'PetalBot', 'YisouSpider', 'Sogou web spider', '360Spider', 'Bytespider']) {
      expect(robots, ua).toMatch(new RegExp(`userAgent: '${ua}',\\n\\s+allow: \\['/', \\.\\.\\.PUBLIC_HUBS, \\.\\.\\.AGENT_ENTRYPOINTS\\],\\n\\s+disallow: DISALLOW,`));
    }
    // Один список запретов на все группы: новая группа «забыть» его не может.
    const groups = robots.match(/userAgent:/g)?.length ?? 0;
    expect(robots.match(/disallow: DISALLOW/g)?.length).toBe(groups);
  });

  it('htmlLimitedBots знает китайских обходчиков', () => {
    const cfg = read('next.config.js');
    const line = cfg.split('\n').find((l) => l.includes('htmlLimitedBots:')) ?? '';
    for (const bot of ['baiduspider', 'sogou', 'Bytespider', 'PetalBot', 'YisouSpider', '360Spider']) {
      expect(line, bot).toContain(`|${bot}|`);
    }
  });
});

describe('семейства ботов — один реестр', () => {
  it('китайские семейства опознаются по самоназваниям', () => {
    expect(botFamily('Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)')).toBe('baidu');
    expect(botFamily('Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)')).toBe('bytedance');
    expect(botFamily('Mozilla/5.0 (Linux; Android 7.0;) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)')).toBe('huawei');
    expect(botFamily('Mozilla/5.0 (compatible; YisouSpider/5.0)')).toBe('alibaba');
    expect(botFamily('Sogou web spider/4.0(+http://www.sogou.com/docs/help/webmasters.htm#07)')).toBe('tencent');
    expect(botFamily('Mozilla/5.0 (compatible; 360Spider; +http://webscan.360.cn)')).toBe('360');
    expect(botFamily('DeepSeekBot/1.0')).toBe('deepseek');
  });

  it('остальные семейства и четыре остатка: other-bot, tool, browser, none', () => {
    expect(botFamily('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe('google');
    expect(botFamily('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2)')).toBe('openai');
    expect(botFamily('Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)')).toBe('anthropic');
    expect(botFamily('Mozilla/5.0 (compatible; SomethingBot/1.0)')).toBe('other-bot');
    expect(botFamily('curl/8.5.0')).toBe('tool');
    expect(botFamily('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36')).toBe('browser');
    expect(botFamily('')).toBe('none');
    expect(botFamily(null)).toBe('none');
    expect(botFamily('okhttp/4.12')).toBe('unknown');
  });

  it('«sogou» целиком не маркер: браузер Sogou у человека — браузер, не бот', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114 Mobile Safari/537.36 SogouMobileBrowser/6.2';
    expect(botFamily(ua)).toBe('browser');
    expect(isBotUserAgent(ua)).toBe(false);
    for (const f of BOT_FAMILIES) expect(f.markers, f.family).not.toContain('sogou');
  });

  it('isBotUserAgent считает по тому же реестру', () => {
    for (const f of BOT_FAMILIES) {
      for (const m of f.markers) expect(isBotUserAgent(`Mozilla/5.0 (compatible; ${m})`), m).toBe(true);
    }
    expect(isBotUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129.0 Safari/537.36')).toBe(false);
    // Метки семейств уникальны и в нижнем регистре.
    const families = BOT_FAMILIES.map((f) => f.family);
    expect(new Set(families).size).toBe(families.length);
    for (const f of BOT_FAMILIES) for (const m of f.markers) expect(m).toBe(m.toLowerCase());
  });
});

describe('перепись входов для агентов', () => {
  it('семь входов; счётчик пишет сутки × путь × семейство без UA и IP, отказ — в лог, не наружу', async () => {
    expect([...AGENT_ENTRY_PATHS]).toEqual([
      '/robots.txt', '/llms.txt', '/.well-known/mcp.json', '/.well-known/agent-card.json', '/.well-known/agent.json',
      '/api/mcp/server-card', '/.well-known/ai-catalog.json',
    ]);
    recordAgentEntryHit('/robots.txt', 'Mozilla/5.0 (compatible; Baiduspider/2.0)');
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO agent_entry_hits \(day, path, family, hits\)/);
    expect(sql).toMatch(/ON CONFLICT \(day, path, family\) DO UPDATE SET hits = agent_entry_hits\.hits \+ 1/);
    expect(params).toEqual(['/robots.txt', 'baidu']);
    expect(sql).not.toMatch(/user_agent|ip/i);

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockRejectedValueOnce(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    expect(() => recordAgentEntryHit('/llms.txt', 'curl/8.5')).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(err).toHaveBeenCalledWith(expect.stringContaining('[agent-entry-hits]'), 'SQLSTATE=42P01', expect.any(String));
    err.mockRestore();
  });

  it('миграция 1218 заводит таблицу без колонок UA и IP', () => {
    const sql = read('migrations/1218_agent_entry_hits.sql');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS agent_entry_hits/);
    expect(sql).toMatch(/PRIMARY KEY \(day, path, family\)/);
    // Судится DDL, а не комментарий: шапка миграции как раз объясняет, что UA и IP не хранятся.
    const ddl = sql.slice(sql.indexOf('CREATE TABLE'), sql.indexOf(');'));
    expect(ddl).not.toMatch(/user_agent|\bip\b/i);
  });

  it('каждый из семи входов зовёт счётчик своим путём', () => {
    const sources: Record<string, [string, string]> = {
      '/robots.txt': ['app/robots.ts', "recordAgentEntryHit('/robots.txt'"],
      '/llms.txt': ['app/llms.txt/route.ts', "recordAgentEntryHit('/llms.txt'"],
      '/.well-known/mcp.json': ['app/.well-known/mcp.json/route.ts', "recordAgentEntryHit('/.well-known/mcp.json'"],
      '/.well-known/agent-card.json': ['app/.well-known/agent-card.json/route.ts', "recordAgentEntryHit('/.well-known/agent-card.json'"],
      '/.well-known/agent.json': ['app/.well-known/agent.json/route.ts', "recordAgentEntryHit('/.well-known/agent.json'"],
      // Карточка и каталог зовут счётчик константой пути (lib/mcp/server-card).
      '/api/mcp/server-card': ['app/api/mcp/server-card/route.ts', 'recordAgentEntryHit(SERVER_CARD_PATH'],
      '/.well-known/ai-catalog.json': ['app/.well-known/ai-catalog.json/route.ts', 'recordAgentEntryHit(AI_CATALOG_PATH'],
    };
    for (const [path, [file, call]] of Object.entries(sources)) {
      expect(read(file), ` ()`).toContain(call);
    }
    // robots.txt — через headers(): файл становится динамическим, и это сказано.
    const robots = read('app/robots.ts');
    expect(robots).toMatch(/from 'next\/headers'/);
    expect(robots).toMatch(/export default async function robots\(\): Promise<MetadataRoute\.Robots>/);
  });

  it('перепись: только чтение, объявлена manual, называет не считаемое и семейства КНР', () => {
    const src = read('app/api/cron/agent-entry-census/route.ts');
    expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(MANUAL_ENDPOINTS['agent-entry-census']).toMatchObject({ kind: 'manual', writes: false });
    expect(CRON_CAPABILITIES['agent-entry-census']).toEqual(['db_read']);
    expect(NOT_COUNTED.length).toBeGreaterThanOrEqual(3);
    expect(NOT_COUNTED.join(' ')).toMatch(/sitemap/);
    expect([...CHINESE_FAMILIES]).toEqual(['baidu', 'bytedance', 'huawei', 'alibaba', 'tencent', '360', 'deepseek']);
    for (const f of CHINESE_FAMILIES) expect(BOT_FAMILIES.map((b) => b.family), f).toContain(f);
    expect(readDays(null)).toBe(30);
    expect(readDays('7')).toBe(7);
    expect(readDays('0')).toBe(30);
    expect(readDays('91')).toBe(30);
    expect(readDays('abc')).toBe(30);
  });
});

describe('проба «знает ли модель о нас»', () => {
  it('вопрос без слова «Камчатка» ни на одном языке', () => {
    expect(KNOWLEDGE_QUESTION).toMatch(/vedarai\.ru/);
    expect(KNOWLEDGE_QUESTION).not.toMatch(/камчат|kamchat|堪察加/i);
    // И без прежнего имени: его модель должна назвать сама.
    expect(KNOWLEDGE_QUESTION).not.toMatch(/tour-?hab/i);
    expect(KNOWLEDGE_QUESTION).toMatch(CJK);
  });

  it('три исхода: Камчатка в ответе — знает; «не знаю» или выдумка — не знает; null и пусто — не смог спросить', () => {
    expect(classifyAnswer('vedarai.ru 是堪察加半岛的旅游平台').outcome).toBe('knows');
    expect(classifyAnswer('Ведар — платформа о Камчатке').outcome).toBe('knows');
    expect(classifyAnswer('Vedar is a Kamchatka travel site').outcome).toBe('knows');
    expect(classifyAnswer('不知道。')).toMatchObject({ outcome: 'does_not_know', signal: expect.stringContaining('не знает') });
    expect(classifyAnswer('vedarai.ru 可能是一个关于吠陀哲学的 AI 网站')).toMatchObject({ outcome: 'does_not_know', signal: expect.stringContaining('выдумка') });
    // Прежнее имя платформы в ответе — знает нас под старым брендом (владелец
    // 12.10: Qwen отвечал про TourHab); флаг old_brand отдельный и виден в сводке.
    expect(classifyAnswer('vedarai.ru — это TourHab, сервис туров')).toMatchObject({ outcome: 'knows', old_brand: true, signal: expect.stringContaining('прежнее имя') });
    expect(classifyAnswer('TourHab 是堪察加的旅游平台')).toMatchObject({ outcome: 'knows', old_brand: true });
    expect(classifyAnswer('Ведар — платформа о Камчатке').old_brand).toBe(false);
    expect(classifyAnswer(null).outcome).toBe('could_not_ask');
    expect(classifyAnswer('   ').outcome).toBe('could_not_ask');
    const s = summarize([
      { provider: 'deepseek', model: null, outcome: 'knows', signal: '', old_brand: true, reason: null, latency_ms: 1, answer_excerpt: null },
      { provider: 'qwen', model: null, outcome: 'could_not_ask', signal: '', old_brand: false, reason: 'x', latency_ms: 1, answer_excerpt: null },
    ]);
    expect(s).toEqual({ knows: ['deepseek'], does_not_know: [], could_not_ask: ['qwen'], old_brand: ['deepseek'] });
  });

  it('обёртки провайдеров передаются функциями, без прямого await; запуск — маркером, workflow ждёт свою сборку', () => {
    const src = read('app/api/cron/model-knowledge-probe/route.ts');
    expect(src).not.toMatch(/await call(DeepSeek|Qwen|Kimi|GLM)\b/);
    for (const fn of ['callDeepSeek', 'callQwen', 'callKimi', 'callGLM']) expect(src).toContain(`${fn}(m`);
    // Никакого id модели в исходнике (§8): резолв у обёрток.
    expect(src).not.toMatch(/deepseek-chat|qwen-max|glm-\d|kimi-k\d/);
    expect(CRON_CAPABILITIES['model-knowledge-probe']).toContain('ai');
    // Зовёт свой workflow по маркеру — значит, в cron-schedulers не объявляется.
    expect(MANUAL_ENDPOINTS['model-knowledge-probe']).toBeUndefined();
    const wf = read('.github/workflows/model-knowledge-probe.yml');
    expect(wf).toMatch(/\.github\/triggers\/model-knowledge-probe\.json/);
    expect(wf).toMatch(/run: bash scripts\/wait-for-deploy\.sh/);
    expect(wf).toMatch(/\/api\/cron\/model-knowledge-probe/);
    expect(existsSync(join(ROOT, '.github/triggers/model-knowledge-probe.json'))).toBe(true);
    const marker = JSON.parse(read('.github/triggers/model-knowledge-probe.json')) as { run: number; run1_reason: string };
    expect(marker.run).toBeGreaterThanOrEqual(1);
    expect(marker.run1_reason.length).toBeGreaterThan(40);
  });
});
