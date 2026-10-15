/**
 * «如何在中文客户端中接入» на /zh — шаги под китайские клиенты и кнопки Trae
 * (аудит 15.10, CN-zh).
 *
 * До этого дня /zh, README и llms.txt называли только адрес сервера и общий
 * JSON: человеку в 豆包 или 扣子 оставалось угадать, куда его вставить, а
 * Trae с документированной ссылкой-установкой не было вовсе. Живого
 * подключения ни в одном клиенте не было, поэтому каждая запись обязана
 * показать человеку источник, дату и пометку «界面可能不同» — объявленный
 * путь без проверки называется так вслух (§10.09 CLAUDE.md).
 *
 * Судится тем, что видит человек: рендер страницы /zh (адрес в шагах,
 * источник ссылкой, дата, пометка, кнопка Trae CN с рабочим адресом), а
 * README и llms.txt — по тексту артефакта, тем же значениям из модуля.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, within, screen } from '@testing-library/react';

vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import ZhEntryPage from '@/app/zh/page';
import { ZH_CLIENT_GUIDES, ZH_CONNECT, llmsSectionZh } from '@/lib/mcp/zh-layer';
import { MCP_CONNECT_OPTIONS, MCP_ENDPOINT } from '@/lib/mcp/connect';

afterEach(cleanup);

/** Адрес, который человек вставляет, — буквой, не только константой. */
const ENDPOINT = 'https://vedarai.ru/api/mcp';
const traeValue = (id: 'trae_cn' | 'trae') => MCP_CONNECT_OPTIONS.find((o) => o.id === id)!.value;

async function renderZh() {
  render(await ZhEntryPage());
  return screen.getByRole('heading', { level: 2, name: ZH_CONNECT.heading }).closest('section')!;
}

describe('/zh: как подключить в китайском клиенте', () => {
  it('эндпоинт в шагах — канонический', () => {
    expect(MCP_ENDPOINT).toBe(ENDPOINT);
  });

  it('шесть клиентов из разведки 15.10, у каждого своя карточка', async () => {
    const section = await renderZh();
    expect(section.id).toBe('connect');
    const shown = [...section.querySelectorAll('[data-zh-client]')].map((el) => el.getAttribute('data-zh-client')).sort();
    expect(shown).toEqual(['cherry_studio', 'coze', 'doubao_desktop', 'qoder_cn', 'step_code', 'trae']);
    expect(shown).toEqual(ZH_CLIENT_GUIDES.map((g) => g.id).sort());
  });

  it('у каждого клиента видны адрес сервера, источник ссылкой, дата прочтения и пометка «界面可能不同»', async () => {
    const section = await renderZh();
    for (const g of ZH_CLIENT_GUIDES) {
      const card = section.querySelector(`[data-zh-client="${g.id}"]`) as HTMLElement;
      const text = card.textContent ?? '';
      expect(within(card).getByRole('heading', { level: 3 }).textContent, g.id).toBe(g.client);
      expect(text, `${g.id}: адрес`).toContain(ENDPOINT);
      expect(text, `${g.id}: пометка`).toMatch(/据(平台文档|第三方指南)整理，界面可能不同/);
      expect(text, `${g.id}: дата`).toMatch(/（2026-10-15 查阅）/);
      expect(g.sources.length, g.id).toBeGreaterThan(0);
      const hrefs = within(card).getAllByRole('link').map((a) => a.getAttribute('href'));
      for (const s of g.sources) {
        expect(s.url, g.id).toMatch(/^https:\/\//);
        expect(hrefs, `${g.id}: источник ${s.url}`).toContain(s.url);
      }
    }
  });

  it('без официальной справки (豆包) — так и сказано: «据第三方指南整理»', async () => {
    const section = await renderZh();
    const doubao = section.querySelector('[data-zh-client="doubao_desktop"]')!;
    expect(doubao.textContent).toContain('据第三方指南整理');
    expect(doubao.textContent).toContain('仅电脑版');
    for (const id of ['coze', 'cherry_studio', 'qoder_cn', 'step_code', 'trae']) {
      expect(section.querySelector(`[data-zh-client="${id}"]`)!.textContent, id).toContain('据平台文档整理');
    }
  });

  it('扣子: JSON без поля type разбирается в наш адрес; Step Code: команда с --url', async () => {
    const section = await renderZh();
    const coze = section.querySelector('[data-zh-client="coze"] pre')!.textContent!;
    expect(JSON.parse(coze)).toEqual({ mcpServers: { vedar: { url: ENDPOINT } } });
    expect(section.querySelector('[data-zh-client="step_code"] pre')!.textContent).toBe(`step mcp add vedar --url ${ENDPOINT}`);
  });

  it('кнопка Trae CN ведёт ссылкой-установкой с нашим адресом в config; есть и международная', async () => {
    const section = await renderZh();
    const card = section.querySelector('[data-zh-client="trae"]') as HTMLElement;
    const cn = within(card).getByRole('link', { name: '添加到 Trae（中国版）' });
    expect(cn.getAttribute('href')).toBe(traeValue('trae_cn'));
    const url = new URL(cn.getAttribute('href')!);
    expect(url.protocol).toBe('trae-cn:');
    expect(url.host).toBe('trae.ai-ide');
    expect(url.pathname).toBe('/mcp-import');
    expect(url.searchParams.get('type')).toBe('http');
    expect(JSON.parse(Buffer.from(url.searchParams.get('config')!, 'base64').toString('utf-8'))).toEqual({ url: ENDPOINT });
    const intl = within(card).getByRole('link', { name: '添加到 Trae 国际版' });
    expect(intl.getAttribute('href')).toBe(traeValue('trae'));
    expect(new URL(intl.getAttribute('href')!).protocol).toBe('trae:');
  });
});

describe('README и llms.txt называют то же', () => {
  const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf-8');
  const zhParagraph = readme.split('\n').find((l) => l.startsWith('**中文')) ?? '';

  it('заголовок README — латиница первой: Vedar（维达尔）, затем Ведар', () => {
    expect(readme.split('\n')[0]).toBe('# Vedar（维达尔）— Ведар, туристическая ОС Камчатки');
  });

  it('китайский абзац README: все клиенты, ссылка на /zh#connect и обе ссылки Trae теми же значениями', () => {
    expect(zhParagraph).not.toBe('');
    for (const g of ZH_CLIENT_GUIDES) expect(zhParagraph, g.id).toContain(g.client);
    expect(zhParagraph).toContain('https://vedarai.ru/zh#connect');
    expect(zhParagraph).toContain(`\`${traeValue('trae_cn')}\``);
    expect(zhParagraph).toContain(`\`${traeValue('trae')}\``);
    expect(zhParagraph).toMatch(/未经实际接入验证/);
  });

  it('раздел llms.txt: каждый клиент с источником и пометкой, ссылка Trae CN', () => {
    const s = llmsSectionZh('https://vedarai.ru');
    expect(s).toContain(ZH_CONNECT.heading);
    for (const g of ZH_CLIENT_GUIDES) {
      const line = s.split('\n').find((l) => l.startsWith(`  - ${g.client}：`)) ?? '';
      expect(line, g.id).not.toBe('');
      expect(line, g.id).toContain('界面可能不同');
      expect(line, g.id).toContain('2026-10-15 查阅');
      for (const src of g.sources) expect(line, g.id).toContain(src.url);
    }
    expect(s).toContain(traeValue('trae_cn'));
  });
});
