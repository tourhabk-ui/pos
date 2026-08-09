/**
 * Избранное: один контракт на все поверхности.
 *
 * Владелец 09.08: «избранное так и не работает». Причин было четыре, и все —
 * расхождения между копиями одного знания:
 *   1. четыре карточки витрины слали `{item_type, item_id}` змеиным регистром
 *      и типы `place`/`route`, которых не было в схеме сервера, — 400 на
 *      каждое нажатие, а клиент смотрел только на `res.ok` и 401;
 *   2. панель точки и лист карты писали в `localStorage` и никуда больше —
 *      избранное не доживало до личного кабинета и до второго устройства;
 *   3. личный кабинет вёл тур на `/tours/{id}` — страницы с таким адресом
 *      нет (канон — `/catalog/tours/{id}`), а место открывало общую карту;
 *   4. гостя карточки отправляли на `/auth/signin`, которого не существует.
 *
 * Поэтому тесты стерегут не «работает ли кнопка», а невозможность диалекта:
 * имена полей, список типов и адреса живут в одном модуле, и поверхности
 * обязаны ходить через него.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { WISHLIST_TYPES, WISHLIST_TYPE_LABELS, wishlistHref, isWishlistType } from '@/lib/wishlist/contract';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

/** Все поверхности, где живёт кнопка избранного. */
const SURFACES = [
  'components/routes/PlaceCard.tsx',
  'components/routes/RouteCard.tsx',
  'components/routes/TourCard.tsx',
  'components/routes/RoutePathCard.tsx',
  'components/places/PlaceActionBar.tsx',
  'components/map/PlaceMapSheet.tsx',
];

describe('контракт — единственный источник', () => {
  it('сущности платформы (точка, маршрут, тур) — полноправные типы', () => {
    for (const t of ['tour', 'route', 'place']) {
      expect(WISHLIST_TYPES).toContain(t);
    }
  });

  it('наследство читается: старые записи `destination` не пропадают', () => {
    expect(WISHLIST_TYPES).toContain('destination');
    expect(WISHLIST_TYPE_LABELS.destination).toBe('Место');
    expect(wishlistHref('destination', 'abc')).toBe('/places/abc');
  });

  it('у каждого типа есть подпись — иначе в кабинете видно сырое слово', () => {
    for (const t of WISHLIST_TYPES) {
      expect(WISHLIST_TYPE_LABELS[t], `нет подписи для ${t}`).toBeTruthy();
    }
  });

  it('тур ведёт на канонический адрес, а не на несуществующий /tours/{id}', () => {
    expect(wishlistHref('tour', '6')).toBe('/catalog/tours/6');
    expect(existsSync(join(ROOT, 'app/catalog/tours/[id]'))).toBe(true);
    expect(existsSync(join(ROOT, 'app/tours/[id]'))).toBe(false);
  });

  it('место и маршрут ведут на свои карточки, а не на общую карту', () => {
    expect(wishlistHref('place', 'p1')).toBe('/places/p1');
    expect(wishlistHref('route', 'r1')).toBe('/routes/r1');
    expect(existsSync(join(ROOT, 'app/places/[id]'))).toBe(true);
    expect(existsSync(join(ROOT, 'app/routes/[id]'))).toBe(true);
  });

  it('неизвестный тип не роняет кабинет', () => {
    expect(isWishlistType('чепуха')).toBe(false);
    expect(wishlistHref('чепуха', 'x')).toBe('/catalog');
  });
});

describe('поверхности говорят на одном языке', () => {
  it('ни одна кнопка не ходит к API сама', () => {
    for (const f of SURFACES) {
      expect(read(f), `${f} обращается к API мимо контракта`).not.toMatch(/api\/tourist\/wishlist/);
    }
  });

  it('все кнопки — через общий хук', () => {
    for (const f of SURFACES) {
      expect(read(f), `${f} не использует useWishlist`).toMatch(/useWishlist\(/);
    }
  });

  it('змеиный регистр в теле запроса больше не встречается', () => {
    for (const f of SURFACES) {
      expect(read(f), `${f} шлёт item_type/item_id`).not.toMatch(/item_type:|item_id:/);
    }
    // Тело собирает клиент — и только в верблюжьем регистре, как ждёт Zod.
    const client = read('lib/wishlist/client.ts');
    expect(client).toMatch(/itemType: type, itemId/);
    expect(client).not.toMatch(/item_type:/);
  });

  it('своих хранилищ в localStorage у поверхностей не осталось', () => {
    for (const f of SURFACES) {
      expect(read(f), `${f} держит своё хранилище`).not.toMatch(/wishlist_places/);
    }
  });

  it('гость попадает на существующую страницу входа', () => {
    const hook = read('hooks/use-wishlist.ts');
    expect(hook).toMatch(/\/auth\/login\?from=/);
    expect(existsSync(join(ROOT, 'app/auth/login'))).toBe(true);
    for (const f of SURFACES) {
      expect(read(f), `${f} ведёт гостя на несуществующий signin`).not.toMatch(/auth\/signin/);
    }
  });
});

describe('сервер принимает то же, что шлёт клиент', () => {
  const API = read('app/api/tourist/wishlist/route.ts');

  it('схема запроса берёт типы из контракта, а не свой список', () => {
    expect(API).toMatch(/from '@\/lib\/wishlist\/contract'/);
    expect(API).toMatch(/z\.enum\(WISHLIST_TYPES/);
  });

  it('миграция 845 разрешает точки и маршруты в базе', () => {
    const mig = read('migrations/845_wishlist_item_types.sql');
    for (const t of WISHLIST_TYPES) {
      expect(mig, `тип ${t} не разрешён в БД`).toContain(`'${t}'`);
    }
    // Имя прежнего ограничения неизвестно — таблица старше миграций.
    expect(mig).toMatch(/DROP CONSTRAINT/);
    expect(mig).toMatch(/to_regclass/);
  });
});

describe('кабинет показывает причину, а поверхности — ошибку', () => {
  it('клиент возвращает текст отказа, а не молчит', () => {
    const client = read('lib/wishlist/client.ts');
    expect(client).toMatch(/unauthorized/);
    expect(client).toMatch(/error: data\.error/);
  });

  it('офлайн не теряет отметку: локальное зеркало остаётся', () => {
    const client = read('lib/wishlist/client.ts');
    expect(client).toMatch(/localOnly: true/);
  });
});
