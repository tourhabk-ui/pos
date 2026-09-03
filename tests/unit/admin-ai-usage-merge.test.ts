// @vitest-environment node
/**
 * Перепись админ-панели 03.09: «Расходы AI» и «AI Кузьмич» — одна страница.
 *
 * Обе читали один журнал ai_actions_log с двух плиток в разных разделах
 * меню (владелец: «смотри сколько AI-инструментов, что дублируется?»). Два
 * входа на один источник — не два инструмента, а один, показанный дважды.
 *
 * Сторож держит три вещи: плитки «AI Кузьмич» в меню больше нет; старый адрес
 * не отдаёт 404, а редиректится на вкладку; у страницы «Расходы AI» есть обе
 * вкладки и вкладка берётся из адреса — иначе редирект открывал бы не то.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const LAYOUT = read('app/hub/admin/layout.tsx').replace(/^\s*\/\/.*$/gm, '');
const PAGE = read('app/hub/admin/ai-usage/page.tsx');
const CONFIG = read('next.config.js');
const AGENTS = read('app/hub/admin/agents/_AgentsClient.tsx');

describe('«AI Кузьмич» больше не отдельная плитка', () => {
  it('в меню админки нет /hub/admin/ai-analytics', () => {
    expect(LAYOUT).not.toMatch(/href:\s*'\/hub\/admin\/ai-analytics'/);
  });

  it('страницы /hub/admin/ai-analytics нет — есть редирект на вкладку', () => {
    expect(existsSync(join(process.cwd(), 'app/hub/admin/ai-analytics/page.tsx'))).toBe(false);
    expect(CONFIG).toMatch(/source:\s*'\/hub\/admin\/ai-analytics',\s*destination:\s*'\/hub\/admin\/ai-usage\?tab=kuzmich'/);
  });

  it('ссылка из «AI и автоматизации» ведёт на вкладку, а не на снятый адрес', () => {
    expect(AGENTS).toContain('/hub/admin/ai-usage?tab=kuzmich');
    expect(AGENTS).not.toContain('"/hub/admin/ai-analytics"');
  });
});

describe('«Расходы AI» — две вкладки на одном журнале', () => {
  it('рендерит аналитику Кузьмича вкладкой', () => {
    expect(PAGE).toMatch(/import KuzmichAnalyticsClient from '\.\/_KuzmichAnalyticsClient'/);
    expect(PAGE).toMatch(/tab === 'kuzmich' \? \(\s*<KuzmichAnalyticsClient \/>/);
  });

  it('вкладка берётся из адреса — редирект и старые ссылки открывают нужную', () => {
    expect(PAGE).toMatch(/get\('tab'\) === 'kuzmich'/);
    // После монтирования, не при рендере: на сервере window нет.
    expect(PAGE).toMatch(/useEffect\(\(\) => \{ setTab\(tabFromLocation\(\)\); \}, \[\]\)/);
  });

  it('переключение не перезагружает страницу — адрес правится replaceState', () => {
    expect(PAGE).toMatch(/window\.history\.replaceState/);
  });
});
