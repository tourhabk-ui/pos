/**
 * Сторож: у планировщика «не смогли спросить» не равно «туров нет».
 *
 * ── Чем это стоило вчера ─────────────────────────────────────────────────
 *
 * 19.09 перепись с прода нашла план из восьми одинаковых дней, и причину я
 * объяснил сезоном: в октябре вулканы, рыбалка и медведи вне окон. Объяснение
 * правдоподобно, но НЕДОКАЗУЕМО: оба отбора материала — туры зоны и маршруты
 * зоны — возвращали `[]` на любом отказе запроса. Пустой каталог и упавшая
 * база выглядели одинаково, значит «пусто из-за сезона» было догадкой,
 * поданной как факт.
 *
 * Это §4.0 в самой дорогой форме: не поле без «не знаю», а ВЫВОД без «не
 * знаю». Дальше по этому выводу правится не то.
 *
 * ── Что держит сторож ────────────────────────────────────────────────────
 *
 *   — оба отбора умеют вернуть `null`, и это отдельный исход от `[]`;
 *   — отказ не глушится: причина уходит в лог поимённо;
 *   — подсчёт зон не наказывает зону за то, что про неё не удалось узнать;
 *   — недобор дней НЕ называет причиной сезон, когда проверка не выполнилась.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ENGINE = readFileSync(join(ROOT, 'lib/planner/engine.ts'), 'utf-8');
const DATA = readFileSync(join(ROOT, 'lib/planner/data.ts'), 'utf-8');

/**
 * `catch { return <данные>; }` — отказ, выданный за ответ.
 *
 * `return null` сюда НЕ попадает намеренно: это и есть честный третий исход.
 * Лжёт не сам catch, а подстановка правдоподобного значения — пустого списка,
 * нулевой загрузки, — которое вызывающий прочтёт как факт о каталоге.
 * (Первая редакция ловила и `null`, и первым же прогоном пометила
 * `fetchReviewSignals`, который как раз сделан правильно.)
 *
 * Потерянную ПРИЧИНУ отказа этот признак не ловит — это отдельное требование
 * §4.0, и у трёх записей ниже оно тоже не выполнено.
 */
const SILENT_CATCH = /catch\s*\{\s*return\s+(?!null\s*;|undefined\s*;)[^;]*;\s*\}/;

/** Тело функции от её объявления до следующего объявления верхнего уровня. */
function bodyOf(src: string, name: string): string {
  const at = src.search(new RegExp(`(export )?(async )?function ${name}\\b`));
  if (at < 0) return '';
  const rest = src.slice(at + 10);
  const next = rest.search(/\n(export )?(async )?function \w/);
  return next < 0 ? rest : rest.slice(0, next);
}

/**
 * Остальные запросы data.ts, ещё глушащие отказ. Список заморожен и может
 * только СОКРАЩАТЬСЯ: починили — тест потребует убрать запись, завели новый
 * молчащий запрос — тест покраснеет.
 *
 * Почему они не починены здесь: правка 19.09 шла по согласованному объёму —
 * два отбора МАТЕРИАЛА, по которым собирается день. У этих трёх другие
 * потребители и своя цена ошибки, и чинить их заодно значило бы менять то,
 * что никто не измерял. Реестр нужен, чтобы долг был виден, а не чтобы его
 * оправдать: `fetchZoneCapacity` тут самый скверный — на отказе он отвечает
 * «загрузка 0%», то есть выдаёт незнание за свободную зону.
 */
const KNOWN_SILENT: readonly string[] = [
  'fetchAvailabilityForTour',
  'fetchZoneCapacity',
  'fetchContingencyAlternatives',
];

describe('отбор материала различает пустоту и отказ', () => {
  it('туры зоны: тип допускает «не знаю»', () => {
    // Тип — это и есть механизм: `RealTour[]` принуждал вернуть пустой
    // список там, где ответа нет вовсе.
    expect(DATA).toMatch(/fetchRealToursForZone\([\s\S]{0,200}?\): Promise<RealTour\[\] \| null>/);
  });

  it('маршруты зоны: тип допускает «не знаю»', () => {
    expect(ENGINE).toMatch(/fetchRoutesForZone\([^)]*\): Promise<RouteFromDB\[\] \| null>/);
  });

  it('у двух отборов материала пустого catch нет', () => {
    // Пустой catch с готовым значением — ровно та форма, которая прятала
    // поломку под видом «данных нет».
    for (const fn of ['fetchRealToursForZone']) {
      expect(bodyOf(DATA, fn), `${fn}: пустой catch вернулся`).not.toMatch(SILENT_CATCH);
    }
    expect(bodyOf(ENGINE, 'fetchRoutesForZone'), 'fetchRoutesForZone').not.toMatch(SILENT_CATCH);
  });

  it('причина отказа уходит в лог поимённо', () => {
    // Ловить можно, молчать нельзя (§4.0).
    expect(DATA).toContain('[planner] туры зоны не прочитались');
    expect(ENGINE).toContain('[planner] маршруты зоны не прочитались');
  });
});

describe('остальной долг data.ts виден и может только сокращаться', () => {
  /** Функции data.ts, глушащие отказ прямо сейчас. */
  function silentNow(): string[] {
    const names = [...DATA.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
    return names.filter((n) => SILENT_CATCH.test(bodyOf(DATA, n)));
  }

  it('новый молчащий запрос не заводится', () => {
    const extra = silentNow().filter((n) => !KNOWN_SILENT.includes(n));
    expect(extra, `молчат и не записаны: ${extra.join(', ')}`).toEqual([]);
  });

  it('починенное убирают из списка — он самоустаревающий', () => {
    // Реестр в markdown так не умеет: он сам стал бы объявлением без
    // источника (§10.09). Здесь запись живёт ровно пока жив долг.
    const stale = KNOWN_SILENT.filter((n) => !silentNow().includes(n));
    expect(stale, `уже не молчат, запись лишняя: ${stale.join(', ')}`).toEqual([]);
  });
});

describe('подсчёт зон не наказывает за незнание', () => {
  it('надбавка за реальные туры требует не-null', () => {
    // `realTours.length > 0` на null упал бы, а трактовка null как «туров
    // нет» увела бы план из зоны по выдуманной причине.
    expect(ENGINE).toMatch(/if \(realTours && realTours\.length > 0\)/);
  });
});

describe('недобор дней не называет причину, которой не знает', () => {
  it('непроверенные пары собираются отдельным списком', () => {
    expect(ENGINE).toContain('const unchecked = new Set<string>()');
    expect(ENGINE).toMatch(/if \(toursOrNull === null \|\| routesOrNull === null\)/);
    // Список доходит до вызывающего, а не остаётся внутри сборки дней.
    expect(ENGINE).toMatch(/return \{ days, unchecked: \[\.\.\.unchecked\] \}/);
  });

  it('о непроверенном говорится вслух отдельным предупреждением', () => {
    expect(ENGINE).toContain('Не удалось проверить наличие туров');
    const at = ENGINE.indexOf('Не удалось проверить наличие туров');
    const block = ENGINE.slice(at - 400, at + 400);
    // Не «инфо»: Кузьмич показывает предупреждения severity !== 'info'.
    expect(block).toContain("severity: 'important'");
    expect(block).toContain('«не знаем»');
  });

  it('сезон НЕ называется причиной, когда проверка не выполнилась', () => {
    // Главная половина. Без неё предупреждение о недоборе продолжало бы
    // уверенно говорить «вне сезона» там, где мы просто не посмотрели.
    const at = ENGINE.indexOf('const reason = unchecked.length > 0');
    expect(at, 'причина недобора не сверяется с непроверенным').toBeGreaterThan(0);
    const block = ENGINE.slice(at, at + 600);
    expect(block).toContain('причину недобора назвать не берёмся');
    // Ветка «вне сезона» идёт ПОСЛЕ проверки на непроверенное, а не до.
    expect(block.indexOf('вне сезона')).toBeGreaterThan(block.indexOf('не берёмся'));
  });
});
