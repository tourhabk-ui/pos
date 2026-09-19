// @vitest-environment node
/**
 * Сложность маршрута называется одинаково и НИКОГДА не выходит пустой.
 *
 * ── Что нашлось 19.09 ─────────────────────────────────────────────────────
 *
 * Карточка маршрута — главная инструкция туриста: по ней решают, идти ли и с
 * чем. На ней бейдж сложности рисовался из СВОЕГО словаря на три написания:
 *
 *   DIFFICULTY_RU = { easy, medium, hard, легкий, средний, сложный }
 *
 * А в колонке `difficulty` (varchar) живут семь написаний, и берутся они из
 * трёх разных словарей нашего же кода:
 *
 *   lib/ai/image-tagger.ts    easy | moderate | extreme
 *   lib/planner/engine.ts     easy | moderate | hard
 *   lib/services/tours        easy | medium | hard | extreme
 *   lib/safety/tour-risk.ts   высокий риск: hard | difficult | extreme | expert
 *
 * Подсчёт по репозиторию: easy 49, hard 16, medium 13, moderate 9, extreme 4.
 *
 * Отсюда три дефекта на одном экране, и все три — в сторону «безопаснее, чем
 * есть»:
 *
 *   1. бейдж предложения рисовался БЕЗ ЗАПАСА (`MAP[x]`, не `?? x`), и у
 *      `extreme` выходил ПУСТЫМ — цветная плашка без слова;
 *   2. цвет брался так же, и `undefined` попадал внутрь `color-mix(in srgb,
 *      ...)`: выражение становилось невалидным, плашка теряла цвет и рамку —
 *      самый опасный маршрут выглядел бледнее лёгкого;
 *   3. в строке показателей запас был, и `moderate` печатался читателю
 *      по-английски.
 *
 * Пустая плашка читается как «ничего особенного» ровно там, где написано
 * «экстремальный». Это тот же третий исход, выданный за первый (§4.0), только
 * на экране и про опасность.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIFFICULTY_LABELS, difficultyLabel, difficultyColor } from '@/lib/tours/labels';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const ROUTE_CARD = read('app/routes/[id]/_RouteDetailClient.tsx');

/** Написания, которые наш код производит или разбирает (перепись 19.09). */
const SPELLINGS_IN_USE = ['easy', 'medium', 'moderate', 'hard', 'difficult', 'expert', 'extreme'];

describe('словарь сложности знает всё, что пишет наш код', () => {
  it('каждое написание из переписи названо', () => {
    const unknown = SPELLINGS_IN_USE.filter(s => !(s in DIFFICULTY_LABELS));
    expect(
      unknown,
      'написание встречается в коде, но словарь его не знает — на экране оно '
      + 'выйдет английским словом или пустотой',
    ).toEqual([]);
  });

  it('уровни, которые модуль риска считает ОПАСНЫМИ, обязаны быть названы', () => {
    // Самая сильная связка: то, что платформа объявляет высоким риском, она
    // обязана уметь назвать человеку. Список читается из самого модуля, а не
    // дублируется здесь — иначе разойдутся и они.
    const risk = read('lib/safety/tour-risk.ts');
    const block = risk.slice(risk.indexOf('HIGH_RISK_DIFFICULTY'));
    const levels = [...block.slice(0, block.indexOf(']')).matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
    expect(levels.length).toBeGreaterThan(2);
    const unnamed = levels.filter(l => !(l in DIFFICULTY_LABELS));
    expect(unnamed, 'уровень объявлен опасным, но назвать его нечем').toEqual([]);
  });

  it('у каждой записи есть подпись, короткое слово и токен цвета', () => {
    const broken = Object.entries(DIFFICULTY_LABELS)
      .filter(([, d]) => !d.label?.trim() || !d.short?.trim() || !d.color?.startsWith('var(--'))
      .map(([k]) => k);
    expect(broken, 'цвет — только семантический токен, никогда не хардкод-hex').toEqual([]);
  });
});

describe('пустоты не бывает ни при каком написании', () => {
  it('неизвестное написание печатается как есть, а не исчезает', () => {
    expect(difficultyLabel('zzz_unknown', true)).toBe('zzz_unknown');
    expect(difficultyLabel('zzz_unknown')).toBe('zzz_unknown');
  });

  it('пустое значение не печатает ничего — это отсутствие, а не «лёгкий»', () => {
    expect(difficultyLabel(null)).toBe('');
    expect(difficultyLabel(undefined)).toBe('');
  });

  it('цвет НИКОГДА не undefined — иначе color-mix становится невалидным', () => {
    for (const v of ['zzz_unknown', '', null, undefined]) {
      const c = difficultyColor(v as string | null | undefined);
      expect(typeof c).toBe('string');
      expect(c.startsWith('var(--')).toBe(true);
    }
  });

  it('экстремальный маршрут окрашен как опасный, а не нейтрально', () => {
    expect(difficultyColor('extreme')).toBe('var(--danger)');
    expect(difficultyColor('expert')).toBe('var(--danger)');
    expect(difficultyLabel('extreme', true)).toBe('Экстремальный');
  });
});

describe('карточка маршрута берёт слова из словаря', () => {
  it('своих словарей сложности в ней не осталось', () => {
    expect(ROUTE_CARD).not.toMatch(/const DIFFICULTY_(RU|COLOR)\s*:/);
  });

  it('она зовёт общие функции', () => {
    expect(ROUTE_CARD).toContain("from '@/lib/tours/labels'");
    expect(ROUTE_CARD).toContain('difficultyLabel(');
    expect(ROUTE_CARD).toContain('difficultyColor(');
  });

  it('прямых обращений к карте без запаса в ней нет', () => {
    // `MAP[x]` без `?? x` — та самая форма, из-за которой бейдж выходил пустым.
    expect(ROUTE_CARD).not.toMatch(/DIFFICULTY_LABELS\[[^\]]+\](?!\s*\?)/);
  });
});

/**
 * Копии, которые ещё не сведены. Список может только СОКРАЩАТЬСЯ: он существует
 * ровно затем, чтобы работа не потерялась, а не чтобы разрешать новые копии.
 *
 * Эти три экрана не входили в задачу (владелец просил карточку маршрута), и
 * трогать их заодно значило бы править вслепую то, чего я не мерил.
 */
const KNOWN_COPIES = [
  'app/planning/_PlanningClient.tsx',
  'app/trending/_TrendingClient.tsx',
  'app/ai-assistant/_AIAssistantClient.tsx',
];

describe('перепись оставшихся копий', () => {
  it('в каждом перечисленном файле копия ещё есть — запись не протухла', () => {
    const stale = KNOWN_COPIES.filter(f => !/const DIFFICULTY_LABELS/.test(read(f)));
    expect(stale, 'копии больше нет — уберите файл из KNOWN_COPIES').toEqual([]);
  });

  it('список не растёт', () => {
    expect(KNOWN_COPIES.length).toBeLessThanOrEqual(3);
  });
});
