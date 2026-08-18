/**
 * Сверка с источником: что считается расхождением, а что нет.
 *
 * Перепись меряет то, что В базе, и потому слепа к потерям разбора: взятый не
 * тот блок, обрезанный трек, выкинутые высоты — оставшееся выглядит
 * безупречно. Сверка ставит нашу линию рядом с оригиналом.
 *
 * Сторож держит порядок вердиктов: сначала «есть ли что сравнивать», потом
 * «об одной ли линии речь», и только потом подробности. Иначе «у нас 40 точек,
 * у них 400» прозвучит как потеря там, где сравнивали разные пути.
 */
import { describe, it, expect } from 'vitest';
import { reconcileTrack, titlesAgree } from '@/lib/routes/track-reconcile';

/** Линия в порядке GeoJSON: [долгота, широта, высота?]. */
const line = (n: number, withEle = true, shiftLng = 0): number[][] =>
  Array.from({ length: n }, (_, i) =>
    withEle
      ? [158.4 + shiftLng + i * 0.001, 53.25 + i * 0.001, 700 + i]
      : [158.4 + shiftLng + i * 0.001, 53.25 + i * 0.001],
  );

describe('сверка нашей линии с источником', () => {
  it('одинаковые линии — расхождения нет', () => {
    expect(reconcileTrack(line(100), line(100)).verdict).toBe('same');
  });

  it('разметка источника чуть изменилась — это ещё та же линия', () => {
    // Источник вправе переразметить страницу: тот же путь, чуть иной шаг.
    // Линия та же — значит и концы те же, меняется только частота точек.
    const resampled = (n: number) =>
      Array.from({ length: n }, (_, i) => [158.4 + (i * 0.1) / (n - 1), 53.25 + (i * 0.1) / (n - 1), 700 + i]);
    expect(reconcileTrack(resampled(95), resampled(100)).verdict).toBe('same');
  });

  it('у нас заметно меньше точек — разбор взял не весь трек', () => {
    const r = reconcileTrack(line(40), line(400));
    expect(r.verdict).toBe('ours_truncated');
    expect(r.ourPoints).toBe(40);
    expect(r.theirPoints).toBe(400);
  });

  it('высота потеряна молча — вердикт называет именно это', () => {
    const r = reconcileTrack(line(100, false), line(100, true));
    expect(r.verdict).toBe('elevation_lost');
    expect(r.ourElevation).toBe(false);
    expect(r.theirElevation).toBe(true);
  });

  it('разные линии не сравниваются по числу точек', () => {
    // Ключевой порядок: линия сдвинута на километры И точек меньше. Ответ
    // должен быть «это разные линии», а не «нас обрезали»: обрезание
    // предполагает, что речь об одном пути.
    const r = reconcileTrack(line(40, true, 0.5), line(400));
    expect(r.verdict).toBe('line_moved');
    expect(r.startShiftM).toBeGreaterThan(200);
  });

  it('молчание источника не выдаётся за наш дефект', () => {
    expect(reconcileTrack(line(100), []).verdict).toBe('source_has_no_track');
    expect(reconcileTrack([], line(100)).verdict).toBe('ours_empty');
  });
});

describe('имена нашей записи и страницы-донора', () => {
  it('одно место, разная редакция названия — согласны', () => {
    expect(titlesAgree('Вулкан Вилючинский', 'Восхождение на Вилючинский вулкан')).toBe(true);
    expect(titlesAgree('Озеро Толмачёва', 'Толмачева озеро')).toBe(true);
  });

  it('разные места — не согласны', () => {
    // Правило общее с уборкой битых привязок: родовое слово («долина»,
    // «вулкан») тёзкой никого не делает.
    // Именно этот случай ловит подмену: трек привинчен по близости, а
    // говорит о другом объекте.
    expect(titlesAgree('Вулкан Козельский', 'Авачинский перевал')).toBe(false);
    expect(titlesAgree('Долина гейзеров', 'Долина смерти')).toBe(false);
  });
});
