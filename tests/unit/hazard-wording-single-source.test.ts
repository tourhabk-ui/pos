// @vitest-environment node
/**
 * Опасность называется одинаково везде.
 *
 * ── Что нашлось 19.09 ─────────────────────────────────────────────────────
 *
 * Список названий опасностей лежал в ШЕСТИ файлах, и все шесть разошлись.
 * Ключей на всех оказалось девятнадцать, и ни один список не знал их все;
 * каждый употреблялся как `MAP[h] ?? h`, то есть незнакомый ключ уходил
 * дальше СЫРЫМ — английским словом посреди русского текста.
 *
 * Цена росла с удалением от экрана:
 *
 *   • контекст Кузьмича не знал `bears` — на Камчатке; не знал также `fog`,
 *     `ice`, `no_signal`, `river_crossing`;
 *   • PDF-карточка, которую турист берёт В ПОЛЕ, не знала `fog`, `ice`,
 *     `no_signal`, `wildlife`;
 *   • «Высота» / «высотная болезнь» / «Высокогорье (>2500м)» — одна опасность
 *     тремя именами, причём третье утверждало порог, которого нет в данных.
 *
 * Та же болезнь, что с шириной карточки и стандартом линии: правило,
 * написанное шесть раз, — это шесть правил. Здесь расходились слова о
 * безопасности.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { HAZARDS, hazardLabel, hazardLabelLower, hazardPhrase } from '@/lib/safety/hazard-labels';

const ROOT = process.cwd();
const SOURCE = 'lib/safety/hazard-labels.ts';
const SCAN_DIRS = ['app', 'components', 'lib'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.git']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

describe('список названий опасностей один', () => {
  it('второго объявления нет ни в одном файле', () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file);
        if (rel === SOURCE) continue;
        const src = readFileSync(file, 'utf-8');
        // Объявление, а не употребление: `const X: Record<...> = {` с ключом
        // опасности внутри. Ищем именно присваивание карты.
        if (/const\s+HAZARD(_LABELS|S)?\s*:\s*Record<[^>]*>\s*=\s*\{/.test(src)) {
          offenders.push(rel);
        }
      }
    }
    expect(
      offenders,
      'названия опасностей объявлены ещё раз — шесть копий уже разошлись, '
      + `берите их из ${SOURCE}`,
    ).toEqual([]);
  });

  it('союз ключей сохранён: то, что знал хоть один список, знает общий', () => {
    // Ключи, найденные переписью 19.09 по всем шести копиям.
    const FROM_CENSUS = [
      'bears', 'wildlife', 'avalanche', 'rockfall', 'thermal', 'volcanic_gas',
      'altitude', 'river_crossing', 'fog', 'ice', 'no_signal', 'weather',
      'crevasses', 'flash_flood', 'no_trail', 'unstable_ground',
      'chemical', 'rapids', 'water',
    ];
    const missing = FROM_CENSUS.filter(k => !(k in HAZARDS));
    expect(missing, 'ключ знал хотя бы один прежний список — потерять его нельзя').toEqual([]);
    expect(Object.keys(HAZARDS).length).toBe(FROM_CENSUS.length);
  });

  it('у каждой опасности есть и ярлык, и фраза', () => {
    const broken = Object.entries(HAZARDS)
      .filter(([, w]) => !w.label?.trim() || !w.phrase?.trim())
      .map(([k]) => k);
    expect(broken).toEqual([]);
  });

  it('фраза УТВЕРЖДАЕТ, а не советует', () => {
    // Совет зависит от маршрута, сезона, группы и снаряжения; этот файл знает
    // только вид опасности. Инструкция без обстоятельств — выдуманный факт,
    // которому верят в поле.
    const INSTRUCTION = /(держите|носите|возьмите|не\s+\w+йте|обязательно|нельзя|следует|должны)/i;
    const advisory = Object.entries(HAZARDS)
      .filter(([, w]) => INSTRUCTION.test(w.phrase))
      .map(([k, w]) => `${k}: ${w.phrase}`);
    expect(advisory, 'фраза стала инструкцией — совет живёт на маршруте, не в словаре').toEqual([]);
  });

  it('ярлык не утверждает того, чего нет в данных', () => {
    // «Высокогорье (>2500м)» из PDF утверждало порог, которого в записи места
    // нет. Чисел в ярлыках быть не должно вовсе.
    const numeric = Object.entries(HAZARDS)
      .filter(([, w]) => /\d/.test(w.label))
      .map(([k, w]) => `${k}: ${w.label}`);
    expect(numeric).toEqual([]);
  });
});

describe('исход для неизвестного ключа выбирает поверхность', () => {
  it('на экране сырой ключ виден — так вели себя все экранные копии', () => {
    expect(hazardLabel('zzz_unknown')).toBe('zzz_unknown');
    expect(hazardLabelLower('zzz_unknown')).toBe('zzz_unknown');
  });

  it('фразы у неизвестного нет — выдумывать её не из чего', () => {
    expect(hazardPhrase('zzz_unknown')).toBeNull();
  });

  it('у советов Кузьмича исход ОБРАТНЫЙ и это записано в коде', () => {
    const ADVISORY = readFileSync(join(ROOT, 'lib/kuzmich/place-advisory.ts'), 'utf-8');
    // Фразу произносят человеку: английское слово внутри русского совета хуже
    // пропуска. Поэтому здесь `?.label` + filter, а не запасной сырой ключ.
    expect(ADVISORY).toContain("HAZARDS[h]?.label.toLocaleLowerCase('ru-RU')");
    expect(ADVISORY).toContain('.filter(Boolean)');
  });
});

describe('потребители берут слова из источника', () => {
  const consumers = [
    ['components/shared/HazardBadgeStrip.tsx', 'hazardLabel'],
    ['app/api/tools/safety/route.ts', 'hazardLabel'],
    ['lib/kuzmich/guardian-context.ts', 'hazardLabelLower'],
    ['lib/pdf/place-card-generator.ts', 'hazardLabel'],
  ] as const;

  for (const [file, fn] of consumers) {
    it(`${file} зовёт ${fn}`, () => {
      const src = readFileSync(join(ROOT, file), 'utf-8');
      expect(src).toContain("from '@/lib/safety/hazard-labels'");
      expect(src).toContain(`${fn}(`);
    });
  }

  it('контекст Кузьмича теперь знает медведей', () => {
    expect(hazardLabelLower('bears')).toBe('медведи');
  });
});

/**
 * Срез 4 направления D: на карточке места опасности сказаны предложениями.
 *
 * Бейдж «Термальные зоны» человек ещё должен расшифровать сам; строка «Есть
 * термальные зоны — горячая земля и вода» читается сразу. Бейджи при этом
 * остаются на маршруте и в инструменте безопасности — там формат списком
 * уместен, и менять его никто не просил.
 */
describe('карточка места говорит опасностями, а не ярлыками', () => {
  const CLIENT = readFileSync(join(ROOT, 'app', 'places', '[id]', '_PlaceDetailClient.tsx'), 'utf-8');
  const STRIP = readFileSync(join(ROOT, 'components', 'shared', 'HazardBadgeStrip.tsx'), 'utf-8');

  it('карточка рисует фразы, а не бейджи', () => {
    expect(CLIENT).toContain('<HazardPhraseList');
    expect(CLIENT).not.toContain('<HazardBadgeStrip');
  });

  it('оба вида живут в одном файле — уровень и иконки не раздваиваются', () => {
    expect(STRIP).toContain('export function HazardPhraseList');
    expect(STRIP).toContain('export function HazardBadgeStrip');
    expect((STRIP.match(/const HAZARD_SEVERITY/g) ?? []).length).toBe(1);
    expect((STRIP.match(/function HazardIcon/g) ?? []).length).toBe(1);
  });

  it('опасность без фразы не исчезает — остаётся ярлык', () => {
    expect(STRIP).toContain('hazardPhrase(h) ?? hazardLabel(h)');
  });

  it('ссылка на регистрацию МЧС одна и та же у обоих видов', () => {
    // Считаем УПОТРЕБЛЕНИЯ в href, а не вхождения имени: строка импорта — тоже
    // вхождение, и первая редакция этой проверки покраснела на ней.
    expect((STRIP.match(/href=\{MCHS_ONLINE_FORM_URL\}/g) ?? []).length).toBe(2);
    expect(STRIP).not.toMatch(/https:\/\/[^\s'"]*mchs/i);
  });

  it('бейджи остались там, где их не просили менять', () => {
    for (const f of ['app/routes/[id]/_RouteDetailClient.tsx', 'app/tools/safety/_SafetyClient.tsx']) {
      expect(readFileSync(join(ROOT, f), 'utf-8')).toContain('HazardBadgeStrip');
    }
  });
});
