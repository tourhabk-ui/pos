// @vitest-environment node
/**
 * Визитка A2A (lib/a2a/agent-card): форма 1.0 и 0.3, навыки из реестра
 * инструментов MCP, ничего не обещано сверх сервера.
 *
 * Держит: обязательные поля 1.0 (name, description, version, capabilities
 * объектом, defaultInputModes/OutputModes, skills массивом,
 * supportedInterfaces с protocolBinding и protocolVersion); у 1.0 нет
 * верхнего `url` и `protocolVersion` (их место — в интерфейсах; лишние поля
 * строгий proto-клиент отвергает); у 0.3 — наоборот, `url`, `protocolVersion`
 * «0.3.0», `preferredTransport`; навык на КАЖДЫЙ публичный инструмент и ни
 * одного сверх; теги есть у каждого инструмента (мутация: убрать запись —
 * красный); описание не обещает оплаты и мгновенной брони; ПД нет.
 */
import { describe, it, expect } from 'vitest';
import {
  buildAgentCard, buildLegacyAgentCard, buildSkills, skillToolNames, SKILL_TAGS, CHAT_SKILL_ID,
  AGENT_CARD_PATH, LEGACY_AGENT_CARD_PATH, A2A_JSONRPC_PATH, A2A_REST_PATH, A2A_PROTOCOL_VERSION, A2A_LEGACY_PROTOCOL_VERSION,
} from '@/lib/a2a/agent-card';
import { PUBLIC_MCP_TOOL_NAMES, PUBLIC_MCP_TOOLS, WRITE_TOOL_NAMES, MCP_SERVER_INFO } from '@/lib/mcp/public-tools';
import { validateToolArgs } from '@/lib/kuzmich/tool-schemas';

const BASE = 'https://vedarai.ru';
const card = buildAgentCard(BASE) as Record<string, unknown>;
const legacy = buildLegacyAgentCard(BASE) as Record<string, unknown>;

describe('карточка 1.0', () => {
  it('обязательные поля на месте и нужного типа', () => {
    expect(typeof card.name).toBe('string');
    expect(typeof card.description).toBe('string');
    expect(card.version).toBe(MCP_SERVER_INFO.version);
    expect(card.capabilities).toEqual({ streaming: false, pushNotifications: false, extendedAgentCard: false });
    expect(Array.isArray(card.capabilities)).toBe(false);
    expect(card.defaultInputModes).toEqual(['text/plain', 'application/json']);
    expect(card.defaultOutputModes).toEqual(['text/plain', 'application/json']);
    expect(Array.isArray(card.skills)).toBe(true);
    expect(card.provider).toEqual({ organization: 'Ведар (vedarai.ru)', url: BASE });
    expect(card.documentationUrl).toBe(`${BASE}/mcp`);
  });

  it('интерфейсы: JSON-RPC первым (предпочтительный), затем HTTP+JSON, у каждого protocolBinding и protocolVersion', () => {
    expect(card.supportedInterfaces).toEqual([
      { url: `${BASE}/api/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      { url: `${BASE}/api/a2a/v1`, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
    ]);
    expect(A2A_PROTOCOL_VERSION).toBe('1.0');
    expect(A2A_JSONRPC_PATH).toBe('/api/a2a');
    expect(A2A_REST_PATH).toBe('/api/a2a/v1');
  });

  it('полей 0.3 на верхнем уровне нет: url, protocolVersion, preferredTransport, additionalInterfaces, security', () => {
    for (const k of ['url', 'protocolVersion', 'preferredTransport', 'additionalInterfaces', 'security']) {
      expect(card, k).not.toHaveProperty(k);
    }
    // Аноним: схемы и требования названы пустыми, а не пропущены.
    expect(card.securitySchemes).toEqual({});
    expect(card.securityRequirements).toEqual([]);
  });

  it('пути well-known — по спецификации 1.0 и старый для 0.3', () => {
    expect(AGENT_CARD_PATH).toBe('/.well-known/agent-card.json');
    expect(LEGACY_AGENT_CARD_PATH).toBe('/.well-known/agent.json');
  });
});

describe('навыки — из реестра инструментов', () => {
  const skills = buildSkills();

  it('разговор первым, затем ровно по навыку на каждый публичный инструмент', () => {
    expect(skills[0].id).toBe(CHAT_SKILL_ID);
    expect(new Set(skillToolNames())).toEqual(PUBLIC_MCP_TOOL_NAMES);
    expect(skills).toHaveLength(PUBLIC_MCP_TOOL_NAMES.size + 1);
    const ids = skills.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('у каждого навыка id, name, description, tags и примеры; теги заведены на каждый инструмент', () => {
    expect(new Set(Object.keys(SKILL_TAGS))).toEqual(PUBLIC_MCP_TOOL_NAMES);
    for (const s of skills) {
      expect(s.id.length, s.id).toBeGreaterThan(0);
      expect(s.name.length, s.id).toBeGreaterThan(0);
      expect(s.description.length, s.id).toBeGreaterThan(40);
      expect(s.tags.length, s.id).toBeGreaterThan(0);
      expect(s.tags, s.id).toContain('kamchatka');
      expect(s.examples.length, s.id).toBeGreaterThan(0);
      expect(s.inputModes.length, s.id).toBeGreaterThan(0);
      expect(s.outputModes.length, s.id).toBeGreaterThan(0);
    }
  });

  it('навык инструмента показывает форму DataPart с его именем; пишущие говорят про согласие и rejected', () => {
    for (const s of skills.slice(1)) {
      const example = JSON.parse(s.examples[0]) as { tool: string; arguments: unknown };
      expect(example.tool, s.id).toBe(s.id);
      expect(s.description, s.id).toContain(`"tool":"${s.id}"`);
      if (WRITE_TOOL_NAMES.has(s.id)) {
        expect(s.tags, s.id).toContain('human-confirmed');
        expect(s.tags, s.id).toContain('consent');
        expect(s.description, s.id).toMatch(/rejected/);
      }
    }
  });

  it('пример DataPart называет только параметры инструмента, все обязательные, и схема их не отбрасывает', () => {
    // До 13.10 четыре примера звали параметры, которых нет: лишнее поле
    // схема отбрасывала молча, и скопировавший пример агент получал ответ не
    // на свой вопрос (search_transfers с `destination`) или отказ
    // (get_tour_details без `name`).
    const schemaOf = new Map(PUBLIC_MCP_TOOLS.map(t => [t.name, t.inputSchema as { properties?: Record<string, unknown>; required?: string[] }]));
    for (const s of skills.slice(1)) {
      const { arguments: args } = JSON.parse(s.examples[0]) as { arguments: Record<string, unknown> };
      const keys = Object.keys(args);
      if (keys.length === 0) continue; // формы нет — пример пуст, а не выдуман
      const schema = schemaOf.get(s.id)!;
      for (const k of keys) expect(Object.keys(schema.properties ?? {}), `${s.id}: параметра «${k}» в схеме нет`).toContain(k);
      for (const r of schema.required ?? []) expect(keys, `${s.id}: в примере нет обязательного «${r}»`).toContain(r);
      const asStrings = Object.fromEntries(keys.map(k => [k, String(args[k])]));
      const parsed = validateToolArgs(s.id, asStrings);
      expect(parsed.ok, s.id).toBe(true);
      if (parsed.ok) expect(Object.keys(parsed.args).sort(), `${s.id}: схема отбросила часть примера`).toEqual([...keys].sort());
    }
  });

  it('разговорный навык честно говорит, что заявок не оформляет', () => {
    expect(skills[0].description).toMatch(/Заявки в этом режиме не оформляются/);
    expect(skills[0].inputModes).toEqual(['text/plain']);
  });
});

describe('описание не обещает лишнего', () => {
  const text = JSON.stringify(card);

  it('подтверждает человек, оплаты и брони через агента нет, задача хранится час', () => {
    expect(card.description).toMatch(/подтверждает человек/);
    expect(card.description).toMatch(/Брони и оплаты через агента нет/);
    expect(card.description).toMatch(/хранится час/);
    expect(card.description).toMatch(/no payment/);
  });

  it('описание начинается по-английски, русский и китайский текст следом', () => {
    const d = card.description as string;
    expect(d.startsWith('Vedar Kamchatka travel agent')).toBe(true);
    expect(d.slice(0, 300)).not.toMatch(/[А-Яа-яЁё]/);
    expect(d.indexOf('Русский:')).toBeGreaterThan(0);
    expect(legacy.description).toBe(d);
  });

  it('ни телефонов, ни почт людей, ни секретов', () => {
    expect(text).not.toMatch(/\+7 ?\d{3}/);
    expect(text).not.toMatch(/@mail\.ru|@gmail\.com|@yandex\.ru/);
    expect(text).not.toMatch(/secret|token|password/i);
  });
});

describe('карточка 0.3 (старый путь)', () => {
  it('url, preferredTransport, protocolVersion 0.3.0, additionalInterfaces, capabilities со stateTransitionHistory', () => {
    expect(legacy.url).toBe(`${BASE}/api/a2a`);
    expect(legacy.preferredTransport).toBe('JSONRPC');
    expect(legacy.protocolVersion).toBe(A2A_LEGACY_PROTOCOL_VERSION);
    expect(A2A_LEGACY_PROTOCOL_VERSION).toBe('0.3.0');
    expect(legacy.additionalInterfaces).toEqual([
      { url: `${BASE}/api/a2a`, transport: 'JSONRPC' },
      { url: `${BASE}/api/a2a/v1`, transport: 'HTTP+JSON' },
    ]);
    expect(legacy.capabilities).toEqual({ streaming: false, pushNotifications: false, stateTransitionHistory: false });
    expect(legacy).not.toHaveProperty('supportedInterfaces');
    expect(legacy.security).toEqual([]);
    expect((legacy.skills as unknown[]).length).toBe((card.skills as unknown[]).length);
  });
});
