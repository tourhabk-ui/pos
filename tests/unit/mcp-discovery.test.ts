/**
 * Чужой агент должен нас НАЙТИ, ВЫЗВАТЬ и не получить лишнего.
 *
 * Сервер `/api/mcp` у нас с 27.07 (#838), но найти его было нельзя: адрес надо
 * было знать заранее. Манифест `/.well-known/mcp.json` — то, что превращает
 * «сервер существует» в «сервер находят».
 *
 * Три свойства, которые ломаются молча:
 *  · манифест обещает инструменты, которых в сервере нет — агент строит по
 *    нему план и падает на вызове;
 *  · наружу уезжает лишнее — брони, оплата, чужие ПД;
 *  · «данных нет» превращается в «всё спокойно»: для внешнего агента это
 *    прямая опасность, он передаст ответ человеку, который поедет.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PUBLIC_MCP_TOOLS, PUBLIC_MCP_TOOL_NAMES, EXCLUDED_TOOLS } from '@/lib/mcp/public-tools';
import { formatSafetyStatusForAgent } from '@/lib/safety/current-status';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const MANIFEST = read('app/.well-known/mcp.json/route.ts');
const SERVER = read('app/api/mcp/route.ts');
const ROBOTS = read('app/robots.ts');

describe('манифест не расходится с сервером', () => {
  it('оба берут список из одного модуля', () => {
    expect(MANIFEST).toMatch(/from '@\/lib\/mcp\/public-tools'/);
    expect(SERVER).toMatch(/from '@\/lib\/mcp\/public-tools'/);
    // Свой список в любом из двух — это и есть расхождение.
    expect(MANIFEST).not.toMatch(/name: 'get_tours'/);
    expect(SERVER).not.toMatch(/name: 'get_tours'/);
  });

  it('манифест указывает на живой эндпоинт и транспорт', () => {
    expect(MANIFEST).toMatch(/\/api\/mcp/);
    expect(MANIFEST).toMatch(/streamable-http/);
  });

  it('агентские входы разрешены в robots — /api/ закрыт целиком', () => {
    expect(ROBOTS).toMatch(/AGENT_ENTRYPOINTS/);
    expect(ROBOTS).toMatch(/'\/api\/mcp'/);
  });
});

describe('наружу — только то, что можно', () => {
  it('единственный пишущий инструмент — заявка', () => {
    const writers = PUBLIC_MCP_TOOLS.filter((t) => /create|book|order|pay|cancel|delete|update/i.test(t.name));
    expect(writers.map((t) => t.name)).toEqual(['create_lead']);
  });

  it('брони и оплаты наружу нет', () => {
    for (const t of PUBLIC_MCP_TOOLS) {
      expect(t.name, `${t.name}: бронирование анонимному агенту не отдаём`).not.toMatch(/booking|payment|invoice/i);
    }
  });

  it('инструменты с внешними квотами исключены', () => {
    for (const excluded of EXCLUDED_TOOLS) {
      expect(PUBLIC_MCP_TOOL_NAMES.has(excluded), `${excluded} просочился наружу`).toBe(false);
    }
  });

  it('в описаниях инструментов нет личных данных туристов', () => {
    for (const t of PUBLIC_MCP_TOOLS) {
      if (t.name === 'create_lead') continue; // там телефон — это ввод, а не выдача
      expect(t.description, `${t.name}`).not.toMatch(/паспорт|email|почт[аы]|телефон туриста/i);
    }
  });
});

describe('обстановка в крае: «не знаем» звучит как «не знаем»', () => {
  it('недоступный источник не превращается в «спокойно»', () => {
    const text = formatSafetyStatusForAgent(null);
    expect(text).toMatch(/Данных об обстановке сейчас нет/);
    expect(text).toMatch(/НЕ означает, что опасности нет/);
    expect(text).toMatch(/112/);
  });

  it('тишина названа тишиной, а не молчанием', () => {
    const text = formatSafetyStatusForAgent({
      hasAlert: false, maxSeverity: 0, activeCount: 0,
      topTitle: null, topType: null, dataUpdatedAt: '2026-08-05T00:00:00Z', source: 'КБГС РАН',
    });
    expect(text).toMatch(/Активных предупреждений по Камчатскому краю нет/);
    expect(text).toMatch(/КБГС РАН/);
  });

  it('ответ про край не выдаёт себя за оценку маршрута', () => {
    const text = formatSafetyStatusForAgent({
      hasAlert: true, maxSeverity: 3, activeCount: 2,
      topTitle: 'Сход селя', topType: 'landslide', dataUpdatedAt: null, source: 'КБГС РАН',
    });
    expect(text).toMatch(/обстановка по краю целиком/i);
    expect(text).toMatch(/get_guardian_context/);
  });

  it('инструмент есть в публичном списке', () => {
    expect(PUBLIC_MCP_TOOL_NAMES.has('safety_status')).toBe(true);
  });
});
