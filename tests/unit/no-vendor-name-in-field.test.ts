/**
 * Имя стороннего поставщика данных не показывается туристу.
 *
 * Полевой скрин 17.08, карточка качества данных на экране навигации:
 *
 *     Линия    источник: idilesom
 *
 * Владелец потребовал убрать. Требование справедливо вдвойне.
 *
 * Во-первых, это название чужого сайта внутри нашего экрана — турист не
 * покупал у них и не должен читать их имя, стоя на тропе.
 *
 * Во-вторых, и это важнее: слог из внутреннего справочника не отвечает на
 * вопрос, ради которого карточка существует. Человек спрашивает, можно ли идти
 * по этой линии; ответ — РОД линии (снятый путь или прямые между точками), а
 * не имя того, кто её загрузил.
 *
 * Слог при этом остаётся внутри: он ключ классификации (`gradeFromSource`) и
 * диагностика админки. Запрет — на вывод в поле, не на существование.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { geometrySourceLabel } from '@/lib/map/line-standard';

const SOURCES = ['idilesom', 'osm', 'visitkamchatka', 'kml_inbox', 'gpx', 'waypoints_synthetic', 'synthetic'];

describe('подпись линии говорит про род, а не про поставщика', () => {
  it('ни один известный источник не протекает именем наружу', () => {
    for (const s of SOURCES) {
      expect(geometrySourceLabel(s).toLowerCase()).not.toContain(s.toLowerCase());
    }
  });

  it('снятый путь назван снятым', () => {
    expect(geometrySourceLabel('idilesom')).toMatch(/снятый трек/);
    expect(geometrySourceLabel('osm')).toMatch(/снятый трек/);
  });

  it('набросок назван наброском', () => {
    expect(geometrySourceLabel('waypoints_synthetic')).toMatch(/набросок/);
  });

  it('незнакомый или отсутствующий источник остаётся видимым состоянием', () => {
    // Притвориться одним из известных было бы хуже молчания: вид линии
    // выбирается тогда по плотности точек, и человек должен это знать.
    for (const v of [null, undefined, 'что-то-новое']) {
      expect(geometrySourceLabel(v)).toMatch(/не записан/);
    }
  });

  it('незнакомое имя не печатается наружу тоже', () => {
    expect(geometrySourceLabel('какой-то-новый-поставщик')).not.toContain('какой-то-новый-поставщик');
  });
});

describe('карточка доверия не собирает подпись сама', () => {
  const CARD = readFileSync(join(process.cwd(), 'components/field/TrustCard.tsx'), 'utf-8');

  it('печатает через общую подпись, а не интерполяцией источника', () => {
    // `источник: ${p.geometrySource}` — ровно тот дефект. Правило, собранное
    // на экране руками, разъезжается с правилом в модуле: так уже было с
    // видом линии (§12).
    expect(CARD).toMatch(/geometrySourceLabel\(p\.geometrySource\)/);
    expect(CARD).not.toMatch(/источник: \$\{/);
  });
});
