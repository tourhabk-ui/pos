/**
 * Мусор отделяется, координаты не выдумываются.
 *
 * Владелец 17.08: «если треки реальные, но они замусорены». Так и есть — и
 * мусор наш, не источника: импортёр искал координаты регуляркой по любым
 * вложенным числовым массивам страницы, ловил профиль высот `[[0, 795], ...]`
 * и писал его в базу как геометрию. Правка 86316be закрыла границу записи, но
 * записанное до неё осталось записанным.
 *
 * Отсюда цена вопроса: выбросить пятьсот честных точек из-за двух посторонних
 * — потерять настоящий путь; «подтянуть» посторонние к соседям — выдумать
 * координаты там, где данных нет, и по ним человек пойдёт. Поэтому точка либо
 * доказуемо посторонняя и удаляется целиком, либо остаётся как есть.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanTrack, MAX_REMOVED_SHARE } from '@/lib/routes/track-clean';
import { LINE_BREAK_KM } from '@/lib/routes/shape-match';

const SRC = readFileSync(join(process.cwd(), 'lib/routes/track-clean.ts'), 'utf-8');

/** Честный трек под Петропавловском: точки через считанные метры. */
const track = (n = 200) =>
  Array.from({ length: n }, (_, i) => [158.65 + i * 0.00005, 53.02 + i * 0.00005, 700 + i]);

describe('чистый трек остаётся нетронутым', () => {
  it('ничего не удаляется и не переставляется', () => {
    const t = track();
    const r = cleanTrack(t);
    expect(r.verdict).toBe('clean');
    expect(r.removed).toEqual([]);
    expect(r.points).toEqual(t);
  });
});

describe('доказуемо посторонняя точка отделяется', () => {
  it('профиль высот, прочитанный как координаты', () => {
    // `[0, 795]` разворачивалось в lng = 795, lat = 0 — Гвинейский залив.
    const t = [...track(), [795, 0, 810]];
    const r = cleanTrack(t);
    expect(r.verdict).toBe('cleaned');
    expect(r.removed).toHaveLength(1);
    expect(r.removed[0].reason).toBe('out_of_bounds');
    // Остальные точки — как были, без сдвигов.
    expect(r.points).toEqual(track());
  });

  it('скачок GPS: ушла на десятки километров и вернулась', () => {
    const t = track();
    const spiked = [...t.slice(0, 100), [160.9, 55.5, 900], ...t.slice(100)];
    const r = cleanTrack(spiked);
    expect(r.verdict).toBe('cleaned');
    expect(r.removed[0].reason).toBe('spike');
    expect(r.points).toEqual(t);
  });

  it('повтор координаты', () => {
    const t = track();
    const r = cleanTrack([...t.slice(0, 50), t[49], ...t.slice(50)]);
    expect(r.removed[0].reason).toBe('duplicate');
    expect(r.points).toEqual(t);
  });

  it('удаление названо причиной и местом', () => {
    // Чистка, о которой нельзя спросить «что именно ты убрала»,
    // неотличима от порчи.
    const r = cleanTrack([...track(), [795, 0, 810]]);
    expect(r.removed[0].index).toBe(200);
    expect(r.removed[0].point).toEqual([795, 0, 810]);
    expect(r.reasons.join(' ')).toMatch(/Вне края: 1/);
  });
});

describe('длинный настоящий перегон скачком не считается', () => {
  it('переход в сотню километров остаётся на месте', () => {
    // «Сплав по реке Камчатка» — 282 км по габариту. Скачок отличается тем,
    // что СОСЕДИ остаются рядом друг с другом: линия ушла и вернулась.
    const far = [
      [158.6, 53.0, 10], [159.0, 53.4, 20], [160.0, 54.2, 30], [160.9, 55.0, 40],
    ];
    const r = cleanTrack(far);
    expect(r.verdict).toBe('clean');
    expect(r.removed).toEqual([]);
  });

  it('порог разрыва берётся общий, своего нет', () => {
    // «Разрыв» при чистке и «разрыв» при оценке — одно утверждение о линии.
    expect(SRC).toMatch(/LINE_BREAK_KM/);
    expect(LINE_BREAK_KM).toBeGreaterThan(0);
  });
});

describe('чистка знает, где перестаёт быть чисткой', () => {
  it('посторонняя каждая пятая — это другая запись, а не мусор', () => {
    const t = track(50);
    const dirty = t.flatMap((p, i) => (i % 5 === 0 ? [p, [795, 0, 800]] : [p]));
    const r = cleanTrack(dirty);
    expect(r.verdict).toBe('not_cleanable');
    expect(r.removedShare).toBeGreaterThan(MAX_REMOVED_SHARE);
    expect(r.reasons.join(' ')).toMatch(/другая запись/);
  });

  it('если после отделения ничего не осталось — это была не линия', () => {
    const r = cleanTrack([[795, 0, 800], [796, 0, 810], [797, 0, 820]]);
    expect(r.verdict).toBe('not_cleanable');
    expect(r.points).toEqual([]);
  });

  it('мусор вместо линии не роняет разбор', () => {
    expect(cleanTrack([]).verdict).toBe('not_cleanable');
    expect(cleanTrack([['a', 'b'] as unknown as number[]]).verdict).toBe('not_cleanable');
  });
});

describe('координаты не выдумываются', () => {
  it('в модуле нет ни сглаживания, ни интерполяции, ни перестановки', () => {
    // Подтянуть точку к соседям значит записать координату, которой в данных
    // не было, — а по этой линии человек пойдёт.
    for (const forbidden of [/interpolat/i, /smooth/i, /\.sort\(/, /\.reverse\(/, /average|среднее/i]) {
      expect(SRC, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it('высота уцелевших точек сохраняется — она и есть улика записи', () => {
    const r = cleanTrack([...track(), [795, 0, 810]]);
    expect(r.points.every((p) => p.length === 3)).toBe(true);
  });
});

describe('перепись меряет чистку, но не чистит', () => {
  const AUDIT = readFileSync(join(process.cwd(), 'lib/routes/geometry-audit.ts'), 'utf-8');
  const WORKFLOW = readFileSync(join(process.cwd(), '.github/workflows/route-data-audit.yml'), 'utf-8');

  it('перепись осталась только читающей', () => {
    expect(AUDIT).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/);
  });

  it('считается приз, а не только объём работы', () => {
    // «Очищено 40» не говорит, стало ли от этого хоть одним настоящим треком
    // больше. Отвечает на это только повторная проверка улик.
    expect(AUDIT).toContain('recorded_after_clean');
    expect(WORKFLOW).toContain('recorded_after_clean');
  });
});
