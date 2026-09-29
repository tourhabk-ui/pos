// @vitest-environment node
/**
 * MCP `get_volcano_status` называет вулкан по-русски, даже когда места в
 * каталоге нет.
 *
 * ── Что нашлось 29.09 (повторная сверка каналов) ──────────────────────────
 *
 * Чикурачки — оранжевый по KVERT, Парамушир, места в каталоге у него нет.
 * Пульс на сайте после правки показывает его русским именем, а MCP по-прежнему
 * отдавал агенту `CHIKURACHKI`: имя без места бралось из KVERT сырым, хотя
 * общий словарь (`kvert-vona`) русское имя знает. Агент, читающий «CHIKURACHKI
 * оранжевый», пересказывает человеку латиницу капсом.
 */
import { describe, it, expect } from 'vitest';
import { composeVolcanoReport, mergeVolcanoes, type VolcanoInput, type KvertRow } from '@/lib/kuzmich/volcano-tool';

const NOW = Date.parse('2026-09-29T06:00:00Z');

const kvert = (over: Partial<KvertRow>): KvertRow => ({
  ark: null, place_name: null, name: 'CHIKURACHKI', acc: 'orange', ash_height_m: null,
  observed_at: '2026-09-28T20:00:00Z', ...over,
});
const input = (rows: KvertRow[]): VolcanoInput => ({ kvert: rows, kfegsDate: null, kfegs: null });

describe('имя вулкана без места в каталоге', () => {
  it('латиница KVERT заменяется русским именем из общего словаря', () => {
    const [m] = mergeVolcanoes(input([kvert({})]), NOW);
    expect(m.name).toBe('Чикурачки');
  });

  it('латинское имя остаётся среди алиасов — поиск по нему жив', () => {
    const [m] = mergeVolcanoes(input([kvert({})]), NOW);
    expect(m.aliases).toContain('CHIKURACHKI');
    const report = composeVolcanoReport(input([kvert({})]), 'chikurachki', NOW);
    expect(report).toContain('Чикурачки');
    expect(report).not.toContain('CHIKURACHKI:');
  });

  it('в общем ответе вулкан назван по-русски', () => {
    const report = composeVolcanoReport(input([kvert({})]), undefined, NOW);
    expect(report).toContain('Чикурачки');
    expect(report, 'латиница капсом дошла до агента').not.toMatch(/CHIKURACHKI/);
  });

  it('у вулкана с местом остаётся имя места — оно точнее словаря', () => {
    const [m] = mergeVolcanoes(input([kvert({ ark: 'a1', place_name: 'Вулкан Шивелуч', name: 'SHEVELUCH' })]), NOW);
    expect(m.name).toBe('Вулкан Шивелуч');
  });

  it('незнакомое имя остаётся как есть: «похожее» не подставляется', () => {
    const [m] = mergeVolcanoes(input([kvert({ name: 'NOVYJ_VULKAN_X' })]), NOW);
    expect(m.name).toBe('NOVYJ_VULKAN_X');
  });
});
