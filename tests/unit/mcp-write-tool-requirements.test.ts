// @vitest-environment node
/**
 * Обязательные поля заявок в /llms.txt и /llms-en.txt (21.11): собраны из
 * схем инструментов, а не написаны руками, и говорят агенту спросить
 * человека. Согласие остаётся обязательным.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { GET } from '@/app/llms.txt/route';
import { llmsEnFile } from '@/lib/mcp/en-layer';
import { PUBLIC_MCP_TOOLS, WRITE_TOOL_NAMES } from '@/lib/mcp/public-tools';
import { writeToolRequirements, writeToolRequirementsEn, writeToolRequirementsRu } from '@/lib/mcp/write-tool-requirements';

describe('обязательные поля заявок для агентов', () => {
  it('список совпадает с required самих схем; у шести заявок есть phone и consent', () => {
    const reqs = writeToolRequirements();
    for (const r of reqs) {
      const tool = PUBLIC_MCP_TOOLS.find((t) => t.name === r.tool);
      expect(r.required).toEqual((tool?.inputSchema as { required?: string[] }).required);
      if (WRITE_TOOL_NAMES.has(r.tool)) expect(r.required).toEqual(expect.arrayContaining(['name', 'phone', 'consent']));
    }
    expect(reqs.map((r) => r.tool)).toEqual(expect.arrayContaining([...WRITE_TOOL_NAMES, 'change_request']));
  });

  it('строки называют поля и правило «спросить человека»', () => {
    expect(writeToolRequirementsEn()).toContain('create_lead (name, phone, comment, consent)');
    expect(writeToolRequirementsEn()).toMatch(/ask before calling and never invent them; without consent no request is created/);
    expect(writeToolRequirementsRu()).toMatch(/спросите их до вызова и не придумывайте; без согласия заявка не создаётся/);
  });

  it('стоят в /llms.txt (обе) и в /llms-en.txt', async () => {
    const text = await (await GET()).text();
    expect(text).toContain(writeToolRequirementsRu());
    expect(text).toContain(writeToolRequirementsEn());
    expect(llmsEnFile('https://vedarai.ru')).toContain(writeToolRequirementsEn());
  });

  it('поле phone в схемах заявок говорит спросить человека, примера номера нет', () => {
    for (const t of PUBLIC_MCP_TOOLS.filter((x) => WRITE_TOOL_NAMES.has(x.name))) {
      const phone = (t.inputSchema as { properties: Record<string, { description?: string; examples?: unknown[] }> }).properties.phone;
      expect(phone.description, t.name).toMatch(/ask the person for their own number.*never invent one/);
      expect(phone.examples, t.name).toBeUndefined();
    }
  });
});
