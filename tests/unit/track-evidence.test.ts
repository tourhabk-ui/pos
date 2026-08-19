/**
 * Улика записи: платформа проверяет линию сама, а не верит заявлению.
 *
 * 17.08 скрейп с чужого сайта понижен из «снятого трека»: доказательств, что
 * по линии кто-то прошёл, не было. Тем же вечером владелец сообщил то, чего в
 * коде записано не было — сайт-источник ЗАЯВЛЯЕТ, что треки ему предоставляли
 * люди, которые их прошли.
 *
 * Это меняет вес 259 линий: не мусор, а кандидаты. Но заявление о ЧУЖОЙ
 * странице ничего не говорит о НАШЕЙ копии: между ними стоит наш разбор, и он
 * уже уличён — регулярка ловила профиль высот `[[0, 795], ...]` и писала его в
 * базу как геометрию, которая на карте шла через весь край.
 *
 * Поэтому черта проходит не по честности источника, а по тому, что мы можем
 * проверить сами. Оказалось — главное: источник отдаёт `[lng, lat, ele]`, и
 * высота на каждой точке это след прибора. Её несёт запись GPS и не несёт
 * полилиния, нарисованная мышью по карте.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackEvidence, ELEVATION_SHARE_FOR_RECORDED } from '@/lib/routes/track-evidence';

const SRC = readFileSync(join(process.cwd(), 'lib/routes/track-evidence.ts'), 'utf-8');

/**
 * Плотная линия под Петропавловском, шаг НЕРОВНЫЙ — как у живой записи:
 * человек то идёт, то стоит, то лезет.
 *
 * Первая редакция фикстур строила линию ровным шагом (`i * 0.00002`) — и
 * проверка ровности справедливо объявила их машинной перерисовкой. Ошибка
 * была в фикстуре, а не в правиле: ровная линия — это ровно то, что улика
 * должна отвергать.
 */
const walk = (n: number) => {
  const out: number[] = [0];
  for (let i = 1; i < n; i++) {
    // Детерминированная «походка»: шаг гуляет примерно втрое.
    out.push(out[i - 1] + 0.00005 * (1 + (i * 7) % 5));
  }
  return out;
};

const dense = (withEle: boolean, n = 300) => {
  const d = walk(n);
  return d.map((s, i) =>
    withEle ? [158.65 + s, 53.02 + s, 700 + i] : [158.65 + s, 53.02 + s],
  );
};

const geo = (coordinates: number[][]) => ({ type: 'LineString', coordinates });

describe('запись прибора опознаётся по высоте', () => {
  it('плотная непрерывная линия с высотой — записана', () => {
    const e = trackEvidence(geo(dense(true)));
    expect(e.verdict).toBe('recorded');
    expect(e.reasons).toEqual([]);
    expect(e.elevationShare).toBe(1);
  });

  it('та же линия без третьего числа — следа прибора нет', () => {
    const e = trackEvidence(geo(dense(false)));
    expect(e.verdict).toBe('drawn');
    expect(e.reasons.join(' ')).toMatch(/следа прибора/);
  });

  it('редкие потери высоты записи не отменяют', () => {
    // У настоящей записи прибор изредка теряет высоту. Требовать идеала
    // значило бы отбраковывать трек за единственную дырку.
    const pts = dense(true).map((p, i) => (i === 7 ? [p[0], p[1]] : p));
    expect(trackEvidence(geo(pts)).verdict).toBe('recorded');
  });

  it('ровный шаг выдаёт перерисовку машиной, даже когда высота есть', () => {
    /**
     * Вторая улика, и без неё первая обманывает. Высота на каждой точке
     * доказывает прибор — но её же даёт нарисованная линия, если сайт
     * посчитал профиль по рельефу. Так делают почти все.
     *
     * Живой прибор не пишет одинаковыми промежутками: человек то идёт, то
     * стоит. Ровный шаг у плотной линии — след пересчёта, а не ходьбы.
     */
    // Та же длина и та же плотность, что у живой фикстуры, — разница ТОЛЬКО
    // в ровности шага. Иначе тест доказывал бы что-то другое.
    const even = Array.from({ length: 300 }, (_, i) => [158.65 + i * 0.00015, 53.02 + i * 0.00015, 700 + i]);
    const e = trackEvidence(geo(even));
    expect(e.pacing).toBe('even');
    expect(e.verdict).toBe('drawn');
    expect(e.reasons.join(' ')).toMatch(/пересчитала машина/);
  });

  it('у живой записи шаг неровный', () => {
    expect(trackEvidence(geo(dense(true))).pacing).toBe('irregular');
  });

  it('короткая тропа не обвиняется в том, что её нечем судить', () => {
    /**
     * Первая редакция модуля считала «не плотная» всё, что не `surveyed`, —
     * включая ответ `unknown`, которым trackFidelity говорит «маршрут короче
     * двух километров, деление на малое число даёт шум». Неизвестность
     * становилась обвинением: тропа в полкилометра с высотой на каждой точке
     * записью не признавалась.
     *
     * Плотность здесь ПОДТВЕРЖДАЕТ, а не требуется. Против записи говорит
     * только настоящая разреженность.
     */
    const d = walk(40);
    const short = d.map((x, i) => [158.65 + x, 53.02 + x, 700 + i]);
    const e = trackEvidence(geo(short));
    expect(e.verdict).toBe('recorded');
    expect(e.reasons.join(' ')).not.toMatch(/редко/);
  });

  it('настоящая разреженность записью не считается', () => {
    // Ломаная миграции 168: три точки на двадцать километров.
    const sparse = [[158.6, 53.0, 100], [158.8, 53.1, 200], [159.0, 53.2, 300]];
    const e = trackEvidence(geo(sparse));
    expect(e.verdict).not.toBe('recorded');
    expect(e.reasons.join(' ')).toMatch(/редко/);
  });

  it('высота у трети точек — это уже не след прибора', () => {
    const pts = dense(true).map((p, i) => (i % 3 === 0 ? p : [p[0], p[1]]));
    const e = trackEvidence(geo(pts));
    expect(e.verdict).toBe('unclear');
    expect(e.elevationShare).toBeLessThan(ELEVATION_SHARE_FOR_RECORDED);
  });
});

describe('линия с высотой, но испорченная, записью не объявляется', () => {
  it('точка вне края — в разбор попали посторонние числа', () => {
    // Тот самый профиль высот: `lng = 795, lat = 0` — Гвинейский залив.
    const pts = [...dense(true), [795, 0, 810]];
    const e = trackEvidence(geo(pts));
    expect(e.verdict).not.toBe('recorded');
    expect(e.inBounds).toBe(false);
    expect(e.reasons.join(' ')).toMatch(/за границы края/);
  });

  it('разрыв в десятки километров', () => {
    const pts = [...dense(true), [160.9, 55.5, 900], [160.91, 55.51, 905]];
    const e = trackEvidence(geo(pts));
    expect(e.continuous).toBe(false);
    expect(e.verdict).not.toBe('recorded');
  });

  it('такая линия зовётся неясной, а не нарисованной', () => {
    // «Нарисована» — утверждение о происхождении, и говорить его о линии со
    // следом прибора нельзя. Это запись, с которой что-то не так, и чинится
    // она иначе.
    const pts = [...dense(true), [795, 0, 810]];
    expect(trackEvidence(geo(pts)).verdict).toBe('unclear');
  });
});

describe('улика не решает и не чинит', () => {
  it('своих порогов у модуля нет — судят те, кто уже судит', () => {
    // Второе правило о плотности или о границах разошлось бы с первым, а
    // расходиться тут нельзя: это утверждения об одних и тех же данных.
    expect(SRC).toMatch(/isPlausibleTrackPoint/);
    expect(SRC).toMatch(/routeIntegrity\(/);
    expect(SRC).toMatch(/trackFidelity\(/);
    // Единственный собственный порог — доля точек с высотой, и он назван.
    expect(SRC).toMatch(/ELEVATION_SHARE_FOR_RECORDED/);
  });

  it('модуль ничего не пишет — мера, меняющая измеряемое, не мера', () => {
    expect(SRC).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(SRC).not.toMatch(/pool\./);
  });

  it('мусор не роняет разбор и не превращается в улику', () => {
    expect(trackEvidence(null).verdict).toBe('unclear');
    expect(trackEvidence({}).verdict).toBe('unclear');
    expect(trackEvidence(geo([[158.65, 53.02, 700]])).verdict).toBe('unclear');
    expect(trackEvidence(geo([['a', 'b'] as unknown as number[]])).verdict).toBe('unclear');
  });
});

describe('перепись считает улики и печатает их', () => {
  const AUDIT = readFileSync(join(process.cwd(), 'lib/routes/geometry-audit.ts'), 'utf-8');
  const WORKFLOW = readFileSync(join(process.cwd(), '.github/workflows/route-data-audit.yml'), 'utf-8');

  it('улики считаются по СЫРОЙ геометрии', () => {
    // geometryToTrack отбрасывает третье число — считать по нему значило бы
    // потерять сам признак.
    expect(AUDIT).toMatch(/trackEvidence\(r\.geometry\)/);
    expect(AUDIT).toContain('track_evidence');
  });

  it('счёт доходит до глаз', () => {
    expect(WORKFLOW).toContain('track_evidence');
    expect(WORKFLOW).toMatch(/Улики записи/);
  });
});
