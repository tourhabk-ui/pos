/**
 * Слияние семей маршрутов-тёзок — правила честности.
 *
 * Сторож стоит на двух чертах: сливать можно только настоящих тёзок
 * (перестановка слов — та же семья, другой набор слов — нет), и снятый
 * трек живой записи не перетирается ничем.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sameNameFamily, canTransferTrack, nameTokens } from '@/lib/routes/family-merge';

describe('одна ли семья имён', () => {
  it('перестановка слов — та же семья', () => {
    expect(sameNameFamily('Озеро Курильское', 'Курильское озеро')).toBe(true);
    expect(sameNameFamily('Авачинский вулкан', 'Вулкан Авачинский')).toBe(true);
    expect(sameNameFamily('Вачкажец. Горный массив', 'Горный массив Вачкажец')).toBe(true);
  });

  it('ё, регистр, тире и слово «Маршрут» не считаются различием', () => {
    expect(sameNameFamily('Озеро Толмачёва', 'озеро толмачева')).toBe(true);
    expect(sameNameFamily('Маршрут Пиначево - Центральный', 'Пиначево — Центральный')).toBe(true);
  });

  it('другой набор слов — не семья, даже при общем корне', () => {
    expect(sameNameFamily('Вилючинский водопад', 'Вулкан Вилючинский')).toBe(false);
    expect(sameNameFamily('Водопад Спокойный (Косы Вероники)', 'Водопад на ручье Спокойный')).toBe(false);
  });

  it('пустое имя не образует семьи ни с чем', () => {
    expect(sameNameFamily('', '')).toBe(false);
  });

  it('токены сортированы — сравнение не зависит от порядка', () => {
    expect(nameTokens('Курильское озеро')).toEqual(nameTokens('Озеро Курильское'));
  });
});

describe('перенос трека живой записи', () => {
  it('пустая геометрия — можно', () => {
    expect(canTransferTrack(null, false)).toBe(true);
  });

  it('синтетика и прежний kml_inbox — можно (правило инбокса)', () => {
    expect(canTransferTrack('waypoints_synthetic', true)).toBe(true);
    expect(canTransferTrack('kml_inbox', true)).toBe(true);
  });

  it('снятый или импортный трек живой записи не перетирается', () => {
    expect(canTransferTrack('osm', true)).toBe(false);
    expect(canTransferTrack('external', true)).toBe(false);
    expect(canTransferTrack('visitkamchatka', true)).toBe(false);
    expect(canTransferTrack(null, true)).toBe(false);
  });
});

describe('обещания эндпоинта', () => {
  const src = readFileSync(join(process.cwd(), 'app/api/cron/route-family-merge/route.ts'), 'utf-8');

  it('пары поимённые, боевая партия не больше 10, dry_run по умолчанию', () => {
    expect(src).toContain('LIVE_BATCH_MAX = 10');
    expect(src).toContain('dry_run: z.boolean().default(true)');
  });

  it('обе стороны проверяются на слитость, скрытая помечается merged_into_id', () => {
    expect(src).toContain('h.is_visible = false AND h.merged_into_id IS NULL');
    expect(src).toContain('l.is_visible = true AND l.merged_into_id IS NULL');
    expect(src).toContain('SET merged_into_id = $1');
  });

  it('перенос трека повторяет правило переносимости и в SQL', () => {
    expect(src).toContain("l.geometry IS NULL OR l.geometry->>'source' IN ('waypoints_synthetic', 'kml_inbox')");
  });
});
