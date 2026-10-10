/**
 * Сторож: свои заходы отделены от внешних (решение владельца 02.10).
 *
 * «Если подумать, мои заходы тоже в этой статистике». Суточный hash человека
 * не называет, и проверки владельца считались туристами, а его вызовы MCP —
 * спросом. Держит связку целиком:
 *
 *  1. миграция даёт is_self трём журналам;
 *  2. оба маяка сайта и роут MCP пишут флаг через ОДИН помощник
 *     (lib/analytics/self-visit), не разбирая cookie и адрес сами;
 *  3. каждый читатель page_views, который отсекает ботов (то есть говорит
 *     «люди»), отсекает и своих — иначе «внешние» снова со владельцем внутри;
 *  4. читатели funnel_events в окнах спроса отсекают своих;
 *  5. панель MCP считает таблицы без своих и без проверок, а реестр проверок
 *     знает каждое имя, которым представляются наши скрипты;
 *  6. метка MCP без env — никто не свой; с env — только точное совпадение.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { isSelfVisit, isSelfMcpCaller, selfVisitCookieString, SELF_VISIT_COOKIE } from '@/lib/analytics/self-visit';
import { PROBE_CLIENT_NAMES, isProbeClient } from '@/lib/mcp/probe-clients';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('метка своего захода — одно правило', () => {
  it('cookie: только vedar_self=1, прочее — внешний', () => {
    expect(isSelfVisit(`${SELF_VISIT_COOKIE}=1`)).toBe(true);
    expect(isSelfVisit(`theme=dark; ${SELF_VISIT_COOKIE}=1; x=y`)).toBe(true);
    expect(isSelfVisit(`${SELF_VISIT_COOKIE}=0`)).toBe(false);
    expect(isSelfVisit(`${SELF_VISIT_COOKIE}=`)).toBe(false);
    expect(isSelfVisit('')).toBe(false);
    expect(isSelfVisit(null)).toBe(false);
  });

  it('строка для document.cookie ставит на год и снимает нулевым Max-Age', () => {
    expect(selfVisitCookieString(true)).toMatch(/^vedar_self=1; Max-Age=31536000; Path=\/; SameSite=Lax$/);
    expect(selfVisitCookieString(false)).toMatch(/^vedar_self=; Max-Age=0;/);
  });

  it('MCP: без env никто не свой; с env — только точная метка', () => {
    const u = (q: string) => new URL(`https://vedarai.ru/api/mcp${q}`);
    expect(isSelfMcpCaller(u('?self=abcdefgh12'), undefined)).toBe(false);
    expect(isSelfMcpCaller(u('?self=abcdefgh12'), '')).toBe(false);
    // Короткая метка — не метка: подобрать можно, а значит это не «свой».
    expect(isSelfMcpCaller(u('?self=abc'), 'abc')).toBe(false);
    expect(isSelfMcpCaller(u('?self=abcdefgh12'), 'abcdefgh12')).toBe(true);
    expect(isSelfMcpCaller(u('?self=abcdefgh13'), 'abcdefgh12')).toBe(false);
    expect(isSelfMcpCaller(u(''), 'abcdefgh12')).toBe(false);
  });
});

describe('миграция и писатели', () => {
  it('1142 даёт is_self трём журналам', () => {
    const m = read('migrations/1142_self_visits.sql');
    for (const t of ['page_views', 'funnel_events', 'mcp_tool_calls']) {
      expect(m).toMatch(new RegExp(`ALTER TABLE ${t}\\s+ADD COLUMN IF NOT EXISTS is_self BOOLEAN NOT NULL DEFAULT FALSE`));
    }
  });

  it('оба маяка сайта пишут is_self через isSelfVisit(cookie)', () => {
    const hit = read('app/api/analytics/hit/route.ts');
    expect(hit).toContain("isSelfVisit(req.headers.get('cookie'))");
    expect(hit).toMatch(/INSERT INTO page_views \([^)]*is_self\)/);
    const funnel = read('app/api/funnel/route.ts');
    expect(funnel).toContain("isSelfVisit(request.headers.get('cookie'))");
    expect(funnel).toMatch(/INSERT INTO funnel_events \(step, entity_id, visitor_hash, is_self\)/);
    expect(funnel).toContain('$4::boolean');
  });

  it('роут MCP метит каждый вызов журнала флагом self из адреса', () => {
    const route = read('app/api/mcp/route.ts');
    expect(route).toContain('const self = isSelfMcpCaller(request.nextUrl)');
    const calls = route.match(/logMcpToolCall\(\{[^}]+\}\)/gs) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const c of calls) expect(c, c).toMatch(/\bself\b/);
    expect(read('lib/mcp/call-log.ts')).toContain('entry.self === true');
  });
});

describe('читатели считают внешних без своих', () => {
  it('каждый читатель page_views, отсекающий ботов, отсекает и своих', () => {
    const files = [...walk(join(process.cwd(), 'app')), ...walk(join(process.cwd(), 'lib'))]
      .filter(p => !/\/(hit|beacon-check|sql-shape-check)\//.test(p));
    const offenders: string[] = [];
    for (const p of files) {
      const src = readFileSync(p, 'utf8');
      if (!src.includes('FROM page_views')) continue;
      const bots = (src.match(/is_bot = FALSE/g) ?? []).length;
      const selfs = (src.match(/is_bot = FALSE AND (?:pv\.)?is_self = FALSE/g) ?? []).length;
      if (bots !== selfs) offenders.push(`${p.replace(process.cwd() + '/', '')}: is_bot ${bots}, с is_self ${selfs}`);
    }
    expect(offenders, 'читатель «люди» без отсечения своих').toEqual([]);
  });

  it('окна спроса funnel_events — без своих', () => {
    expect(read('app/api/admin/analytics/funnel/route.ts').match(/is_self = FALSE/g)?.length).toBe(3);
    expect(read('app/api/cron/booking-attempts/route.ts')).toContain("step = 'booking_start' AND is_self = FALSE");
    expect(read('app/api/cron/stay-demand-census/route.ts').match(/created_at > \$\{W\} AND is_self = FALSE/g)?.length).toBe(6); // + stay_phone_call (1179), stay_message_click (1181)
    expect(read('lib/agents/evo/growth-agent.ts')).toContain("step = 'booking_start' AND is_self = FALSE");
    expect(read('lib/analytics/funnel-window.ts')).toContain("step = 'booking_start' AND is_self = FALSE");
  });

  it('срез трафика показывает своё отдельным числом и с какого дня', () => {
    const t = read('app/api/admin/analytics/traffic/route.ts');
    expect(t).toContain("const HUMAN = 'is_bot = FALSE AND is_self = FALSE'");
    expect(t).toContain('AS month_self_hits');
    expect(t).toContain('AS self_since');
    expect(read('app/hub/admin/traffic/page.tsx')).toContain('<SelfVisitToggle');
    expect(read('app/hub/admin/traffic/_SelfVisitToggle.tsx')).toContain('selfVisitCookieString(next)');
  });
});

describe('свои заявки отделены (1145)', () => {
  it('миграция даёт is_self заявкам; создание пишет флаг; сайт и MCP его передают', () => {
    expect(read('migrations/1145_leads_is_self.sql')).toMatch(/ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_self BOOLEAN NOT NULL DEFAULT FALSE/);
    const create = read('lib/leads/create.ts');
    expect(create).toMatch(/INSERT INTO leads \([^)]*is_self\)/);
    expect(create).toContain('is_self === true');
    expect(create).toContain('isSelf: is_self === true');
    expect(read('app/api/leads/route.ts')).toContain("is_self: isSelfVisit(req.headers.get('cookie'))");
    const mcp = read('app/api/mcp/route.ts');
    expect(mcp).toMatch(/interface McpCallContext \{[^}]*self: boolean/);
    // Три заявки из MCP: подбор, бронь тура, вахтовка целой машиной (10.10).
    expect((mcp.match(/is_self: ctx\.self/g) ?? []).length).toBe(3);
    // Второй аргумент — разобранные аргументы с формой (lib/mcp/tool-arguments, 08.10); флаг self — в контексте, как был.
    expect(mcp).toContain('executeTool(toolName, read, { ip, userAgent, self })');
  });

  it('follow-up по своей заявке не шлётся; счёт заявок — без своих; уведомление с пометкой, не спрятано', () => {
    expect(read('app/api/cron/followups/route.ts')).toContain('AND l.is_self = FALSE');
    const fw = read('lib/analytics/funnel-window.ts');
    expect((fw.match(/FROM leads WHERE is_self = FALSE/g) ?? []).length).toBe(2);
    expect(fw).toContain('FROM leads\n        WHERE is_self = FALSE');
    expect(fw).toContain('LEFT JOIN leads l ON l.created_at >= d.s AND l.created_at < d.e AND l.is_self = FALSE');
    expect(read('lib/agents/evo/growth-agent.ts')).toContain('FROM leads WHERE is_self = FALSE');
    expect(read('app/api/cron/booking-attempts/route.ts')).toContain('FROM leads\n        WHERE is_self = FALSE');
    const tg = read('lib/notifications/telegram-channel.ts');
    expect(tg).toContain("lead.isSelf ? 'Свой тест · ' : ''");
  });
});

describe('панель MCP: внешние, свои, проверки', () => {
  const slice = read('app/api/admin/analytics/mcp/route.ts');

  it('таблицы по инструментам, дням, ошибкам и именам — только внешние', () => {
    expect((slice.match(/\$\{EXTERNAL\('t'\)\}/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(slice).toContain('origins_30d');
    expect(slice).toMatch(/COUNT\(\*\) FILTER \(WHERE t\.is_self\)\s+AS self/);
    const page = read('app/hub/admin/mcp/page.tsx');
    expect(page).toContain('Своих (метка владельца)');
    expect(page).toContain('Проверок (смоук, пробы, curl)');
  });

  it('каждое имя clientInfo из scripts/ значится в реестре проверок', () => {
    const names = new Set<string>();
    for (const p of walk(join(process.cwd(), 'scripts')).concat(
      readdirSync(join(process.cwd(), 'scripts')).filter(f => f.endsWith('.mjs')).map(f => join(process.cwd(), 'scripts', f)),
    )) {
      for (const m of readFileSync(p, 'utf8').matchAll(/clientInfo:\s*\{\s*name:\s*'([^']+)'/g)) names.add(m[1]);
    }
    expect(names.size).toBeGreaterThanOrEqual(1);
    for (const n of names) expect(PROBE_CLIENT_NAMES, `${n} не в реестре проверок`).toContain(n);
    expect(isProbeClient('vedar-deploy-smoke', null)).toBe(true);
    expect(isProbeClient(null, 'curl')).toBe(true);
    // Представившийся клиент не становится проверкой из-за заголовка curl.
    expect(isProbeClient('claude-ai', 'curl')).toBe(false);
    expect(isProbeClient('claude-ai', 'claude')).toBe(false);
    // Образец имени (перепись run 78): верификаторы каталогов приходят новыми, список за ними не поспеет.
    for (const n of ['katalir-readonly-verifier', 'agent-index-prober', 'glama-mcp-inspector', 'mcphub-probe', 'vouch-census', 'grok-audit', 'tendle-review', 'probe', 'connectors-manager']) {
      expect(isProbeClient(n, null), n).toBe(true);
    }
    for (const n of ['claude', 'Anthropic/ClaudeAI', 'claude-code', 'brick.blue', 'Tendle', 'mira-bot', 'lmstudio-mcp-server-session', 'cursor']) {
      expect(isProbeClient(n, null), n).toBe(false);
    }
  });
});
