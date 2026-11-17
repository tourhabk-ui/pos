/**
 * Навык Ведара для ИИ-агентов (#3408): SKILL.md по адресу, список навыков,
 * ссылки из /llms.txt, /llms-en.txt и /mcp. Судятся ответы роутов и
 * отрисованная страница, а не исходник.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/lib/analytics/agent-entry-hits', () => ({ recordAgentEntryHit: () => undefined }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));

import { GET as skillGet } from '@/app/skills/vedar-kamchatka/SKILL.md/route';
import { GET as indexGet } from '@/app/.well-known/skills/index.json/route';
import { GET as llmsEnGet } from '@/app/llms-en.txt/route';
import { GET as llmsGet } from '@/app/llms.txt/route';
import McpLandingPage from '@/app/mcp/page';
import { vedarSkillMarkdown, VEDAR_SKILL_URL, VEDAR_SKILL_PATH, VEDAR_SKILL_INSTALL_CLAUDE_CODE } from '@/lib/agent/vedar-skill';
import { PUBLIC_MCP_TOOLS } from '@/lib/mcp/public-tools';
import { MCP_ENDPOINT } from '@/lib/mcp/connect';

afterEach(cleanup);

/** YAML-шапка навыка: поле → значение (одна строка). */
function frontmatter(md: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) return {};
  return Object.fromEntries(m[1].split('\n').filter((l) => /^\w[\w-]*:\s/.test(l)).map((l) => {
    const i = l.indexOf(':');
    return [l.slice(0, i), l.slice(i + 1).trim()];
  }));
}

describe('SKILL.md', () => {
  it('отдаётся 200, markdown, со шапкой name: vedar-kamchatka и описанием', async () => {
    const res = await skillGet();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('x-robots-tag')).toBeNull();
    const fm = frontmatter(await res.text());
    expect(fm.name).toBe('vedar-kamchatka');
    expect(fm.description).toMatch(/Kamchatka/);
    expect(fm.description!.length).toBeLessThanOrEqual(1024);
  });

  it('адрес сервера и команда подключения — живые, те же, что у сервера', () => {
    const md = vedarSkillMarkdown(false);
    expect(md).toContain(`\`${MCP_ENDPOINT}\``);
    expect(md).toContain(`claude mcp add --transport http`);
    expect(md).toContain('https://vedarai.ru/.well-known/agent-card.json');
    expect(md).toContain('https://vedarai.ru/llms-en.txt');
  });

  it('заявку отправляет сам человек по ссылке, прокат тоже; согласие за человека не даётся', () => {
    const md = vedarSkillMarkdown(false);
    expect(md).toMatch(/does not send anything\. It returns a draft and a link/);
    expect(md).toMatch(/press "Send" themselves/);
    expect(md).toMatch(/Do not open the link or press the button for the person/);
    // Прокат с 17.11 — тот же путь /confirm, кода подтверждения нет.
    expect(md).toMatch(/all six requests, self-drive car rental included/);
    expect(md).not.toMatch(/confirmation code/i);
    // Прежний путь «агент ставит флаг согласия» навык не учит.
    expect(md).not.toMatch(/consent flag/i);
  });

  it('оплата — по выключателю, как у сервера', () => {
    expect(vedarSkillMarkdown(false)).toMatch(/Vedar does not accept payments right now/);
    expect(vedarSkillMarkdown(true)).toMatch(/paid only after the operator confirms/);
  });

  it('без имён и числа инструментов, без «бронирует/продаёт» от лица Ведара; номер — только 112', () => {
    const md = vedarSkillMarkdown(false);
    for (const t of PUBLIC_MCP_TOOLS) expect(md, t.name).not.toContain(t.name);
    // «Do not say Vedar books» — само правило; утверждения «Vedar books/sells» нет.
    expect(md).not.toMatch(/(?<!say )Vedar (books|sells)\b/);
    const phones = md.match(/\b\d{3,}\b/g) ?? [];
    expect(phones.filter((d) => d !== '112' && !/^\d{4}$/.test(d))).toEqual([]);
  });
});

describe('список навыков и ссылки', () => {
  it('/.well-known/skills/index.json — навык с адресом SKILL.md', async () => {
    const res = await indexGet();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      skills: [expect.objectContaining({ name: 'vedar-kamchatka', url: VEDAR_SKILL_URL })],
    });
  });

  it('/llms.txt ссылается на навык и на список навыков', async () => {
    const text = await (await llmsGet()).text();
    expect(text).toContain(VEDAR_SKILL_URL);
    expect(text).toContain('https://vedarai.ru/.well-known/skills/index.json');
  });

  it('/llms-en.txt ссылается на навык', async () => {
    const text = await (await llmsEnGet()).text();
    expect(text).toContain(`Agent skill: https://vedarai.ru${VEDAR_SKILL_PATH}`);
  });

  it('/mcp: блок «Установить как навык» — ссылка на файл и команда для Claude Code', () => {
    const { container } = render(<McpLandingPage />);
    const section = container.querySelector('#skill');
    expect(section?.textContent).toContain('Установить как навык');
    expect(section?.querySelector(`a[href="${VEDAR_SKILL_PATH}"]`)).toBeTruthy();
    expect(section?.querySelector('[data-skill-install="claude_code"]')?.textContent?.trim()).toBe(VEDAR_SKILL_INSTALL_CLAUDE_CODE);
  });
});
