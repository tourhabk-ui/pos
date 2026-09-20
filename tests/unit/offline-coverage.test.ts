// @vitest-environment node
/**
 * Сколько карты маршрута лежит в телефоне — проверкой, а не записью.
 *
 * ── Почему это вообще понадобилось ────────────────────────────────────────
 *
 * Пробел был назван в репозитории раньше, чем закрыт: шапка
 * `lib/offline/saved-map.ts` говорит дословно, что запись в localStorage —
 * «не доказательство, а заявление», и что «проверка наличия — отдельный
 * разговор, и врать вместо неё нельзя». Разговора не было: экран
 * планирования показывал `savedMapSummary` — пересказ того, что закачка
 * обещала в момент нажатия.
 *
 * Между обещанием и выходом в поле стоит система, которая вправе вычистить
 * кэш тайлов и не тронуть localStorage. Человек читает «Карта сохранена ·
 * 47 МБ · вчера» и уходит без карты.
 *
 * ── Что держит сторож ─────────────────────────────────────────────────────
 *
 * Четыре исхода вместо доли от нуля до единицы; выборку, которая смотрит
 * ХВОСТ, а не только голову; и то, что проверка подключена к экрану — а не
 * просто написана.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  coverageFromCounts,
  coverageLabel,
  coverageIsShort,
  evenSample,
  probeCoverage,
  COVERAGE_WARN_BELOW,
} from '@/lib/offline/coverage';

const ROOT = process.cwd();
const SRC = readFileSync(join(ROOT, 'lib/offline/coverage.ts'), 'utf-8');
const SCREEN = readFileSync(join(ROOT, 'app/planning/_PlanningClient.tsx'), 'utf-8');
/** Код без комментариев: шапки сами цитируют то, что запрещено. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('четыре исхода, а не доля от нуля до единицы', () => {
  it('«не качали» и «ничего не нашлось» — разные состояния', () => {
    // Задача #1971 просила отдавать ratio=0 для маршрута без пакета. Ноль
    // значит «скачано нисколько»; «проверить нечем» не значит ничего.
    const cannot = coverageFromCounts(250, 0, 0);
    const none = coverageFromCounts(250, 250, 0);
    expect(cannot.state).toBe('cannot_check');
    expect(cannot.ratio, 'отсутствие проверки не равно нулевому покрытию').toBeNull();
    expect(none.state).toBe('none');
    expect(none.ratio).toBe(0);
  });

  it('нет линии — считать нечего, и причина названа словами', () => {
    const r = coverageFromCounts(0, 0, 0);
    expect(r.state).toBe('cannot_check');
    expect(r.reason).toContain('нет линии');
  });

  it('всё на месте — covered, часть — partial', () => {
    expect(coverageFromCounts(100, 100, 100).state).toBe('covered');
    expect(coverageFromCounts(100, 100, 61).state).toBe('partial');
    expect(coverageFromCounts(100, 100, 61).ratio).toBeCloseTo(0.61, 5);
  });

  it('доля считается от ПРОВЕРЕННЫХ, а не от нужных', () => {
    // Иначе выборка из ста тайлов у маршрута в тысячу всегда давала бы 10%
    // и кричала бы о дыре там, где карта целая.
    const r = coverageFromCounts(1000, 100, 100);
    expect(r.ratio).toBe(1);
    expect(r.state).toBe('covered');
    expect(r.sampled, 'проверено меньше, чем нужно — это выборка').toBe(true);
  });

  it('выборочность названа человеку, а не спрятана', () => {
    expect(coverageLabel(coverageFromCounts(1000, 100, 100))).toContain('по выборке');
    expect(coverageLabel(coverageFromCounts(100, 100, 100))).not.toContain('по выборке');
  });
});

describe('выборка смотрит хвост, а не только голову', () => {
  it('в выборку входят и первый, и последний', () => {
    const list = Array.from({ length: 1000 }, (_, i) => i);
    const s = evenSample(list, 10);
    expect(s[0]).toBe(0);
    expect(s[s.length - 1]).toBe(999);
  });

  it('оборванная закачка ловится: хвоста нет — доля падает', () => {
    // Тайлы идут зумами и геометрическим порядком, оборванная закачка теряет
    // КОНЕЦ. Выборка из головы сказала бы «всё на месте».
    const list = Array.from({ length: 1000 }, (_, i) => i);
    const have = new Set(list.slice(0, 500));
    const s = evenSample(list, 10);
    const present = s.filter(x => have.has(x)).length;
    expect(coverageFromCounts(1000, s.length, present).state).toBe('partial');
  });

  it('список короче выборки возвращается целиком', () => {
    expect(evenSample([1, 2, 3], 10)).toEqual([1, 2, 3]);
    expect(evenSample([], 10)).toEqual([]);
  });
});

describe('порог тревоги — один на экран и на тест', () => {
  it('ниже порога кричим, на пороге и выше — нет', () => {
    expect(coverageIsShort(coverageFromCounts(100, 100, 89))).toBe(true);
    expect(coverageIsShort(coverageFromCounts(100, 100, 90))).toBe(false);
    expect(COVERAGE_WARN_BELOW).toBeGreaterThan(0.5);
    expect(COVERAGE_WARN_BELOW).toBeLessThanOrEqual(1);
  });

  it('«не смогли проверить» не кричит: это не дыра, а незнание', () => {
    expect(coverageIsShort(coverageFromCounts(250, 0, 0))).toBe(false);
  });
});

describe('проверка хранилища честна в отказе', () => {
  it('нет Cache Storage — cannot_check, а не пустая карта', async () => {
    expect(typeof caches).toBe('undefined'); // среда node, API нет
    const r = await probeCoverage(['https://tile/12/1/1.png']);
    expect(r.state).toBe('cannot_check');
    expect(r.ratio).toBeNull();
  });

  it('пустой список — «считать нечего», без похода в хранилище', async () => {
    const r = await probeCoverage([]);
    expect(r.state).toBe('cannot_check');
    expect(r.need).toBe(0);
  });

  it('отказ похода в хранилище не считается отсутствием тайла', () => {
    // Отличить «тайла нет» от «спросить не вышло» здесь МОЖНО, и смешивать
    // их значило бы показать дыру там, где её нет.
    expect(code(SRC)).toContain('if (h === null) continue;');
  });
});

describe('проверка подключена к экрану, а не просто написана', () => {
  it('экран планирования зовёт probeCoverage', () => {
    // Объявленный механизм без вызова — провод в никуда (§10.09).
    expect(code(SCREEN)).toContain('probeCoverage(');
  });

  it('экран показывает результат проверки, а не только пересказ записи', () => {
    expect(code(SCREEN)).toContain('coverageLabel(');
    expect(code(SCREEN)).toContain('coverageIsShort(');
  });

  it('считается только при наличии ОБЕИХ половин: записи и плана', () => {
    // Без записи о закачке «0% на месте» было бы неправдой: не качали.
    expect(code(SCREEN)).toMatch(/if \(!savedMap \|\| !urls \|\| urls\.length === 0\)/);
  });

  it('модуль покрытия своего порога и своих зумов не заводит', () => {
    // Коридор считает route-corridor, список тайлов отдаёт сервер. Второй
    // расчёт того же был бы вторым правилом (§12).
    expect(code(SRC)).not.toContain('corridorTileKeys');
    expect(code(SRC)).not.toMatch(/CORRIDOR_ZOOMS|lonToTile|latToTile/);
  });
});
