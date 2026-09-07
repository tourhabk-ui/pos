// @vitest-environment node
/**
 * Список тех, кого держит РОД связи, а не её отсутствие (#1493).
 *
 * Перепись давала счёт: пригодных 6, а без различения рода было бы 23.
 * Цифра отвечает «сколько», но размечают запись, а не строку счёта — и
 * семнадцать маршрутов между этими числами и есть самая короткая дорога:
 * там связи уже стоят, спор идёт только о том, путь это или «рядом».
 * Новая связь к маршруту без единой точки не даёт ничего: порог — две.
 *
 * Сторож держит три свойства, и второе важнее остальных.
 *
 * 1. СВОЕГО ПРАВИЛА НЕТ. Список — ровно расхождение двух вердиктов, которые
 *    перепись уже считает одним и тем же `routeNavigability`. Свой предикат
 *    здесь означал бы второй судья над теми же данными — против §12.
 *
 * 2. РАССТОЯНИЯ ДО ЛИНИИ В СПИСКЕ НЕТ. §4.1: «Выводить род из близости к
 *    линии ЗАПРЕЩЕНО: тогда всё неудобное переименуется в „рядом“ и любой
 *    маршрут пройдёт черту — это выключение сигнализации, а не починка
 *    данных». Показать расстояние рядом с вопросом «путь или рядом» значит
 *    подсказать запрещённый ответ, и человек добросовестно им воспользуется.
 *    Улика в списке одна и другого класса — совпадение имени: ровно тем же
 *    признаком заведены 238 связей рода `waypoint` миграциями 653-657.
 *
 * 3. ПОРЯДОК ДЕТЕРМИНИРОВАН. Разбирают партиями по десять; вторая партия
 *    обязана быть продолжением первой, а не новой выборкой.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'lib/routes/geometry-audit.ts'), 'utf-8');
const ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/route-data-audit/route.ts'), 'utf-8');

/** Тело блока, который наполняет список. */
const block = (() => {
  const i = SRC.indexOf('linkKindBlocked.push({');
  expect(i, 'список больше не наполняется — перепись перестала отдавать материал').toBeGreaterThan(0);
  return SRC.slice(SRC.lastIndexOf('if (', i), SRC.indexOf('    }', i));
})();

describe('список ведут те же два вердикта, а не третье правило', () => {
  it('условие — ровно расхождение nav и navBeforeLinkKind', () => {
    expect(block).toContain("nav.verdict !== 'navigable'");
    expect(block).toContain("navBeforeLinkKind.verdict === 'navigable'");
  });

  it('своего порога или своего вызова черты в блоке нет', () => {
    // routeNavigability зовётся выше по коду дважды и оба раза осознанно;
    // третий вызов внутри этого блока означал бы отдельного судью.
    expect(block).not.toMatch(/routeNavigability\(/);
    expect(block, 'числовой порог в блоке — признак собственного правила')
      .not.toMatch(/(?:length|count)\s*[<>]=?\s*\d/);
  });
});

describe('улика — имя, а не близость к линии', () => {
  it('в паре считается совпадение имени', () => {
    expect(block).toContain('nameMatchScore(');
  });

  it('расстояния до линии в списке нет — §4.1', () => {
    for (const forbidden of ['offTrackKm', 'projectOnTrack', 'distanceKm', 'worstKm']) {
      expect(block, `${forbidden} в списке подсказывает запрещённый §4.1 ответ`)
        .not.toContain(forbidden);
    }
  });

  it('запрет назван в самом коде, а не только здесь', () => {
    // Сторож в тестах читают, когда он краснеет; комментарий у поля читают,
    // когда поле правят. Правило должно стоять там, где его нарушат.
    const decl = SRC.slice(SRC.indexOf('link_kind_blocked: Array<'), SRC.indexOf('link_kind_blocked: Array<') + 40);
    expect(decl).toContain('link_kind_blocked');
    expect(SRC).toMatch(/Выводить род из близости[\s*]+к линии ЗАПРЕЩЕНО/);
  });
});

describe('в списке только спорные точки', () => {
  it('точки рода waypoint отфильтрованы — по ним решать нечего', () => {
    expect(block).toMatch(/filter\(\s*\(w\)\s*=>\s*!isPathPoint\(w\.kind\)\s*\)/);
  });
});

describe('партии продолжают друг друга', () => {
  it('порядок задан явно, а не порядком обхода', () => {
    const tail = SRC.slice(SRC.indexOf('link_kind_blocked: linkKindBlocked'));
    expect(tail.slice(0, 400)).toContain('.sort(');
  });

  it('версия формы ответа поднята — читатель узнает о новом поле', () => {
    expect(ROUTE).toMatch(/AUDIT_SHAPE_VERSION = 18/);
    expect(ROUTE, 'изменение формы без строки в журнале версий').toContain('#1493');
  });
});
