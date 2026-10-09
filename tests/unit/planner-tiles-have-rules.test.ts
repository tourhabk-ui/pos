/**
 * Сторож: каждая плитка интереса в /planner подбирается движком.
 *
 * Плитка обещает дни под свой интерес. «Озёра» и «Экотуризм» стояли без
 * правил подбора (ACTIVITY_CONSTRAINTS): движок молча выбрасывал их из
 * выбора зон, из сборки дней и даже из сезонных предупреждений
 * (`if (!c) continue`). Человек выбирал «Озёра» и получал план без озёр и без
 * слова о том, почему (разбор планера 09.10, сравнение с конструктором
 * «Лагуны Экспедиции»).
 *
 * Правило для движка завести нельзя без данных: зоны, сезоны и цены интереса
 * пришлось бы выдумать (§4.0). Поэтому плитки сняты, и сторож держит связку:
 * новая плитка без правила краснеет сама.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVITY_CONSTRAINTS } from '@/lib/planner/constants';

const CLIENT = readFileSync(join(process.cwd(), 'app/planner/_PlannerClient.tsx'), 'utf-8');

/** id плиток из объявления списка на экране. */
function tileIds(list: 'PLACES' | 'ACTIVITIES'): string[] {
  const start = CLIENT.indexOf(`const ${list}: SelectItem[] = [`);
  expect(start, `список ${list} не найден — сторож не может проверить плитки`).toBeGreaterThan(-1);
  const end = CLIENT.indexOf('];', start);
  return [...CLIENT.slice(start, end).matchAll(/id:\s*'([a-z_]+)'/g)].map((m) => m[1]);
}

/** Ключи движка, которые экран переименовывает в плитку (ENGINE_KEY_TO_TILE). */
function engineKeysFor(tile: string): string[] {
  const start = CLIENT.indexOf('const ENGINE_KEY_TO_TILE');
  const end = CLIENT.indexOf('};', start);
  return [...CLIENT.slice(start, end).matchAll(/([a-z_]+):\s*'([a-z_]+)'/g)]
    .filter((m) => m[2] === tile)
    .map((m) => m[1]);
}

describe('плитки интересов /planner', () => {
  const tiles = [...tileIds('PLACES'), ...tileIds('ACTIVITIES')];

  it('список разобран — проверять есть что', () => {
    expect(tiles.length).toBeGreaterThanOrEqual(10);
  });

  it('у каждой плитки есть правило подбора в движке', () => {
    const orphans = tiles.filter(
      (t) => !ACTIVITY_CONSTRAINTS[t] && !engineKeysFor(t).some((k) => ACTIVITY_CONSTRAINTS[k]),
    );
    expect(orphans, `плитки без правила в ACTIVITY_CONSTRAINTS: ${orphans.join(', ')}`).toEqual([]);
  });

  it('пресеты настроения ставят только существующие плитки', () => {
    const start = CLIENT.indexOf('const MOOD_PRESETS');
    const block = CLIENT.slice(start, CLIENT.indexOf('};', start));
    const used = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    const known = new Set(tiles);
    expect(used.filter((u) => !known.has(u))).toEqual([]);
  });
});
