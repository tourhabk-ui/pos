/**
 * Загрузивший фото видит своё фото.
 *
 * Владелец 14.09: «я лично загружал свои фото и их нет». Путь работал ровно
 * так, как написан, и именно поэтому выглядел сломанным:
 *
 *   `POST /api/places/[id]/photos` кладёт снимок со статусом `pending`
 *   `GET`  того же адреса отдавал ТОЛЬКО `approved`
 *   одобрение живёт на другом экране — `/hub/admin/user-photos`
 *
 * Два следствия, и оба плохи по-разному:
 *
 *  1. **Админ вставал в очередь к самому себе.** Модерация фильтрует ЧУЖИЕ
 *     снимки; владелец, поставивший фото со страницы места, должен был пойти
 *     в админку и одобрить собственный кадр. Снаружи это неотличимо от
 *     «загрузка не работает».
 *
 *  2. **Пусто при «ждёт проверки» и пусто при «не загрузилось».** Человек,
 *     приславший фото, видел один и тот же пустой экран в обоих случаях —
 *     третий исход, выданный за первый (§4.0). Форма при этом обещала
 *     «появятся после проверки», то есть обещание было, а способа увидеть
 *     его исполнение — нет.
 *
 * Сторож держит обе половины и ГРАНИЦУ: чужие непроверенные снимки не
 * показываются никому, иначе модерация перестаёт быть модерацией.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const ROUTE = read('app/api/places/[id]/photos/route.ts');
const VIEW = read('components/places/PlaceUserPhotos.tsx');

describe('админ не модерирует сам себя', () => {
  it('статус решает роль из токена, а не тело запроса', () => {
    expect(ROUTE).toMatch(/const isAdmin = auth\.role === 'admin'/);
    expect(ROUTE).toMatch(/const status = isAdmin \? 'approved' : 'pending'/);
  });

  it('статус доезжает до INSERT, а не остаётся переменной', () => {
    const at = ROUTE.indexOf('INSERT INTO user_place_photos');
    expect(at).toBeGreaterThan(-1);
    const stmt = ROUTE.slice(at, ROUTE.indexOf('RETURNING id', at));
    expect(stmt).toContain('status');
    const call = ROUTE.slice(at, at + 600);
    expect(call).toMatch(/captionValue \?\? null, status/);
  });

  it('статус НЕ принимается снаружи — иначе модерацию обходит кто угодно', () => {
    // Роль берётся из проверенного токена; поля status в разборе тела нет.
    expect(ROUTE).not.toMatch(/formData\.get\(['"]status['"]\)/);
    expect(ROUTE).not.toMatch(/body\.status|\.status\s*=\s*req/);
  });

  it('обещание совпадает с тем, что произошло', () => {
    // Обещать админу модерацию, которой не будет, — вежливое враньё.
    expect(ROUTE).toMatch(/isAdmin \? 'Фото опубликовано' : 'Фото отправлено на модерацию'/);
  });
});

describe('своё фото видно в любом состоянии', () => {
  it('GET отдаёт одобренные ИЛИ свои', () => {
    const at = ROUTE.indexOf('FROM user_place_photos');
    expect(at).toBeGreaterThan(-1);
    const stmt = ROUTE.slice(at, ROUTE.indexOf('ORDER BY', at));
    expect(stmt).toContain("status = 'approved'");
    expect(stmt).toMatch(/user_id = \$2::uuid/);
  });

  it('чужое непроверенное не показывается никому — граница на месте', () => {
    // Без этой скобки условие «approved ИЛИ моё» развалилось бы в «всё».
    const at = ROUTE.indexOf('FROM user_place_photos');
    const stmt = ROUTE.slice(at, ROUTE.indexOf('ORDER BY', at));
    expect(stmt).toMatch(/AND \(status = 'approved'/);
    expect(stmt).toMatch(/OR \(\$2::uuid IS NOT NULL AND user_id = \$2::uuid\)\)/);
  });

  it('гость не становится владельцем чужих снимков при viewerId = null', () => {
    // `user_id = NULL` в SQL не истинно никогда, но полагаться на это молча
    // нельзя: условие проверяет NOT NULL явно.
    expect(ROUTE).toMatch(/\$2::uuid IS NOT NULL AND user_id = \$2::uuid/);
    expect(ROUTE).toMatch(/const viewerId = viewer\?\.userId \?\? null/);
  });

  it('ответ несёт статус и признак «моё» — иначе экран их не различит', () => {
    const at = ROUTE.indexOf('SELECT id, url, caption, created_at');
    expect(at).toBeGreaterThan(-1);
    const sel = ROUTE.slice(at, ROUTE.indexOf('FROM user_place_photos', at));
    expect(sel).toContain('status');
    expect(sel).toMatch(/AS mine/);
  });
});

describe('экран называет состояние словами', () => {
  it('своё непроверенное подписано, чужое одобренное — нет', () => {
    expect(VIEW).toMatch(/function ownStatusLabel/);
    expect(VIEW).toMatch(/if \(!p\.mine\) return null;/);
    expect(VIEW).toMatch(/Ждёт проверки — видно только вам/);
    expect(VIEW).toMatch(/Отклонено модератором/);
  });

  it('одобренное своё подписи не требует — это просто фото', () => {
    const at = VIEW.indexOf('function ownStatusLabel');
    const body = VIEW.slice(at, VIEW.indexOf('}', VIEW.indexOf('return null;', VIEW.indexOf('rejected'))));
    expect(body).not.toContain("'approved'");
  });

  it('подпись рисуется в карточке снимка', () => {
    expect(VIEW).toMatch(/\{ownStatusLabel\(p\) && \(/);
  });
});
