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

describe('отказ по роли называется одним текстом на всех экранах (09.10)', () => {
  // Скрин владельца: сердечко на карточке тура в каталоге — «Не удалось
  // сохранить». Ответ сервера был 403: Edge пускает на /api/tourist/* только
  // аккаунт с ролью tourist, а сердечко нажимается у всех. Один исход доходил
  // до человека тремя способами — общим «не удалось», английским «Forbidden»
  // и молчаливым откатом. Теперь у него один текст.
  it('403 → один текст про аккаунт, остальное → прежнее «попробуйте ещё раз»', async () => {
    const { wishlistFailureText, WISHLIST_FORBIDDEN_TEXT, WISHLIST_FAILED_TEXT } = await import('@/lib/wishlist/contract');
    expect(wishlistFailureText(403)).toBe(WISHLIST_FORBIDDEN_TEXT);
    expect(WISHLIST_FORBIDDEN_TEXT).toMatch(/недоступно для этого аккаунта/);
    for (const s of [500, 404, 429, null]) expect(wishlistFailureText(s)).toBe(WISHLIST_FAILED_TEXT);
  });

  it('правило роли на Edge — то самое, ради которого текст заведён', () => {
    expect(read('middleware.ts')).toMatch(/'\/api\/tourist': 'tourist'/);
  });

  it('каталог, карточка тура, каталог жилья и общий клиент берут текст из контракта', () => {
    for (const f of [
      'components/marketplace/MarketplaceClient.tsx',
      'app/catalog/tours/[id]/_TourDetailClient.tsx',
      'app/accommodations/_AccommodationsClient.tsx',
      'lib/wishlist/client.ts',
    ]) {
      expect(read(f), `${f}: нет текста отказа из контракта`).toMatch(/wishlistFailureText/);
    }
  });

  it('карточка тура не показывает слово «Forbidden»: на 403 свой текст раньше разбора тела', () => {
    const src = read('app/catalog/tours/[id]/_TourDetailClient.tsx');
    const i403 = src.indexOf('res.status === 403');
    const iBody = src.indexOf("const data = await res.json().catch(() => ({})) as { success?: boolean; error?: string };", i403 - 400);
    expect(i403).toBeGreaterThan(0);
    expect(i403).toBeLessThan(iBody);
  });

  it('каталог жилья: сердце откатывается, но человек читает причину', () => {
    const src = read('app/accommodations/_AccommodationsClient.tsx');
    expect(src).toMatch(/setFavNotice\(wishlistFailureText\(res\?\.status \?\? null\)\)/);
    expect(src).toMatch(/\{favNotice && \(/);
  });
});

describe('избранное видно любой вошедшей роли (09.10)', () => {
  // Сохранять мог любой, видеть — только турист: список жил в кабинете с
  // ролью tourist. Общая страница /wishlist — тот же экран без оболочки.
  it('/wishlist открыта всем ролям аккаунта и рендерит тот же экран', () => {
    const page = read('app/wishlist/page.tsx');
    expect(page).toMatch(/<WishlistClient anyRole \/>/);
    expect(page).toMatch(/robots: 'noindex, nofollow'/);
    const client = read('app/hub/tourist/wishlist/_WishlistClient.tsx');
    expect(client).toMatch(/roles=\{anyRole \? ANY_ROLE : \['tourist', 'admin'\]\}/);
    for (const r of ['tourist', 'operator', 'guide', 'agent', 'stay', 'gear', 'admin']) {
      expect(client, `роль ${r} не допущена на /wishlist`).toContain(`'${r}'`);
    }
  });

  it('кабинет туриста остаётся за ролью: общая страница его не заменяет', () => {
    expect(read('app/hub/tourist/layout.tsx')).toMatch(/requiredRole="tourist"/);
  });

  it('путь к избранному есть в общем меню (реестр ссылок → /menu и футер)', () => {
    expect(read('lib/navigation/platform-links.ts')).toMatch(/label: 'Избранное',\s+href: '\/wishlist'/);
  });
});
