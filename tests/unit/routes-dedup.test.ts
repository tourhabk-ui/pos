/**
 * Актуатор слияния маршрутов — правила, обсуждённые с владельцем 15.08.
 *
 * Сторож держит три обещания: валидация пар отказывает целиком (без
 * частичного применения), настоящий трек побеждает синтетику и только её,
 * каждый чувствительный перенос называется warning'ом.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  pairListProblems, isRealTrack, shouldAdoptGeometry, pairWarnings,
  type GeometryInfo, type PairFacts,
} from '@/lib/routes/dedup';

const ROOT = process.cwd();

const real: GeometryInfo = { present: true, source: 'idilesom' };
const unmarked: GeometryInfo = { present: true, source: null };
const synthetic: GeometryInfo = { present: true, source: 'waypoints_synthetic' };
const empty: GeometryInfo = { present: false, source: null };

describe('валидация пар', () => {
  it('keep === merge — проблема', () => {
    expect(pairListProblems([{ keep: 'a', merge: 'a' }])).toHaveLength(1);
  });

  it('merge, стоящий и как keep, — проблема', () => {
    expect(pairListProblems([
      { keep: 'a', merge: 'b' },
      { keep: 'b', merge: 'c' },
    ])).toHaveLength(1);
  });

  it('один merge дважды — проблема', () => {
    expect(pairListProblems([
      { keep: 'a', merge: 'c' },
      { keep: 'b', merge: 'c' },
    ])).toHaveLength(1);
  });

  it('один keep для нескольких merge — разрешён (три Долины Смерти за заход)', () => {
    expect(pairListProblems([
      { keep: 'a', merge: 'b' },
      { keep: 'a', merge: 'c' },
    ])).toHaveLength(0);
  });
});

describe('правило геометрии: настоящий трек побеждает', () => {
  it('немаркированная геометрия — настоящая (старые импорты не писали source)', () => {
    expect(isRealTrack(unmarked)).toBe(true);
  });

  it('keep пустой + merge настоящий → трек переезжает', () => {
    expect(shouldAdoptGeometry(empty, real)).toBe(true);
  });

  it('keep синтетика + merge настоящий → трек переезжает', () => {
    expect(shouldAdoptGeometry(synthetic, real)).toBe(true);
  });

  it('keep настоящий → своё не отдаём, даже если у merge тоже настоящий', () => {
    expect(shouldAdoptGeometry(real, real)).toBe(false);
    expect(shouldAdoptGeometry(unmarked, real)).toBe(false);
  });

  it('merge синтетика → не переезжает никогда', () => {
    expect(shouldAdoptGeometry(empty, synthetic)).toBe(false);
    expect(shouldAdoptGeometry(synthetic, synthetic)).toBe(false);
  });
});

describe('предупреждения — чувствительное называется вслух', () => {
  const base: PairFacts = {
    keepName: 'Поход вокруг Толбачиков', mergeName: 'Поход вокруг Толбачиков. Камчатка',
    keepGeometry: real, mergeGeometry: empty, mergeTours: 0, mergeHasPassport: false,
  };

  it('тихая пара — без предупреждений', () => {
    expect(pairWarnings(base)).toHaveLength(0);
  });

  it('переезд трека называется', () => {
    const w = pairWarnings({ ...base, keepGeometry: synthetic, mergeGeometry: real });
    expect(w.some(x => x.includes('переезжает'))).toBe(true);
  });

  it('два настоящих трека — warning о непере несённом', () => {
    const w = pairWarnings({ ...base, keepGeometry: real, mergeGeometry: real });
    expect(w.some(x => x.includes('ОБОИХ'))).toBe(true);
  });

  it('туры на дубле — warning обязателен', () => {
    const w = pairWarnings({ ...base, mergeTours: 2 });
    expect(w.some(x => x.includes('тур'))).toBe(true);
  });

  it('паспорт дубля — warning, не перенос', () => {
    const w = pairWarnings({ ...base, mergeHasPassport: true });
    expect(w.some(x => x.includes('паспортные'))).toBe(true);
  });
});

describe('обещания эндпоинта', () => {
  it('routes-dedup — только поимённый режим, авто-режима нет', () => {
    const src = readFileSync(join(ROOT, 'app/api/cron/routes-dedup/route.ts'), 'utf-8');
    expect(src).toContain('pairs');
    expect(src, 'появился авто-режим по похожести — конструкция запрещает').not.toContain('similarity(');
  });

  it('VIEW фильтрует слитые маршруты (миграция 869)', () => {
    const sql = readFileSync(join(ROOT, 'migrations/869_routes_soft_merge.sql'), 'utf-8');
    expect(sql).toMatch(/FROM kamchatka_routes r\s+WHERE r\.merged_into_id IS NULL/);
    // фильтр мест из 863-й не потерян
    expect(sql).toMatch(/FROM places p\s+WHERE p\.merged_into_id IS NULL/);
  });
});
