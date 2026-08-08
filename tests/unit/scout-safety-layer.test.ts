/**
 * Раздел «Камчатка» кормится из safety-слоя (решение владельца 08.08:
 * «делай камчатку из safety-слоя»).
 *
 * История: kamgov/mchs_rss сняты 01.08 (сайты убили ленты), с тех пор раздел
 * «Камчатка» был пуст ПО ПОСТРОЕНИЮ — ни одного источника категории
 * 'kamchatka', и дайджест честно писал «нет сигналов» каждый день. При этом
 * собственный мониторинг (сейсмика КБГС, МЧС t.me/vk/max, kamgov-XML, пожары
 * FIRMS) всё это время складывал события региона в external_alerts — данные
 * были, дайджест их не видел.
 *
 * Сторож держит: источник подключён к прогону, читает свежие алерты с
 * приоритетом по severity, честно классифицирует пустой день, и сторожится
 * наравне с RSS-фидами.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SAFETY_LAYER_SOURCE, alertsToItems } from '@/lib/agents/scout-digest';
import { SCOUT_SOURCE_EXPECTATIONS } from '@/lib/services/scout/source-health';

const SRC = readFileSync(join(process.cwd(), 'lib/agents/scout-digest.ts'), 'utf-8');

describe('safety-слой как источник раздела «Камчатка»', () => {
  it('источник объявлен в категории kamchatka', () => {
    expect(SAFETY_LAYER_SOURCE.key).toBe('safety_layer');
    expect(SAFETY_LAYER_SOURCE.category).toBe('kamchatka');
  });

  it('подключён к прогону рядом с RSS-фидами', () => {
    expect(SRC).toMatch(/Promise\.all\(\[\.\.\.RSS_SOURCES\.map\(fetchSource\), fetchSafetyLayerSource\(\)\]\)/);
  });

  it('читает external_alerts за суточное окно с приоритетом по severity', () => {
    const fn = /async function fetchSafetyLayerSource[\s\S]*?\n\}/.exec(SRC)![0];
    expect(fn).toMatch(/FROM external_alerts/);
    expect(fn).toMatch(/INTERVAL '25 hours'/);
    expect(fn).toMatch(/ORDER BY severity DESC/);
    expect(fn).toMatch(/LIMIT \$1/);
  });

  it('модель знает, что такое пометка [Safety-слой]', () => {
    expect(SRC).toContain('Сигналы с пометкой [Safety-слой]');
  });

  it('метаданные выпуска называют safety-слой среди источников', () => {
    expect(SRC).toMatch(/ALL_SOURCE_LABELS = \[\.\.\.RSS_SOURCES\.map\(s => s\.label\), SAFETY_LAYER_SOURCE\.label\]/);
    expect(SRC).toMatch(/sources: ALL_SOURCE_LABELS/);
  });
});

describe('alertsToItems: строки БД → сигналы дайджеста', () => {
  it('маппит заголовок и ссылку, помечает источником safety-слоя', () => {
    const items = alertsToItems([
      { title: 'Землетрясение ML 5.2 — восточнее Петропавловска', source_url: 'https://t.me/kbgs/123' },
    ]);
    expect(items).toEqual([{
      title: 'Землетрясение ML 5.2 — восточнее Петропавловска',
      url: 'https://t.me/kbgs/123',
      source: 'Safety-слой',
    }]);
  });

  it('алерт без ссылки не теряется — url пустой, ключом дедупа станет заголовок', () => {
    const items = alertsToItems([{ title: 'Закрыта дорога на Вачкажец', source_url: null }]);
    expect(items).toHaveLength(1);
    expect(items[0]!.url).toBe('');
  });

  it('пустые и односимвольные заголовки отсеиваются', () => {
    expect(alertsToItems([
      { title: null, source_url: null },
      { title: '  ', source_url: null },
      { title: 'x', source_url: null },
    ])).toEqual([]);
  });
});

describe('сторож тишины safety-слоя', () => {
  it('источник сторожится: неделя без единого события — тревога, а не «тихо»', () => {
    const exp = SCOUT_SOURCE_EXPECTATIONS.find((e) => e.key === 'safety_layer');
    expect(exp, 'safety_layer обязан быть в SCOUT_SOURCE_EXPECTATIONS').toBeDefined();
    expect(exp!.maxSilenceHours).toBe(168);
  });
});
