/**
 * Инвариант мягкого слияния: слитая запись не бывает на витрине.
 *
 * Проба 109 вскрыла состояние «видимая, но слитая»: актуатор семей слил
 * запись 15.08 (скрыта, merged_into_id), а restore близнецов 17.08 вернул
 * ей is_visible = true, не глядя на слитость. Дальше запись жила в щели
 * между определениями живости: поиск фильтровал только is_visible и
 * ПОКАЗЫВАЛ её, аудит считал живыми is_visible AND merged IS NULL и НЕ
 * считал её, слияния 885/886 работали с guard merged_into_id IS NULL и
 * пропускали её. Три поверхности — три разных «живая», и дефект не видел
 * никто.
 *
 * Данные починила миграция 887; этот сторож держит кодовую половину:
 * каждое место, где живость решается, обязано смотреть на ОБА поля.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('слитая запись не бывает на витрине', () => {
  it('restore близнецов не возвращает слитую: merged_into_id — не «скрыта», а «записи больше нет»', () => {
    const src = read('app/api/cron/route-twins-hide/route.ts');
    const restore = src.match(/SET is_visible = true[\s\S]{0,200}?RETURNING/);
    expect(restore, 'restore-ветка не найдена').not.toBeNull();
    expect(restore![0]).toContain('merged_into_id IS NULL');
  });

  it('актуатор семей гасит видимость сам, а не предполагает её погашенной', () => {
    const src = read('app/api/cron/route-family-merge/route.ts');
    const merge = src.match(/SET merged_into_id = \$1[^`]*/);
    expect(merge, 'UPDATE слияния не найден').not.toBeNull();
    expect(merge![0]).toContain('is_visible = false');
  });

  it('поиск маршрутов судит живость обоими полями в обеих ветках', () => {
    const src = read('app/api/routes/search/route.ts');
    const guards = src.match(/merged_into_id IS NULL/g) ?? [];
    expect(guards.length, 'фильтр слитости нужен и semantic-обогащению, и ILIKE-фоллбэку').toBeGreaterThanOrEqual(2);
  });
});
