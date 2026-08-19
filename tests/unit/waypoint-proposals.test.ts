/**
 * Точки предлагаются по ЛИНИИ, а не по близости к якорю.
 *
 * Перепись 17.08: у 154 маршрутов есть линия и ни одной путевой точки —
 * больше половины всех линий. Сверить такую линию не с чем, и проверка
 * «точки расходятся с линией» на них молчит: мерить нечем.
 *
 * У этих маршрутов есть сама линия, поэтому точки не угадываются по названию,
 * а измеряются. И мера здесь другая, чем в миграции 167: та привязывала места
 * по близости к ЯКОРЮ маршрута в радиусе 15 км. Якорь — одна точка, обычно
 * посёлок старта; на Камчатке из одного посёлка уходят пути в разные стороны,
 * и пятнадцать километров вокруг Эссо накрывают и сопку, и источники. Такое
 * правило уже дало привязку трека «Вулкан Ичинская сопка» к «Эссовским
 * термальным источникам».
 *
 * Ошибка здесь несимметрична по цене: пропущенная точка оставляет маршрут
 * таким, каким он был, а лишняя ставит на пути место, которого на нём нет, —
 * и человек пойдёт его искать.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ON_LINE_KM, NEAR_LINE_KM, MIN_WAYPOINTS, SWEEP_LIMIT } from '@/lib/routes/waypoint-proposals';
import { MAX_MATCH_DIST_KM } from '@/lib/import/kml-inbox';

const SRC = readFileSync(join(process.cwd(), 'lib/routes/waypoint-proposals.ts'), 'utf-8');
/** Код без комментариев: прежние правила в них разобраны намеренно. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const API = readFileSync(join(process.cwd(), 'app/api/cron/waypoint-proposals/route.ts'), 'utf-8');
const WF = readFileSync(join(process.cwd(), '.github/workflows/waypoint-proposals.yml'), 'utf-8');

describe('пороги отвечают цене ошибки', () => {
  it('«на линии» — сотни метров, а не километры', () => {
    expect(ON_LINE_KM).toBeGreaterThan(0);
    expect(ON_LINE_KM).toBeLessThanOrEqual(0.5);
  });

  it('«около линии» шире, но остаётся в пределах километра', () => {
    expect(NEAR_LINE_KM).toBeGreaterThan(ON_LINE_KM);
    expect(NEAR_LINE_KM).toBeLessThanOrEqual(1);
  });

  it('строже, чем привязка ТРЕКОВ к маршрутам', () => {
    // Там решается другой вопрос — какому маршруту принадлежит трек целиком,
    // и порог в 4 км уместен. Переносить его сюда значило бы ставить на путь
    // всё, что попалось в окрестности.
    expect(ON_LINE_KM).toBeLessThan(MAX_MATCH_DIST_KM);
  });

  it('одной точкой путь не описывается', () => {
    expect(MIN_WAYPOINTS).toBeGreaterThanOrEqual(2);
  });
});

describe('мера — расстояние до линии и порядок вдоль неё', () => {
  it('используется проекция на трек, а не расстояние до якоря', () => {
    expect(CODE).toMatch(/projectOnTrack\(/);
    expect(CODE).toMatch(/offTrackKm/);
    // Якорь маршрута (kr.lat/kr.lng) в правиле не участвует вовсе.
    expect(CODE).not.toMatch(/kr\.lat|kr\.lng/);
  });

  it('порядок берётся вдоль линии, а не по расстоянию от начала', () => {
    // Маршрут может возвращаться той же тропой: сортировка по удалённости от
    // старта перепутала бы туда и обратно.
    expect(CODE).toMatch(/proj\.segment \+ proj\.t/);
  });

  it('маршруты берутся только те, у которых точек НЕТ', () => {
    expect(CODE).toMatch(/NOT EXISTS \(SELECT 1 FROM route_waypoints/);
  });

  it('слитые места не предлагаются', () => {
    expect(CODE).toMatch(/merged_into_id IS NULL/);
  });
});

describe('измерение, а не запись', () => {
  it('модуль не пишет в route_waypoints', () => {
    expect(CODE).not.toMatch(/INSERT INTO route_waypoints/i);
    expect(CODE).not.toMatch(/UPDATE route_waypoints/i);
  });

  it('endpoint только читает и закрыт секретом', () => {
    expect(API).toMatch(/timingSafeCompare\(secret, process\.env\.CRON_SECRET/);
    expect(API).not.toMatch(/export async function POST/);
  });

  it('ошибка разбора не выглядит пустым результатом', () => {
    // Пустой отчёт читался бы как «привязывать нечего», то есть как ответ.
    expect(API).toMatch(/success: false/);
    expect(API).toMatch(/status: 500/);
  });
});

describe('прогон показывает, что именно предлагается', () => {
  it('печатает образцы разметки с расстояниями', () => {
    expect(WF).toMatch(/Образцы разметки/);
    expect(WF).toMatch(/offLineKm/);
  });

  it('отдельно показывает маршруты, где рядом есть, а на линии нет', () => {
    // Это либо грубая геометрия, либо линия не о том — разные починки.
    expect(WF).toMatch(/НИ ОДНО не легло на линию/);
  });

  it('без секрета прогон краснеет', () => {
    const guard = WF.slice(WF.indexOf('if [ -z "$CRON_SECRET" ]'));
    expect(guard.slice(0, 300)).toMatch(/exit 1/);
    expect(guard.slice(0, 300)).not.toMatch(/exit 0/);
  });
});

/**
 * Что показал первый прогон 17.08 и что из этого следует.
 *
 * Правило сработало: расстояния 0–0.2 км, цепочки читаются в порядке пути.
 * Но всплыли две вещи, которых на бумаге видно не было.
 *
 * Первая — мой недосмотр: разбор насчитал 188 маршрутов там, где перепись
 * геометрии видит 154. Разница — скрытые записи: у переписи есть отбор по
 * `is_visible`, у разбора не было. Два инструмента об одном и том же обязаны
 * считать одно и то же, иначе их числа нельзя сопоставить.
 *
 * Вторая — свойство данных: «Пеший тур по Камчатке» с линией в 4531 вершину
 * собрал 49 мест, включая краевой художественный музей и Музей Лосося. Каждое
 * честно лежит на линии; линия просто идёт через полкрая. И среди мест
 * оказались записи, местами не являющиеся вовсе — «Камчатка. Такие места»,
 * «Забег на Аагские источники». Отсеять их расстоянием нельзя: их координату
 * кто-то поставил ровно по маршруту.
 */
describe('уроки первого прогона', () => {
  it('отбор маршрутов тот же, что у переписи геометрии', () => {
    expect(CODE).toMatch(/is_visible = TRUE OR kr\.is_visible IS NULL/);
  });

  it('линия, собирающая всё подряд, помечается, а не обрезается', () => {
    // Молча обрезать список до дюжины значило бы выдать половину сбора за
    // весь сбор.
    expect(SWEEP_LIMIT).toBeGreaterThanOrEqual(10);
    expect(CODE).toMatch(/report\.sweeping \+= 1/);
    expect(CODE).not.toMatch(/onLine\.slice\(0, SWEEP_LIMIT\)/);
  });

  it('род места показывается — фильтром он станет, только если различает', () => {
    expect(CODE).toMatch(/location_type AS "locationType"/);
    expect(CODE).toMatch(/locationType: pl\.locationType/);
    // Фильтра по роду ПОКА нет намеренно: сначала надо увидеть, есть ли
    // признак у мусорных записей вообще.
    expect(CODE).not.toMatch(/location_type IS NOT NULL/);
  });
});
