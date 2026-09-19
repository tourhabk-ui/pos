// @vitest-environment node
/**
 * Тип места называется одинаково везде — и по-русски.
 *
 * ── Что нашлось 19.09 ─────────────────────────────────────────────────────
 *
 * Словарь типов лежал в ПЯТИ файлах: карточка маршрута (19 ключей),
 * components/places/types.ts (20), обогатитель Кузьмича (15), PDF-карточка
 * (15), админка туров (8). Ключей на всех — двадцать четыре, и ни один список
 * не знал их все.
 *
 * Каждый употреблялся как `MAP[t] ?? t`, поэтому незнакомый тип выходил на
 * экран СЫРЫМ английским словом. На карточке маршрута — главной инструкции
 * туриста — так выводились `pass`, `plateau`, `valley`, `park` и `thermal`:
 * путевая точка «перевал» подписывалась словом `pass` ровно там, где человек
 * читает, через что он пойдёт.
 *
 * Расходились и знакомые ключи: `forest` назывался четырьмя способами,
 * `mountain` тремя, `geyser` двумя.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { LOCATION_TYPES, locationTypeLabel, locationTypeLabelLower } from '@/lib/places/location-types';

const ROOT = process.cwd();
const SOURCE = 'lib/places/location-types.ts';
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === '.git') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

describe('список типов мест один', () => {
  it('второго объявления нет ни в одном файле', () => {
    const offenders: string[] = [];
    for (const dir of ['app', 'components', 'lib']) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file);
        if (rel === SOURCE) continue;
        if (/const\s+LOCATION_TYPES?(_LABELS)?\s*:\s*Record<[^>]*>\s*=\s*\{/.test(readFileSync(file, 'utf-8'))) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders, `типы объявлены ещё раз — берите их из ${SOURCE}`).toEqual([]);
  });

  it('союз ключей сохранён: что знал хоть один список, знает общий', () => {
    const FROM_CENSUS = [
      'bay', 'beach', 'cape', 'forest', 'geyser', 'glacier', 'historical',
      'hot_spring', 'island', 'lake', 'mountain', 'museum', 'other', 'park',
      'pass', 'plateau', 'river', 'rock', 'settlement', 'thermal', 'valley',
      'viewpoint', 'volcano', 'waterfall',
    ];
    expect(FROM_CENSUS.filter(k => !(k in LOCATION_TYPES))).toEqual([]);
    expect(Object.keys(LOCATION_TYPES).length).toBe(FROM_CENSUS.length);
  });

  it('путевые точки маршрута называются по-русски, а не ключом', () => {
    // Ровно те пять, что выводились сырыми.
    expect(locationTypeLabel('pass')).toBe('Перевал');
    expect(locationTypeLabel('plateau')).toBe('Плато');
    expect(locationTypeLabel('valley')).toBe('Долина');
    expect(locationTypeLabel('park')).toBe('Природный парк');
    expect(locationTypeLabel('thermal')).toBe('Термальная зона');
  });

  it('две подписи не совпадают — иначе типы неразличимы на экране', () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const [key, label] of Object.entries(LOCATION_TYPES)) {
      const prev = seen.get(label);
      if (prev) clashes.push(`${prev} и ${key} оба «${label}»`);
      else seen.set(label, key);
    }
    expect(clashes, 'ровно из-за этого `forest` не может быть «Природным парком»').toEqual([]);
  });

  it('подписи русские и с заглавной', () => {
    const bad = Object.entries(LOCATION_TYPES)
      .filter(([, l]) => !/^[А-ЯЁ]/.test(l) || /[a-z]/i.test(l))
      .map(([k, l]) => `${k}: ${l}`);
    expect(bad).toEqual([]);
  });
});

describe('исход для неизвестного типа', () => {
  it('без запаса — сырой ключ: он виден и чинится', () => {
    expect(locationTypeLabel('zzz_unknown')).toBe('zzz_unknown');
  });

  it('с запасом — слово вызывающего', () => {
    // Карточка маршрута подписывает САМ МАРШРУТ, и «Маршрут» — её слово, а не
    // название типа: в общий словарь оно не попало намеренно.
    expect(locationTypeLabel('zzz_unknown', 'Маршрут')).toBe('Маршрут');
    expect(locationTypeLabel(null, 'Маршрут')).toBe('Маршрут');
  });

  it('пустой тип без запаса — «Место», а не пустота', () => {
    expect(locationTypeLabel(null)).toBe('Место');
    expect(locationTypeLabelLower('volcano')).toBe('вулкан');
  });
});

describe('потребители берут слова из источника', () => {
  const consumers: Array<[string, string]> = [
    ['app/routes/[id]/_RouteDetailClient.tsx', 'locationTypeLabel'],
    ['lib/pdf/place-card-generator.ts', 'locationTypeLabel'],
    ['lib/agents/kuzmich-place-enricher.ts', 'locationTypeLabelLower'],
    ['app/hub/admin/content/tours/page.tsx', 'locationTypeLabel'],
  ];

  for (const [file, fn] of consumers) {
    it(`${file} зовёт ${fn}`, () => {
      const src = read(file);
      expect(src).toContain("from '@/lib/places/location-types'");
      expect(src).toContain(`${fn}(`);
    });
  }

  it('PDF больше не печатает КАПС латиницей вместо названия', () => {
    // Прежний запас был `place.locationType.toUpperCase()`: в бумажной
    // карточке это `PASS` — читается хуже сырого ключа и ничего не сообщает.
    expect(read('lib/pdf/place-card-generator.ts')).not.toContain('locationType.toUpperCase()');
  });

  it('карточка маршрута сохранила своё запасное слово', () => {
    expect(read('app/routes/[id]/_RouteDetailClient.tsx')).toContain("locationTypeLabel(route.locationType, 'Маршрут')");
  });
});
