/**
 * Обзор агента — общий формат кабинетов и отсутствие огрызков эмодзи.
 * Регрессия: в слотах иконок метрик жили пустые строки и "[]" (вырезанные
 * эмодзи), разделы Ваучеры/Статистика были недостижимы из меню.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const dashboard = readFileSync('app/hub/agent/_AgentDashboardClient.tsx', 'utf8');
const metrics = readFileSync('components/agent/Dashboard/AgentMetricsGrid.tsx', 'utf8');
const layout = readFileSync('app/hub/agent/layout.tsx', 'utf8');

describe('метрики агента', () => {
  it('иконки — lucide-чипы, строковых огрызков не осталось', () => {
    expect(metrics).not.toMatch(/icon="/);
    expect(metrics).toMatch(/MetricIcon/);
    expect(metrics).toMatch(/from 'lucide-react'/);
  });

  it('нет хардкод-красного — только токены (--danger)', () => {
    expect(metrics).not.toMatch(/red-400|red-500/);
    expect(metrics).toMatch(/var\(--danger\)/);
  });
});

describe('обзор агента — формат кабинетов', () => {
  it('плитки разделов (SectionsNav) как у гида/туриста', () => {
    expect(dashboard).toMatch(/SECTION_GROUPS/);
    expect(dashboard).toMatch(/SectionsNav/);
  });

  it('каждая страница из сайдбара (кроме Обзора) доступна с плиток', () => {
    const hrefs = [...layout.matchAll(/href: '(\/hub\/agent[^']*)'/g)]
      .map((m) => m[1])
      .filter((h) => h !== '/hub/agent');
    expect(hrefs.length).toBeGreaterThanOrEqual(9);
    for (const href of hrefs) {
      expect(dashboard, href).toContain(`href: '${href}'`);
    }
  });

  it('новые заявки видны на обзоре (вершина воронки — референс CRM)', () => {
    expect(dashboard).toMatch(/NewLeadsBanner/);
    expect(dashboard).toMatch(/\/api\/agent\/leads\?status=new/);
  });

  it('Ваучеры и Статистика вернулись в меню', () => {
    expect(layout).toContain("'/hub/agent/vouchers'");
    expect(layout).toContain("'/hub/agent/stats'");
  });
});
