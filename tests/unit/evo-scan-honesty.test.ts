/**
 * Честность Evo-сканера.
 *
 * 1. Захардкоженные списки growth-агента (DEAD_MODULES, TECH_DEBT_FILES)
 *    обязаны указывать на существующие файлы репо — иначе сканер репортит
 *    фантомы каждый цикл (июль 2026: 15 из 18 «проблем» были о файлах,
 *    которых давно нет, или о модулях, которые снова используются).
 *
 * 2. buildEvoAlert шлёт уведомление только когда есть новое: новые issues,
 *    алерты Спасателя, ошибки оркестратора или обработанные evolution-циклом
 *    задачи. Повторная детекция известных проблем — не повод будить владельца.
 */

import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { buildEvoAlert } from '@/lib/agents/evo/alert';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/lib/ai/providers', () => ({ callAIWithModelDirect: vi.fn() }));

describe('growth-agent: захардкоженные списки указывают на реальные файлы', () => {
  it('каждый путь DEAD_MODULES существует в репо', async () => {
    const { DEAD_MODULES } = await import('@/lib/agents/evo/growth-agent');
    for (const f of DEAD_MODULES) {
      expect(existsSync(join(process.cwd(), f)), `DEAD_MODULES: ${f} не существует — убрать из списка`).toBe(true);
    }
  });

  it('каждый путь TECH_DEBT_FILES существует в репо', async () => {
    const { TECH_DEBT_FILES } = await import('@/lib/agents/evo/growth-agent');
    for (const t of TECH_DEBT_FILES) {
      if (!t.file_path) continue;
      expect(existsSync(join(process.cwd(), t.file_path)), `TECH_DEBT_FILES: ${t.file_path} не существует — убрать из списка`).toBe(true);
    }
  });
});

describe('buildEvoAlert: алерт только когда есть новое', () => {
  const baseScan = (over: Record<string, unknown> = {}) => ({
    issues: [
      { severity: 'low', title: 'известная проблема' },
      { severity: 'critical', title: 'известная критичная' },
    ],
    new_issues: 0,
    duration_ms: 3000,
    ...over,
  });

  it('null, когда всё найденное — повторные детекции и нет ошибок', () => {
    const text = buildEvoAlert({
      scan: baseScan(),
      evolution: { processed: 0, auto_fixes: 0 },
      rescue: { alerts: [] },
      errors: [],
    });
    expect(text).toBeNull();
  });

  it('текст с числом новых, когда появились новые issues', () => {
    const text = buildEvoAlert({
      scan: baseScan({ new_issues: 2 }),
      evolution: { processed: 0, auto_fixes: 0 },
      rescue: { alerts: [] },
      errors: [],
    });
    expect(text).toContain('новых проблем: 2');
    expect(text).toContain('найдено всего 2');
    expect(text).toContain('критичных 1');
  });

  it('алерт уходит при алертах Спасателя даже без новых issues', () => {
    const text = buildEvoAlert({
      scan: baseScan(),
      evolution: { processed: 0, auto_fixes: 0 },
      rescue: { alerts: [{ severity: 'critical', title: 'SOS без ответа' }] },
      errors: [],
    });
    expect(text).toContain('Спасатель: 1 алертов');
  });

  it('алерт уходит при ошибках оркестратора', () => {
    const text = buildEvoAlert({
      scan: baseScan(),
      evolution: null,
      rescue: null,
      errors: ['GrowthScan: timeout'],
    });
    expect(text).toContain('GrowthScan: timeout');
  });

  it('алерт уходит, когда evolution реально обработал задачи', () => {
    const text = buildEvoAlert({
      scan: baseScan(),
      evolution: { processed: 3, auto_fixes: 1 },
      rescue: { alerts: [] },
      errors: [],
    });
    expect(text).toContain('обработано 3, автофиксов: 1');
  });

  it('переживает null-скан (упавший GrowthScan) без падения', () => {
    const text = buildEvoAlert({
      scan: null,
      evolution: null,
      rescue: null,
      errors: ['GrowthScan: db down'],
    });
    expect(text).toContain('Ошибки: GrowthScan: db down');
  });
});

describe('buildEvoAlert: ослепший прочёс — видимый алерт, а не тишина', () => {
  const cleanScan = (over: Record<string, unknown> = {}) => ({
    issues: [], new_issues: 0, duration_ms: 13000, ...over,
  });

  it('source=none при 0 новых — алерт всё равно уходит и говорит «ослеп»', () => {
    const text = buildEvoAlert({
      scan: cleanScan({ coverage: { source: 'none', files_listed: 0, files_reviewed: 0, mock_files_scanned: 0 } }),
      evolution: { processed: 0, auto_fixes: 0 },
      rescue: { alerts: [] },
      errors: [],
    });
    expect(text).not.toBeNull();
    expect(text).toContain('Прочёс ослеп');
    expect(text).toContain('source=none');
  });

  it('перечислил файлы, но прочитал 0 (тела недостижимы) — тоже ослеп', () => {
    const text = buildEvoAlert({
      scan: cleanScan({ coverage: { source: 'github', files_listed: 340, files_reviewed: 0, mock_files_scanned: 0 } }),
      evolution: { processed: 0, auto_fixes: 0 },
      rescue: { alerts: [] },
      errors: [],
    });
    expect(text).not.toBeNull();
    expect(text).toContain('Прочёс ослеп');
  });

  it('здоровый прочёс без новых проблем — по-прежнему тишина (null)', () => {
    // «Здоровый» с 01.08 включает записанную модель: прочёс с reviewed>0 и
    // без модели — это немой решатель, он тишины больше не получает.
    const text = buildEvoAlert({
      scan: cleanScan({ decision_model: 'anthropic/claude-opus-5', coverage: { source: 'disk', files_listed: 340, files_reviewed: 8, mock_files_scanned: 12 } }),
      evolution: { processed: 0, auto_fixes: 0 },
      rescue: { alerts: [] },
      errors: [],
    });
    expect(text).toBeNull();
  });

  it('здоровый прочёс с новыми проблемами — показывает строку покрытия', () => {
    const text = buildEvoAlert({
      scan: cleanScan({ new_issues: 1, issues: [{ severity: 'high', title: 'X' }], coverage: { source: 'disk', files_listed: 340, files_reviewed: 8, mock_files_scanned: 12 } }),
      evolution: { processed: 0, auto_fixes: 0 },
      rescue: { alerts: [] },
      errors: [],
    });
    expect(text).toContain('source=disk');
    expect(text).toContain('отревьюено 8');
    expect(text).toContain('мок-скан 12');
  });
});
