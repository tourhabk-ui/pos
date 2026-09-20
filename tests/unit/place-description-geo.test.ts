// @vitest-environment node
/**
 * Описание называет одно, координата говорит другое.
 *
 * ── Почему перепись вообще (20.09) ────────────────────────────────────────
 *
 * За два дня сочинённое описание нашлось у ЧЕТЫРЁХ мест подряд: «Каньон
 * Опасный» (Карымский при координате у Мутновского), «Крылья Гамулов»
 * (Мутновский, будучи на Шивелуче), «Каньон Сноубордистов» (река Половинка
 * под Петропавловском, будучи перевалом над Эссо), «Сопка Никольская»
 * (городской холм с профилем вулкана).
 *
 * Все четыре нашлись СЛУЧАЙНО, по ходу другой работы. Способ «наткнуться
 * глазами» находит не худшее, а то, куда посмотрели, — и платит за находку
 * человек в поле.
 *
 * ── Что держит этот сторож ────────────────────────────────────────────────
 *
 * Логика чистая и проверяется на НАСТОЯЩИХ фразах из тех самых описаний, а
 * не на придуманных под тест. Отдельно держится то, что перепись НЕ
 * утверждает: упоминание с расстоянием законно, вулкан бывает виден за сто
 * километров, а объект вне нашей базы невидим по построению и идёт в
 * отдельный счёт, а не в чистые.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nameStem, findMentions, MIN_STEM, type Landmark } from '@/lib/places/description-geo';
import { MANUAL_ENDPOINTS, DECLARED } from '@/lib/agents/cron-schedulers';
import { CRON_CAPABILITIES } from '@/lib/agents/cron-capability-registry';

const ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/place-description-geo/route.ts'), 'utf-8');
/** Код без комментариев — шапка сама цитирует выдуманные описания. */
const CODE = ROUTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

function lm(name: string, lat: number, lng: number): Landmark {
  const stem = nameStem(name);
  if (!stem) throw new Error(`у «${name}» нет основы`);
  return { id: name, name, stem, lat, lng };
}

/** Настоящие координаты из наших же разборов 19-20.09. */
const KARYMSKY  = lm('Вулкан Карымская сопка', 54.049, 159.443);
const MUTNOVSKY = lm('Вулкан Мутновский',      52.453, 158.195);
const SHIVELUCH = lm('Вулкан Шивелуч',         56.653, 161.360);
const ICHINSKY  = lm('Ичинский Вулкан',        55.687, 157.730);
const PK        = lm('Петропавловск-Камчатский', 53.024, 158.643);
const GAZ = [KARYMSKY, MUTNOVSKY, SHIVELUCH, ICHINSKY, PK];

describe('основа имени переживает склонение', () => {
  it('«Карымский» и «Карымская» дают одну основу', () => {
    expect(nameStem('Вулкан Карымская сопка')).toBe(nameStem('Карымский'));
  });

  it('род в начале имени не опознаёт объект', () => {
    // Иначе «Вулкан Опасный» и «Вулкан Горелый» слились бы по слову «вулкан».
    expect(nameStem('Вулкан Мутновский')).not.toContain('вулкан');
    expect(nameStem('Озеро Курильское')).not.toContain('озеро');
  });

  it('имя из одного рода опознавать нечем — null, а не пустая строка', () => {
    expect(nameStem('Вулкан')).toBeNull();
    expect(nameStem('Гора')).toBeNull();
    expect(nameStem('')).toBeNull();
  });

  it('основа короче порога не заводится — иначе ловился бы шум', () => {
    // «Голая» дала бы «гол» и нашлась бы в слове «голубые».
    expect(nameStem('Голая')).toBeNull();
    expect(MIN_STEM).toBeGreaterThanOrEqual(6);
  });

  it('скобки и кавычки в опознание не идут', () => {
    expect(nameStem('Водопад Спокойный (Снежный Барс)')).toBe(nameStem('Спокойный'));
  });
});

describe('настоящие выдумки 19-20.09 опознаются', () => {
  it('«Каньон Опасный»: назван Карымский, а место у Мутновского', () => {
    const descr = 'Каньон Опасный — один из самых драматичных объектов Камчатки, '
      + 'расположенный в труднодоступной зоне у подножия вулкана Карымский.';
    const found = findMentions(descr, GAZ, nameStem('Каньон Опасный'));
    const karym = found.find(m => m.landmark === KARYMSKY);
    expect(karym, 'упоминание Карымского не найдено').toBeDefined();
    expect(karym!.kind, 'расстояния рядом нет — описание утверждает, что место ТАМ').toBe('implied_location');
  });

  it('«Крылья Гамулов»: назван Мутновский, а каньон на Шивелуче', () => {
    const descr = 'Каньон «Крылья Гамулов» — уникальный природный объект, '
      + 'расположенный в окрестностях активного вулкана Мутновский.';
    const found = findMentions(descr, GAZ, nameStem('Каньон Крылья Гамулов'));
    expect(found.find(m => m.landmark === MUTNOVSKY)?.kind).toBe('implied_location');
  });

  it('упоминание С РАССТОЯНИЕМ уликой не считается', () => {
    // «в 30 километрах от Петропавловска» — описание не утверждает, что место
    // ТАМ, оно говорит, как далеко. Законная форма.
    const descr = 'Каньон Сноубордистов — узкое ущелье в нижнем течении реки Половинка, '
      + 'расположенное в 30 километрах от Петропавловска-Камчатского.';
    const found = findMentions(descr, GAZ, nameStem('Каньон Сноубордистов'));
    expect(found.find(m => m.landmark === PK)?.kind).toBe('stated_distance');
  });

  it('собственное имя места в улики не идёт', () => {
    const descr = 'Вулкан Мутновский — действующий вулкан с фумарольными полями.';
    expect(findMentions(descr, GAZ, nameStem('Вулкан Мутновский'))
      .find(m => m.landmark === MUTNOVSKY)).toBeUndefined();
  });

  it('«виден Ичинский» — тоже упоминание, и судить его человеку', () => {
    // Перепись НЕ решает, что это выдумка: вулкан действительно виден за сто
    // километров. Она лишь показывает пару и расстояние.
    const descr = 'С перевала видны Срединный хребет и вулкан Ичинский.';
    const found = findMentions(descr, GAZ, nameStem('Каньон Сноубордистов'));
    expect(found.find(m => m.landmark === ICHINSKY)).toBeDefined();
  });

  it('основа ищется началом слова, а не куском внутри', () => {
    const descr = 'Здесь нет ничего про вулканы, только слово мутноватый.';
    expect(findMentions(descr, GAZ, null).find(m => m.landmark === MUTNOVSKY)).toBeUndefined();
  });
});

describe('перепись читающая, объявленная и с тремя исходами', () => {
  it('ни одного UPDATE/INSERT/DELETE', () => {
    expect(CODE).not.toMatch(/\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\b/i);
  });

  it('считает только живые места с координатами', () => {
    expect(CODE).toContain('is_visible IS NOT FALSE');
    expect(CODE).toContain('merged_into_id IS NULL');
    expect(CODE).toContain('lat IS NOT NULL');
  });

  it('«сверить не с чем» отделено от «улик нет»', () => {
    // Выдумка про объект вне нашей базы попадает в nothing_to_check, и
    // выдать её за чистоту нельзя.
    expect(CODE).toContain('nothing_to_check');
    expect(CODE).toContain('no_evidence');
    expect(CODE).toContain('stated_distance_only');
  });

  it('нулевой справочник — отказ, а не чистота', () => {
    expect(CODE).toMatch(/meaningful:\s*gazetteer\.length > 0/);
  });

  it('порог — сортировка, а не приговор, и это сказано в ответе', () => {
    expect(ROUTE).toContain('улика, не приговор');
    expect(CODE).toContain('far_km');
  });

  it('род запуска и возможности объявлены', () => {
    expect(MANUAL_ENDPOINTS['place-description-geo']?.writes).toBe(false);
    expect(DECLARED['place-description-geo']).toBeDefined();
    expect(CRON_CAPABILITIES['place-description-geo']).toEqual(['db_read']);
  });

  it('отказ не глушится: SQLSTATE в лог и в ответ', () => {
    expect(ROUTE).toContain('console.error');
    expect(ROUTE).toContain('sqlstate');
  });
});
