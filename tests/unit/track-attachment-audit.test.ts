/**
 * Пересуд привязок: сегодняшнее правило судит вчерашние решения.
 *
 * Треки цеплялись к маршрутам автоматически, по близости ОДНОЙ точки в
 * радиусе нескольких километров, и старый скрипт idilesom писал их в базу
 * без всякой защиты. Лог 26.07 показал результат: «Вулкан Ичинская сопка»
 * на «Эссовских термальных источниках».
 *
 * Правило починено, но сделанные им привязки уже лежат в базе. Здесь
 * проверяется, что пересуд называет РАЗНЫЕ болезни разными словами: чинятся
 * они по-разному, и «подозрительно» на всё сразу не помогло бы никому.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { judgeAttachment } from '@/lib/routes/track-attachment-audit';
import {
  MAX_MATCH_DIST_KM, AMBIGUOUS_MARGIN_KM, PROXIMITY_MAX_TRACK_KM,
} from '@/lib/import/kml-inbox';

describe('приговор называет болезнь, а не просто «подозрительно»', () => {
  it('якорь далеко от собственного трека — привязка не опирается на близость', () => {
    expect(judgeAttachment({
      anchorToTrackKm: MAX_MATCH_DIST_KM + 3,
      spanKm: 4,
      nearestOtherKm: 50,
    })).toBe('anchor_far');
  });

  it('длинный трек — близость одной точки ничего не доказывает', () => {
    // Случай Эссо: старт у посёлка, путь на десятки километров в сторону.
    expect(judgeAttachment({
      anchorToTrackKm: 1,
      spanKm: PROXIMITY_MAX_TRACK_KM + 20,
      nearestOtherKm: 40,
    })).toBe('track_long');
  });

  it('рядом другой маршрут — выбор был угадыванием', () => {
    expect(judgeAttachment({
      anchorToTrackKm: 1,
      spanKm: 4,
      nearestOtherKm: 1 + AMBIGUOUS_MARGIN_KM / 2,
    })).toBe('ambiguous');
  });

  it('всё сходится — привязка держится', () => {
    expect(judgeAttachment({
      anchorToTrackKm: 0.4,
      spanKm: 4,
      nearestOtherKm: 30,
    })).toBe('holds');
  });
});

describe('порядок проверок отражает, что чинить', () => {
  it('далёкий якорь важнее длины: там привязка держится ни на чём', () => {
    // Оба признака сразу — назвать надо худший, иначе разбор пойдёт не туда.
    expect(judgeAttachment({
      anchorToTrackKm: MAX_MATCH_DIST_KM + 10,
      spanKm: PROXIMITY_MAX_TRACK_KM + 50,
      nearestOtherKm: 0.5,
    })).toBe('anchor_far');
  });

  it('длина важнее неоднозначности: длинному треку близость не судья вовсе', () => {
    expect(judgeAttachment({
      anchorToTrackKm: 1,
      spanKm: PROXIMITY_MAX_TRACK_KM + 1,
      nearestOtherKm: 1.1,
    })).toBe('track_long');
  });
});

describe('единственный маршрут в округе — не повод объявлять неоднозначность', () => {
  it('соседей нет — привязка держится', () => {
    // null это «сравнивать не с кем», а не «сосед на нулевом расстоянии».
    // Ноль вместо неизвестного тут перекрасил бы в красное весь дальний край.
    expect(judgeAttachment({
      anchorToTrackKm: 1,
      spanKm: 4,
      nearestOtherKm: null,
    })).toBe('holds');
  });
});

describe('пороги берутся из чинёного правила, а не свои', () => {
  it('пересуд судит теми же числами, что и импорт', () => {
    // Иначе получится третья копия правила — ровно то, из-за чего SQL-чистка
    // алертов отстала от TS-стража и держала запрет на трети справочника.
    expect(MAX_MATCH_DIST_KM).toBeGreaterThan(0);
    expect(PROXIMITY_MAX_TRACK_KM).toBeGreaterThan(MAX_MATCH_DIST_KM);
    expect(AMBIGUOUS_MARGIN_KM).toBeGreaterThan(0);
  });
});

describe('пересуд судит только живое', () => {
  it('слитые и скрытые записи в выборку не попадают', () => {
    // Слияния 20.08: без фильтра «худшими» выходили уже слитые скрытые
    // (Верхне-Паратунские, якорь в 191 км) — шум о мёртвых заслонял живые.
    const src = readFileSync(
      join(process.cwd(), 'lib/routes/track-attachment-audit.ts'), 'utf-8',
    );
    expect(src).toContain('is_visible = true AND merged_into_id IS NULL');
  });
});
