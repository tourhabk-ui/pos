/**
 * Зеленовские озерки и «Раздолье Камчатки» — ДВА места, не одно.
 *
 * Повод (владелец, 30.08): в каталоге маршрут по «Зеленовские» находится, а
 * места нет. Перепись прода (place-audit) вернула total: 0 — запись не скрыта
 * и не слита, её не существовало. При заведении выяснилось, что объекта два:
 * «в народе старые и новые, между ними 200 метров», скважины у них РАЗНЫЕ,
 * и поэтому анализ воды у двух баз разный.
 *
 * Что этот сторож держит:
 *
 *  1. Записи именно две, с разными координатами. Схлопнуть их в одну значит
 *     приписать человеку не тот состав воды — на платформе, где вода 70 °C
 *     и сероводород, это не косметика.
 *  2. В миграции НЕТ гарда по близости. Прецедент 780 отсекал вставку, если в
 *     радиусе 2 км уже есть видимый hot_spring; здесь такой гард молча создал
 *     бы одну запись из двух — базы стоят в сотне метров друг от друга.
 *     Это ровно тот класс отказа, где «успех» неотличим от «сделал половину».
 *  3. `capacity_per_day` выставлен NULL ЯВНО: у колонки DEFAULT 50, и молчание
 *     напечатало бы на карточке вместимость, которую никто не мерил (4.0).
 *  4. У обеих есть профиль безопасности с именными противопоказаниями —
 *     это блок карточки точки «что знать» (CLAUDE.md 9).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SQL = readFileSync(
  join(process.cwd(), 'migrations/925_zelenovskie_ozerki_and_razdolie.sql'),
  'utf-8',
);

/** Только код: разбор в шапке вправе называть то, что миграция не делает. */
const CODE = SQL.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');

const ZELENOVSKIE = 'a1e5c7d3-9f42-4b18-8e07-3c95d2b6a410';
const RAZDOLIE = 'b2f6d8e4-0a53-4c29-9f18-4da6e3c7b521';

function distanceM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

describe('две базы — две записи', () => {
  it('в places вставляются ровно две строки', () => {
    const inserts = [...CODE.matchAll(/INSERT INTO places\b/g)];
    expect(inserts.length).toBe(2);
  });

  it('у записей разные фиксированные ark_id — идемпотентность и различимость', () => {
    expect(CODE).toContain(ZELENOVSKIE);
    expect(CODE).toContain(RAZDOLIE);
    expect(ZELENOVSKIE).not.toBe(RAZDOLIE);
  });

  it('координаты разные и стоят примерно в сотне метров', () => {
    // Числа берутся из самой миграции, а не дублируются в тесте: разойдись
    // они — тест сверял бы себя с собой.
    const coords = [...CODE.matchAll(/^\s*(5\d\.\d+),\s*(15\d\.\d+),\s*$/gm)]
      .map((m) => [Number(m[1]), Number(m[2])] as const);
    expect(coords.length, 'ожидались две пары координат').toBe(2);

    const [a, b] = coords;
    expect(a[0]).not.toBe(b[0]);
    expect(a[1]).not.toBe(b[1]);

    const d = distanceM(a[0], a[1], b[0], b[1]);
    // Владелец назвал «200 метров», точки 2ГИС ставятся на здание — поэтому
    // вилка широкая. Важно другое: это НЕ одна точка и НЕ разные концы края.
    expect(d).toBeGreaterThan(30);
    expect(d).toBeLessThan(400);
  });
});

describe('ловушка миграции 780 не повторена', () => {
  it('нет гарда по радиусу — иначе вторая база не вставилась бы молча', () => {
    // 780 отсекала вставку при наличии видимого hot_spring в 2 км. Здесь
    // близость — не признак дубля, а сам факт, ради которого всё делается.
    expect(CODE).not.toMatch(/6371\s*\*\s*acos/);
    expect(CODE).not.toMatch(/radians\(/);
  });

  it('гарды поимённые и не перекрывают друг друга', () => {
    expect(CODE).toMatch(/name ILIKE '%зеленовск%'/);
    expect(CODE).toMatch(/name ILIKE '%раздолье камчатки%'/);
    // «раздолье камчатки», а не «раздолье»: посёлок называется Раздольный,
    // и слишком широкий гард однажды поймает не то.
    expect(CODE).not.toMatch(/name ILIKE '%раздолье%'/);
  });
});

describe('профиль безопасности у обеих', () => {
  it('два профиля, по одному на место', () => {
    const inserts = [...CODE.matchAll(/INSERT INTO location_safety_profile\b/g)];
    expect(inserts.length).toBe(2);
  });

  it('вместимость — явный NULL, а не DEFAULT 50', () => {
    // Колонка имеет DEFAULT 50. Не указать её значит напечатать на карточке
    // число, которого никто не мерил.
    expect(CODE).toMatch(/capacity_per_day/);
    const profiles = CODE.split('INSERT INTO location_safety_profile').slice(1);
    expect(profiles.length).toBe(2);
    for (const p of profiles) {
      expect(p.slice(0, 400)).toMatch(/\bNULL,/);
    }
  });

  it('в обоих профилях именные противопоказания, а не общие слова', () => {
    const profiles = CODE.split('INSERT INTO location_safety_profile').slice(1);
    for (const p of profiles) {
      expect(p).toMatch(/Противопоказания:/);
      expect(p).toMatch(/гипертоническая болезнь III степени/);
      expect(p).toMatch(/вторая половина беременности/);
    }
  });

  it('термальная опасность помечена словарным значением, а не выдуманным', () => {
    // 'thermal' есть в HAZARD_LABELS (components/shared/HazardBadgeStrip).
    // Незнакомое значение отрисовалось бы бейджем без подписи.
    expect(CODE).toMatch(/ARRAY\['thermal'\]::text\[\]/);
  });
});

describe('описания разводят два места словами, а не только координатой', () => {
  it('каждое описание называет соседа и говорит, что скважина другая', () => {
    expect(CODE).toMatch(/Раздолье Камчатки[^']*?другой скважине/s);
    expect(CODE).toMatch(/Скважина здесь другая/);
  });
});
