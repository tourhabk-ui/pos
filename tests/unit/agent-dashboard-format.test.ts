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
    // 9 → 8 (26.09): «Заявки» ушли из кабинета агента — ПД туристов (agent-leads-closed).
    // 8 → 7 (26.09): «Ваучеры» удалены — таблицы vouchers нет (agent-pack-a).
    expect(hrefs.length).toBeGreaterThanOrEqual(7);
    for (const href of hrefs) {
      expect(dashboard, href).toContain(`href: '${href}'`);
    }
  });

  it('заявок платформы на обзоре агента нет — это ПД туристов (26.09)', () => {
    expect(dashboard).not.toMatch(/NewLeadsBanner/);
    expect(dashboard).not.toMatch(/\/api\/agent\/leads/);
  });

  it('Статистика в меню; Ваучеров нет — таблицы vouchers нет (26.09)', () => {
    expect(layout).not.toContain("'/hub/agent/vouchers'");
    expect(dashboard).not.toContain("'/hub/agent/vouchers'");
    expect(layout).toContain("'/hub/agent/stats'");
  });
});
