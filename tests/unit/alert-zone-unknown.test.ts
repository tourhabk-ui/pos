/**
 * Сторож: «зона не установлена» ≠ «везде» (17.09).
 *
 * Паводковая сводка МЧС 17.09 (западное побережье, ~300 км от Петропавловска)
 * красила в красный обе городские сопки в центре города. Сводка режется по
 * темам (mintur-bulletin-split), и у трёх кусков округ не назван: «река
 * Большой Воровской», «северо-восточное побережье», «подтопление придомовых
 * территорий». Механизм: (1) в куске нет ни вулкана, ни округа из списка;
 * (2) не нашли → дефолт ['avachinsky'] — зона Петропавловска; (3) SQL в
 * safety-ingest читал пустые зоны как «весь край»; (4) severity >= 2 → red.
 * Тот же дефолт латали по округу за раз трижды (29.07, 06.08, 10.08).
 *
 * Правило одно на три места, и держится оно здесь: mchs_zones возвращает []
 * когда не знает; оба SQL-предиката (safety-ingest, collect-signals) пустоту
 * НЕ считают совпадением; журнал пишет geo_unmatched. Явное «по краю» в
 * тексте — данные, не дефолт, и даёт все четыре зоны.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mchs_zones } from '@/lib/services/safety/seismic-parser';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf-8');
const ALL = new Set(['avachinsky', 'eastern', 'western', 'northern']);

describe('mchs_zones — три исхода', () => {
  it('округ из списка → его зона (Усть-Большерецкий — западная)', () => {
    expect(mchs_zones('дорога мыс Левашова — посёлок Октябрьский в Усть-Большерецком округе')).toEqual(['western']);
  });

  it('округ, добавленный по прошлому инциденту, узнаётся (Соболевский — западная, 06.08)', () => {
    expect(mchs_zones('Камчатские спасатели МЧС России выдвинулись в Соболевский округ, где может сложиться непростая гидрологическая обстановка')).toEqual(['western']);
  });

  it('три куска сводки 17.09 без округа → [] — не Авачинская (они и красили сопки)', () => {
    expect(mchs_zones('При достижении уровней неблагоприятного явления на реке Большой Воровской, а также при выходе воды на пойму, подтоплений населённых пунктов не прогнозируется')).toEqual([]);
    expect(mchs_zones('На северо-восточном побережье Камчатки ожидался размыв песчаных кос морской водой, а также подтопление низменных участков')).toEqual([]);
    expect(mchs_zones('При достижении уровня опасного явления возможно частичное подтопление придомовых и дворовых территорий, расположенных в прибрежной зоне реки')).toEqual([]);
  });

  it('склонённое имя вулкана узнаётся — раньше это маскировал дефолт', () => {
    expect(mchs_zones('не приближаться к вулкану Мутновскому')).toEqual(['avachinsky']);
    expect(mchs_zones('пепловый выброс на Ключевском')).toEqual(['northern']);
    expect(mchs_zones('в районе Шивелуча')).toEqual(['northern']);
  });

  it('«по Камчатскому краю» / «по всему краю» / «на территории края» → все четыре зоны', () => {
    expect(new Set(mchs_zones('По Камчатскому краю ожидается усиление ветра до 25 м/с'))).toEqual(ALL);
    expect(new Set(mchs_zones('штормовое предупреждение по всему краю'))).toEqual(ALL);
    expect(new Set(mchs_zones('на территории края сохраняется высокая пожарная опасность'))).toEqual(ALL);
  });

  it('конкретный округ побеждает «по краю»: текст про Соболевский с оборотом «по краю» — не все зоны', () => {
    // Специфика важнее общности: если округ назван, общекраевой оборот не
    // расширяет предупреждение на чужие зоны.
    expect(mchs_zones('По Камчатскому краю: в Мильковском округе ожидается подъём воды')).toEqual(['northern']);
  });

  it('«Камчатские спасатели» — не «по Камчатскому краю»: слово «Камчатск» само по себе не общекраевое', () => {
    expect(mchs_zones('Камчатские спасатели провели учения')).toEqual([]);
  });
});

describe('оба SQL-предиката читают пустые зоны как «никого»', () => {
  const FILES = ['app/api/cron/safety-ingest/route.ts', 'lib/routes/collect-signals.ts'];

  for (const f of FILES) {
    it(`${f}: нет ветки affected_zones IS NULL / = '{}'`, () => {
      const src = read(f);
      // Комментарии могут цитировать старую форму — смотрим только SQL внутри
      // шаблонных строк: убираем строки, начинающиеся с -- или *.
      const sqlOnly = src.split('\n').filter(l => !/^\s*(--|\*|\/\/)/.test(l)).join('\n');
      expect(sqlOnly, `${f} снова считает пустые зоны общекраевыми`).not.toMatch(/affected_zones\s+IS\s+NULL/);
      expect(sqlOnly, `${f} снова считает пустые зоны общекраевыми`).not.toMatch(/affected_zones\s*=\s*'\{\}'/);
    });
  }

  it('safety-ingest: незональная ветка совпадает только по ark.zone = ANY(ea.affected_zones)', () => {
    expect(read(FILES[0])).toMatch(/AND ark\.zone = ANY\(ea\.affected_zones\)/);
  });

  it('collect-signals: совпадение только по пересечению зон маршрута', () => {
    expect(read(FILES[1])).toMatch(/AND affected_zones && \$1::text\[\]/);
  });
});

describe('журнал называет пустые зоны своим именем', () => {
  it('saveEvent эмитит geo_unmatched, когда зон нет', () => {
    expect(read('lib/services/safety/seismic-parser.ts'))
      .toMatch(/affected_zones\.length > 0 \? 'geo_matched' : 'geo_unmatched'/);
  });

  it('в mchs_zones больше нет дефолта в Авачинскую', () => {
    const src = read('lib/services/safety/seismic-parser.ts');
    const fn = src.slice(src.indexOf('export function mchs_zones'), src.indexOf('export function titleFingerprint'));
    expect(fn).not.toMatch(/:\s*\['avachinsky'\]/);
    expect(fn).toMatch(/return \[\];/);
  });
});
