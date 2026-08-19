/**
 * Отзыв о ТУРЕ и отзыв о МАРШРУТЕ живут в разных таблицах — и не путаются.
 *
 * ── Что было ───────────────────────────────────────────────────────────────
 *
 * Перепись 19.08 измерила типы через information_schema:
 *
 *   reviews.tour_id      uuid     ← на деле ark_id МАРШРУТА
 *   operator_tours.id    bigint
 *
 * Оператора uuid = bigint в Postgres нет. Значит любой JOIN между `reviews` и
 * `operator_tours` падал целиком, и на нём стояли: список отзывов в кабинете
 * оператора, его статистика, ответ на отзыв, админская модерация. Ни одна из
 * этих поверхностей не работала — при том что тесты были зелёные, а экраны
 * показывали пустоту, неотличимую от «отзывов нет».
 *
 * Причина не в типе, а в ИМЕНИ: колонка `tour_id` хранит маршрут. Пока имя
 * лжёт, каждый следующий читатель соединяет её с турами — и так и было.
 *
 * ── Как теперь ─────────────────────────────────────────────────────────────
 *
 *   operator_tour_reviews  отзывы о ТУРАХ (tour_id bigint, миграция 087)
 *                          публикуются сразу, гейт — завершённая бронь,
 *                          модерация прячет (is_hidden, миграция 878)
 *   reviews                отзывы о МАРШРУТАХ и МЕСТАХ (tour_id = ark_id,
 *                          place_id → places.ark_id, миграция 162)
 *
 * Третьей таблицы для отзывов о турах заводить нельзя: я начал добавлять
 * `reviews.operator_tour_id` и остановился именно поэтому.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

/** Файлы, обслуживающие отзывы о ТУРАХ. */
const TOUR_REVIEW_SURFACES = [
  'app/api/operator/reviews/route.ts',
  'app/api/operator/reviews/stats/route.ts',
  'app/api/operator/reviews/[id]/reply/route.ts',
  'app/api/reviews/tour/[tourId]/route.ts',
];

describe('отзывы о турах читаются из своей таблицы', () => {
  for (const f of TOUR_REVIEW_SURFACES) {
    it(`${f} не соединяет reviews с турами`, () => {
      const src = read(f);
      // Ровно та форма, что падала: reviews (uuid) против operator_tours (bigint).
      expect(src).not.toMatch(/FROM\s+reviews\s+r[\s\S]{0,200}?JOIN\s+operator_tours/i);
      expect(src).toMatch(/operator_tour_reviews/);
    });
  }
});

describe('скрытое модерацией не влияет на витрину', () => {
  const PUBLIC = read('app/api/reviews/tour/[tourId]/route.ts');

  it('выдача, счёт и средняя считают только видимые', () => {
    // Три места должны считать одно и то же: иначе скрытый отзыв продолжит
    // тянуть оценку вниз, оставаясь невидимым, и оператор не поймёт, за что.
    const hidden = PUBLIC.match(/is_hidden/g) ?? [];
    expect(hidden.length).toBeGreaterThanOrEqual(4);
  });

  it('колонка читается терпимо — код деплоится раньше миграции', () => {
    // Урок 18.08: чтение новой колонки уехало вперёд миграции, и карточка
    // маршрута перестала открываться. Нет колонки — прежнее поведение.
    expect(PUBLIC).toMatch(/to_jsonb\(r\)->>'is_hidden'/);
    expect(PUBLIC).toMatch(/COALESCE\(\(to_jsonb\(r\)->>'is_hidden'\)::boolean, FALSE\)/);
  });
});

describe('админская модерация знает, чем занимается', () => {
  const ADMIN = read('app/api/admin/content/reviews/route.ts');

  it('соединяется с маршрутами и местами, а не с турами', () => {
    expect(ADMIN).toMatch(/kamchatka_routes kr ON kr\.ark_id = r\.tour_id/);
    expect(ADMIN).toMatch(/places pl ON pl\.ark_id = r\.place_id/);
    expect(ADMIN).not.toMatch(/JOIN operator_tours/);
  });

  it('поле называется по содержимому, а не «тур»', () => {
    // Пока имя лгало, каждый следующий читатель соединял его с турами.
    expect(ADMIN).toMatch(/as subject_name/);
    expect(ADMIN).not.toMatch(/as tour_name/);
  });
});

describe('третьего места для отзывов о турах нет', () => {
  it('колонка reviews.operator_tour_id не заводится', () => {
    const migrations = execSync("git ls-files 'migrations/*.sql'", { encoding: 'utf-8', cwd: process.cwd() })
      .split('\n').filter(Boolean);
    const bad = migrations.filter((m) => {
      // Комментарии отбрасываются: в 878 эта колонка НАЗВАНА словами — там
      // объяснено, почему её не завели. Первая редакция сторожа поймала
      // собственное объяснение и покраснела на нём. Сторож обязан судить
      // DDL, а не рассуждение о DDL.
      const sql = readFileSync(m, 'utf-8')
        .split('\n')
        .map((l) => (l.indexOf('--') === -1 ? l : l.slice(0, l.indexOf('--'))))
        .join('\n');
      return /ALTER\s+TABLE\s+reviews[\s\S]{0,120}?ADD\s+COLUMN[\s\S]{0,80}?operator_tour_id/i.test(sql);
    });
    expect(bad, 'отзывы о турах уже имеют operator_tour_reviews — третье место разойдётся с обоими').toEqual([]);
  });

  it('сторож ловит именно DDL, а не упоминание в тексте', () => {
    // Проверка самого сторожа: без неё «зелено» означало бы лишь то, что
    // регулярка ничего не находит.
    const ddl = 'ALTER TABLE reviews ADD COLUMN IF NOT EXISTS operator_tour_id BIGINT;';
    expect(/ALTER\s+TABLE\s+reviews[\s\S]{0,120}?ADD\s+COLUMN[\s\S]{0,80}?operator_tour_id/i.test(ddl)).toBe(true);
    const prose = '-- reviews.operator_tour_id заводить нельзя: есть operator_tour_reviews';
    const stripped = prose.slice(0, prose.indexOf('--'));
    expect(/operator_tour_id/i.test(stripped)).toBe(false);
  });
});
