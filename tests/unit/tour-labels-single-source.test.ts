/**
 * Сторож единого словаря подписей тура (lib/tours/labels.ts).
 *
 * Повод — аудит 2026-08-03. `ACTIVITY_LABELS` был скопирован в 12 файлов, и
 * копии разошлись так, что один тур подписывался по-разному в зависимости от
 * страницы. Самое опасное — `boat_trip` («морская прогулка») в двух копиях
 * назывался «Сплав», то есть выдавался за сплав по реке; а `rafting` в одной
 * копии звался «Рафтинг», хотя тур по Быстрой — спокойный семейный сплав, и
 * слово «рафтинг» обещает туристу другое (миграция 802).
 *
 * Сторож держит два инварианта: словарь один, и в нём нет столкновений смысла.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  ACTIVITY_LABELS, ACTIVITY_SHORT, DIFFICULTY_LABELS,
  activityLabel, difficultyLabel, priceUnitLabel,
} from '@/lib/tours/labels';

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.next', 'dist', 'coverage', '_archive']);
const DICT = 'lib/tours/labels.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const FILES = ['app', 'components'].flatMap(d => walk(join(ROOT, d)));

describe('подписи тура живут в одном словаре', () => {
  it('в app/ и components/ нет своих ACTIVITY_LABELS', () => {
    const offenders = FILES
      .filter(f => relative(ROOT, f) !== DICT)
      .filter(f => /const\s+ACTIVITY_LABELS\s*[:=]/.test(readFileSync(f, 'utf-8')))
      .map(f => relative(ROOT, f));
    expect(offenders, 'снова завели свой словарь подписей — копии разойдутся')
      .toEqual([]);
  });
});

describe('в словаре нет столкновений смысла', () => {
  it('морская прогулка не называется сплавом', () => {
    expect(ACTIVITY_LABELS.boat_trip).not.toMatch(/сплав/i);
    expect(ACTIVITY_SHORT.boat_trip ?? '').not.toMatch(/сплав/i);
  });

  it('сплав по Быстрой не обещает спортивный рафтинг', () => {
    expect(ACTIVITY_LABELS.rafting).toBe('Сплав');
    expect(ACTIVITY_LABELS.rafting).not.toMatch(/рафтинг/i);
  });

  it('одна подпись — один тип: дублей значений нет', () => {
    const values = Object.values(ACTIVITY_LABELS);
    expect(new Set(values).size, `дубли подписей: ${values.join(', ')}`)
      .toBe(values.length);
  });

  it('подписи набраны кириллицей (была «Фototур» с латиницей)', () => {
    for (const [key, label] of Object.entries(ACTIVITY_LABELS)) {
      expect(/[a-zA-Z]/.test(label), `${key}: латиница в «${label}»`).toBe(false);
    }
  });
});

describe('неизвестное не выдумывается', () => {
  it('незнакомый тип возвращается как есть, а не подменяется', () => {
    expect(activityLabel('esoteric')).toBe('esoteric');
    expect(difficultyLabel('unknown')).toBe('unknown');
  });

  it('пустое остаётся пустым', () => {
    expect(activityLabel(null)).toBe('');
    expect(activityLabel(undefined)).toBe('');
  });

  it('короткая подпись падает на полную, если короткой нет', () => {
    expect(activityLabel('fishing', true)).toBe(ACTIVITY_LABELS.fishing);
  });

  it('единица цены имеет разумный дефолт', () => {
    expect(priceUnitLabel(null)).toBe('за человека');
    expect(priceUnitLabel(null, true)).toBe('/чел.');
  });

  it('сложность отдаёт токен цвета, а не хардкод-hex', () => {
    for (const d of Object.values(DIFFICULTY_LABELS)) {
      expect(d.color).toMatch(/^var\(--/);
    }
  });
});
