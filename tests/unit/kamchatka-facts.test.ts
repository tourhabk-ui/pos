/**
 * Единый справочник фактов: страницы и llms.txt читают цифры отсюда,
 * видимые формулировки не меняются, ИИ-ботам вход не закрыт.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  AVACHINSKY_HEIGHT_M,
  CUKS_CONSULT_PHONE,
  CUKS_DUTY_PHONE,
  CUKS_DUTY_RESERVE_PHONE,
  FEDERAL_EMERGENCY_NUMBERS,
  FISH_SALMON_RUN_WINDOW,
  FISH_SEASONS,
  KRONOTSKY_RULES,
  LANDINGS_WITH_VOLCANO_HEIGHTS,
  MCHS_REGISTRATION_LEAD,
  MUTNOVSKY_HEIGHT_M,
  SALMON_OFFICIAL_SEASON,
} from '@/lib/facts/kamchatka';
import { MCHS_LEAD_WORKING_DAYS } from '@/lib/safety/mchs-registration';
import { EMERGENCY_NUMBERS, FEDERAL_EMERGENCY, VERIFIED_REFERENCE, VERIFIED_REGIONAL } from '@/lib/safety/emergency-numbers';
import { safetyVisibleText } from '@/lib/seo/safety-page';
import { fishVisibleText } from '@/lib/seo/fish-page';
import { LANDINGS } from '@/lib/landings/landings';
import { SALMON_OFFICIAL_SEASON as FISH_SOURCES_SEASON } from '@/lib/fish/fish-sources';
import { KRONOKI_ESCORT } from '@/lib/seo/query-landings';
import { MCP_ENDPOINT, MCP_JSON_CONFIG } from '@/lib/mcp/connect';
import { llmsKuzmichConnectBlock, MCP_MANIFEST_PATH } from '@/lib/mcp/llms-connect-block';
import { AGENT_CARD_PATH, A2A_JSONRPC_PATH, A2A_REST_PATH } from '@/lib/a2a/agent-card';

vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'user-agent': 'test' }) }));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

const { default: robots } = await import('@/app/robots');
const { GET: llmsGet } = await import('@/app/llms.txt/route');

describe('справочник фактов', () => {
  it('срок МЧС, номера и официальный сезон рыбы — те же значения, что в рабочих модулях', () => {
    expect(MCHS_LEAD_WORKING_DAYS).toBe(MCHS_REGISTRATION_LEAD.value);
    expect(MCHS_REGISTRATION_LEAD.value).toBe(10);
    expect(FEDERAL_EMERGENCY.map((n) => n.phone)).toEqual([...FEDERAL_EMERGENCY_NUMBERS.value]);
    expect(VERIFIED_REGIONAL[0]?.phone).toBe(CUKS_DUTY_PHONE.value);
    expect(VERIFIED_REGIONAL[1]?.phone).toBe(CUKS_DUTY_RESERVE_PHONE.value);
    expect(VERIFIED_REFERENCE[0]?.phone).toBe(CUKS_CONSULT_PHONE.value);
    expect(EMERGENCY_NUMBERS.map((n) => n.phone)).toContain(FEDERAL_EMERGENCY_NUMBERS.value[0]);
    expect(FISH_SOURCES_SEASON.text).toBe(SALMON_OFFICIAL_SEASON.text);
  });

  it('у факта есть значение, дата сверки и источник; без URL — только сверка владельца', () => {
    const sourced = [
      AVACHINSKY_HEIGHT_M,
      MUTNOVSKY_HEIGHT_M,
      CUKS_CONSULT_PHONE,
      FISH_SALMON_RUN_WINDOW,
      ...Object.values(FISH_SEASONS),
    ];
    for (const f of sourced) {
      expect(f.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(f.sourceUrl).toMatch(/^https?:\/\//);
      expect(f.sourceLabel.length).toBeGreaterThan(8);
    }
    expect(MCHS_REGISTRATION_LEAD.sourceUrl).toMatch(/^https:\/\//);
    expect(KRONOTSKY_RULES.sourceUrl).toMatch(/^https:\/\//);
    expect(CUKS_DUTY_PHONE.sourceUrl).toBeNull();
    expect(CUKS_DUTY_RESERVE_PHONE.sourceUrl).toBeNull();
    expect(CUKS_DUTY_PHONE.checkedAt).toBe('2026-07-17');
  });
});

describe('видимый текст страниц не изменился', () => {
  it('/safety называет те же факты из справочника', () => {
    const text = safetyVisibleText();
    expect(text).toContain(`за ${MCHS_REGISTRATION_LEAD.value} рабочих дней`);
    expect(text).toContain(`от ${MCHS_REGISTRATION_LEAD.orderDateRu} ${MCHS_REGISTRATION_LEAD.order}`);
    expect(text).toContain(`не ближе ${KRONOTSKY_RULES.animalDistanceM} метров`);
    expect(text).toContain(`не менее ${KRONOTSKY_RULES.animalDistanceM} метров`);
    expect(text).toContain(`приказом № ${KRONOTSKY_RULES.order}`);
    expect(text).toContain(KRONOTSKY_RULES.orderDateLong);
    expect(text).toContain(KRONOTSKY_RULES.orderDateShort);
    expect(text).toContain(`короткие номера ${FEDERAL_EMERGENCY_NUMBERS.value.join(', ').replace(', 103', ' и 103')}`);
    expect(text).toContain(`Единый номер вызова экстренных служб — ${FEDERAL_EMERGENCY_NUMBERS.value[0]}`);
    expect(text).toContain(CUKS_DUTY_PHONE.value);
    expect(text).toContain(CUKS_DUTY_RESERVE_PHONE.value);
    expect(text).toContain(CUKS_CONSULT_PHONE.value);
    expect(text).not.toMatch(/₽|руб/);
  });

  it('/fish называет те же сезоны из справочника', () => {
    const text = fishVisibleText();
    expect(text).toContain(FISH_SALMON_RUN_WINDOW.value);
    expect(text).toContain(`Чавыча идёт ${FISH_SEASONS.chavycha.value}`);
    expect(text).toContain(`кижуч — ${FISH_SEASONS.kizuch.value}`);
    expect(text).toContain(`навагу — ${FISH_SEASONS.navaga.value} из-подо льда`);
  });
});

describe('посадочные вулканов и Авачинского', () => {
  it('высоты совпадают со справочником', () => {
    for (const slug of LANDINGS_WITH_VOLCANO_HEIGHTS) {
      const landing = LANDINGS.find((l) => l.slug === slug);
      expect(landing, slug).toBeTruthy();
      const text = `${landing!.before}\n${landing!.after}`;
      if (slug.includes('avachinsk') || slug === 'voshozhdeniya-na-vulkany-kamchatki') {
        expect(text, slug).toContain(`${AVACHINSKY_HEIGHT_M.value} м`);
      }
      if (slug.includes('mutnov') || slug.includes('gorelyj') || slug === 'voshozhdeniya-na-vulkany-kamchatki') {
        expect(text, slug).toContain(`${MUTNOVSKY_HEIGHT_M.value} м`);
      }
    }
  });
});

describe('/prepare и ответы в llms.txt', () => {
  it('/prepare берёт срок МЧС из того же справочника', () => {
    const src = readFileSync('app/prepare/page.tsx', 'utf8');
    expect(src).toContain('MCHS_LEAD_WORKING_DAYS');
    expect(src).toContain('EMERGENCY_NUMBERS');
  });

  it('формулировка Кроноцкого в FAQ посадочных читает приказ из справочника', () => {
    expect(KRONOKI_ESCORT).toContain(`приказ № ${KRONOTSKY_RULES.order} от ${KRONOTSKY_RULES.orderDateShort}`);
    expect(KRONOKI_ESCORT).toContain(KRONOTSKY_RULES.sourceUrl);
  });
});

describe('llms.txt: блок подключения Кузьмича и живые адреса', () => {
  it('блок в начале файла называет только канонические эндпоинты', () => {
    const block = llmsKuzmichConnectBlock('https://vedarai.ru');
    expect(block).toContain('## Как ИИ-агенту подключить Кузьмича');
    expect(block).toContain(MCP_ENDPOINT);
    expect(block).toContain(`https://vedarai.ru${MCP_MANIFEST_PATH}`);
    expect(block).toContain(`https://vedarai.ru${AGENT_CARD_PATH}`);
    expect(block).toContain(`https://vedarai.ru${A2A_JSONRPC_PATH}`);
    expect(block).toContain(`https://vedarai.ru${A2A_REST_PATH}`);
    expect(block).toContain(MCP_JSON_CONFIG);
    expect(block).toContain('https://vedarai.ru/kuzmich');
  });

  it('живой /llms.txt начинается с этого блока, до «Что это за сайт»', async () => {
    const text = await (await llmsGet()).text();
    const connectAt = text.indexOf('## Как ИИ-агенту подключить Кузьмича');
    const siteAt = text.indexOf('## Что это за сайт');
    expect(connectAt).toBeGreaterThan(0);
    expect(connectAt).toBeLessThan(siteAt);
    expect(text).toContain(MCP_ENDPOINT);
    expect(text).toContain(`https://vedarai.ru${MCP_MANIFEST_PATH}`);
    expect(text).toContain(`https://vedarai.ru${AGENT_CARD_PATH}`);
  });
});

describe('robots.txt не закрывает ИИ-ботов', () => {
  it('GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, PerplexityBot и YandexBot могут читать сайт', async () => {
    const needed = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'PerplexityBot', 'YandexBot'];
    const rules = (await robots()).rules as Array<{ userAgent?: string | string[]; allow?: string | string[]; disallow?: string | string[] }>;
    const list = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
    const named = new Set(rules.flatMap((r) => list(r.userAgent)));
    for (const bot of needed) {
      expect(named.has(bot), bot).toBe(true);
      const rule = rules.find((r) => list(r.userAgent).includes(bot));
      expect(list(rule?.allow).some((a) => a === '/' || a === '/*'), `${bot} allow /`).toBe(true);
      expect(list(rule?.disallow).some((d) => d === '/' || d === '/*'), `${bot} не закрыт целиком`).toBe(false);
    }
  });
});
