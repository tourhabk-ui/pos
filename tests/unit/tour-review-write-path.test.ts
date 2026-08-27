/**
 * Отзывы о туре: запись и чтение — ОДНА таблица (operator_tour_reviews).
 *
 * Раздвоение с марта 2026: карточка показывала operator_tour_reviews (BIGINT
 * tour_id), а форма писала в старую reviews (tour_id UUID, FK на удалённую
 * tours) — вставка падала всегда, catch прятал причину («Ошибка при создании
 * отзыва», владелец 06.08). Миграция 087 сама предупреждала о несовместимости
 * типов — и вместо починки завела вторую таблицу.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('API отзывов — одна таблица на чтение и запись', () => {
  const src = read('app/api/reviews/tour/[tourId]/route.ts');

  it('POST пишет в operator_tour_reviews, старой reviews в файле нет', () => {
    expect(src).toMatch(/INSERT INTO operator_tour_reviews/);
    expect(src).not.toMatch(/INSERT INTO reviews\b/);
    expect(src).not.toMatch(/FROM reviews\b/);
  });

  it('GET читает ту же таблицу, что рендерит карточка', () => {
    expect(src).toMatch(/FROM operator_tour_reviews/);
  });

  it('гейт честности: отзыв только при завершённой брони', () => {
    expect(src).toMatch(/booking_status = 'completed'/);
    expect(src).toMatch(/только после завершения тура/);
  });

  it('отказ БД наружу словами через redactPII, не немым 500', () => {
    expect(src).toMatch(/redactPII/);
    expect(src).toMatch(/Не удалось сохранить отзыв/);
  });

  it('фото — только наши: S3 или относительный путь, чужие хосты режутся', () => {
    expect(src).toMatch(/isOwnPhotoUrl/);
    expect(src).toMatch(/s3\.twcstorage\.ru/);
    expect(src).toMatch(/photos\.filter\(isOwnPhotoUrl\)/);
  });

  it('тип колонки photos берётся из схемы (урок operator_tours)', () => {
    expect(src).toMatch(/getColumnTypes\('operator_tour_reviews'\)/);
    expect(src).toMatch(/valueForColumn\(photos/);
  });
});

describe('загрузка фото отзыва', () => {
  const src = read('app/api/reviews/photo/route.ts');

  it('тот же гейт, что у отзыва: только после завершённой поездки', () => {
    expect(src).toMatch(/requireAuth/);
    expect(src).toMatch(/booking_status = 'completed'/);
  });

  it('на проде без S3 — честный отказ, не запись в контейнер', () => {
    expect(src).toMatch(/NODE_ENV === 'production'/);
    expect(src).toMatch(/diagnostics\/storage/);
    // Локальной записи в файловую систему здесь нет вовсе.
    expect(src).not.toMatch(/fs\.writeFile/);
  });
});

describe('форма и показ', () => {
  it('форма шлёт photos и грузит их через /api/reviews/photo', () => {
    const src = read('components/marketplace/TourReviewForm.tsx');
    expect(src).toMatch(/\/api\/reviews\/photo/);
    expect(src).toMatch(/photos/);
    expect(src).toMatch(/type="file"/);
    // Отправка блокируется, пока фото грузится — иначе отзыв уйдёт без него.
    expect(src).toMatch(/state === 'sending' \|\| uploading/);
  });

  it('форма доступна и при существующих отзывах, не только в пустом состоянии', () => {
    const src = read('app/marketplace/tours/[id]/_TourDetailClient.tsx');
    const count = (src.match(/<TourReviewForm/g) ?? []).length;
    expect(count, 'форма должна быть в обеих ветках отзывов').toBeGreaterThanOrEqual(2);
  });

  it('чтение отзывов переживает отставшую миграцию 832 (photos)', () => {
    const src = read('lib/tours/tour-detail-query.ts');
    expect(src).toMatch(/isUndefinedColumn\(e\)/);
    const fn = src.slice(src.indexOf('getTourReviews'));
    expect(fn).toMatch(/photos/);
  });

  it('миграция 832 идемпотентна и дополняет живую таблицу', () => {
    const sql = read('migrations/832_tour_reviews_write_path.sql');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS user_id/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS photos/);
    expect(sql).toMatch(/operator_tour_reviews/);
  });
});

describe('выдуманные отзывы 087 убраны (решение владельца 07.08)', () => {
  it('миграция 833: сид без user_id удалён, рейтинг пересчитан от живых', () => {
    const sql = read('migrations/833_remove_fake_reviews_087.sql');
    // Идентификация по факту (user_id IS NULL = до пути записи), не по списку имён.
    expect(sql).toMatch(/DELETE FROM operator_tour_reviews WHERE user_id IS NULL/);
    expect(sql).toMatch(/AVG\(r\.rating\)/);
    expect(sql).toMatch(/Источник: владелец/);
  });

  it('833 стоит после 832 (user_id должен существовать к моменту DELETE)', () => {
    expect(read('migrations/832_tour_reviews_write_path.sql')).toMatch(/user_id/);
  });
});

/**
 * Кабинет туриста «Мои отзывы» — тот же дефект, той же датой класса, что
 * форма 06.08, но найден только аудитом 24.08: три ручки ездили по старой
 * `reviews` (tour_id UUID) с JOIN'ом на operator_tours (id BIGINT) — ошибка
 * 42883 на каждом запросе. GET /api/reviews/my отвечал 500 всегда,
 * POST /api/reviews не создал ни одного отзыва, GET /api/reviews прятал
 * ошибку за вечным пустым degraded-списком. Тот же uuid-против-bigint жил и
 * в SDK-инструментах Кузьмича — подзапрос рейтинга ронял ВЕСЬ поиск туров.
 */
describe('кабинет туриста и SDK — та же таблица, что у карточки', () => {
  it('«Мои отзывы» читает operator_tour_reviews, старой reviews в файле нет', () => {
    const src = read('app/api/reviews/my/route.ts');
    expect(src).toMatch(/FROM operator_tour_reviews/);
    expect(src).not.toMatch(/FROM reviews\b/);
  });

  it('публичный GET /api/reviews читает operator_tour_reviews', () => {
    const src = read('app/api/reviews/route.ts');
    expect(src).toMatch(/FROM operator_tour_reviews/);
    expect(src).not.toMatch(/FROM reviews\b/);
    // Мёртвый POST (INSERT в reviews с uuid tour_id) удалён — запись только
    // через канонический /api/reviews/tour/[tourId].
    expect(src).not.toMatch(/export async function POST/);
    expect(src).not.toMatch(/INSERT INTO reviews\b/);
  });

  it('форма кабинета пишет через канонический эндпоинт', () => {
    const src = read('app/hub/tourist/reviews/_ReviewsClient.tsx');
    expect(src).toMatch(/\/api\/reviews\/tour\/\$\{/);
    expect(src).not.toMatch(/fetch\('\/api\/reviews',/);
  });

  it('SDK-инструменты Кузьмича не считают рейтинг по мёртвой таблице', () => {
    const src = read('lib/agents/sdk/tourist-tools.ts');
    expect(src).not.toMatch(/FROM reviews\b/);
    // Рейтинг — денормализованные t.rating/t.review_count, которые
    // пересчитывает запись отзыва по видимым строкам operator_tour_reviews.
    expect(src).toMatch(/t\.rating AS avg_rating/);
  });
});
