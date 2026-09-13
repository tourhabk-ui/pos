/**
 * Чужих навигаторов на экранах платформы нет (решение владельца 13.09:
 * «кнопка навигация до сих пор открывает сторонние сервисы кринж бро»).
 *
 * Отменяет решение 11.08 («смысл людям пользоваться нашей кривой, если есть
 * другие»). Между ними — решение 28.08 «собираем свой» и свой дорожный граф
 * Камчатки (миграция 760, roadGraphCarProvider): довод 11.08 держался на том,
 * что своего роутера нет, а он появился.
 *
 * ПОЧЕМУ СТОРОЖ, А НЕ ПРОСТО ПРАВКА. 07.09 свой путь на карточку места
 * ДОБАВИЛИ, но чужие ссылки рядом не сняли — и на одной карточке оказалось
 * три навигации, две из них в чужие приложения. Владелец увидел это шесть
 * дней спустя на скрине. Правка без сторожа так и живёт: следующий, кому
 * понадобится «быстро дать дорогу», снова допишет geo:.
 *
 * ЧТО ИМЕННО ЗАПРЕЩЕНО. Не слово «навигатор», а СХЕМЫ ПЕРЕХОДА в чужое
 * приложение: geo:, om://, mapsme://, яндекс-карты, 2gis. Упоминание чужого
 * имени в тексте или комментарии — не переход и не запрещено: половина этих
 * комментариев объясняет, почему ссылки убраны.
 *
 * SOS — ИСКЛЮЧЕНИЕ, И ЭТО НЕ ПОСЛАБЛЕНИЕ. Там geo:-ссылка адресована не
 * туристу, а тому, кто едет его снимать: спасателю, попутчику, оператору 112.
 * У этого человека наша карта не открыта и аккаунта у нас нет — координата
 * обязана лечь в ТО приложение, которое у него уже стоит. Запрет чужих
 * навигаторов защищает наш продукт от увода клиента; на спасательном пути
 * такой цели нет вовсе, а цена ошибки — не «кринж», а время до помощи.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();

/** Схемы перехода в чужое навигационное приложение. */
const HANDOFF = [
  { re: /href=\{?[`'"]geo:/, what: 'geo: (системный выбор приложения)' },
  { re: /href=\{?[`'"]om:\/\//, what: 'om:// (Organic Maps)' },
  { re: /href=\{?[`'"]mapsme:\/\//, what: 'mapsme://' },
  { re: /href=\{?[`'"]https:\/\/yandex\.ru\/maps/, what: 'Яндекс.Карты' },
  { re: /href=\{?[`'"]https:\/\/2gis\.ru/, what: '2ГИС' },
  { re: /`geo:\$\{/, what: 'geo: в шаблонной строке' },
  { re: /`om:\/\/[a-z]+\?/, what: 'om:// в шаблонной строке' },
];

/**
 * Файлы спасательного пути. Список ЯВНЫЙ и короткий: «всё, где встречается
 * слово sos» пропустило бы переименование каталога и тихо разрешило бы
 * чужие ссылки где угодно.
 */
const RESCUE_ALLOWED = new Set([
  'components/safety/SosQrScanner.tsx',
  'app/sos/page.tsx',
  'app/api/safety/sos/route.ts',
]);

/** Все отслеживаемые исходники экранов — списком git, не обходом диска. */
function sourceFiles(): string[] {
  // color.ui=false — соглашение репозитория: у проверяющего может стоять
  // `color.ui=always`, и тогда git подмешал бы ESC-последовательности в имена
  // файлов (урок 16.08, сторож no-ignored-sources).
  const out = execFileSync('git', ['-c', 'color.ui=false', 'ls-files', 'app', 'components', 'lib'], {
    cwd: ROOT, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\n')
    .filter((p) => /\.(ts|tsx)$/.test(p) && !p.includes('.test.'))
    .filter((p) => existsSync(join(ROOT, p)));
}

describe('чужие навигаторы убраны с экранов платформы', () => {
  it('ни одного перехода в чужой навигатор вне спасательного пути', () => {
    const found: string[] = [];
    for (const rel of sourceFiles()) {
      if (RESCUE_ALLOWED.has(rel)) continue;
      const src = readFileSync(join(ROOT, rel), 'utf-8');
      for (const { re, what } of HANDOFF) {
        if (re.test(src)) found.push(`${rel}: ${what}`);
      }
    }
    expect(found, `Переход в чужой навигатор. Дорогу считает свой граф Камчатки (roadGraphCarProvider): на карточке места — PlaceOwnRoute, в поле — «Проложить сюда». Решение владельца 13.09.\n${found.join('\n')}`).toEqual([]);
  });

  it('модуль передачи наружу и марки приложений удалены, а не осиротели', () => {
    // Осиротевший модуль хуже удалённого: он выглядит рабочим механизмом и
    // зовёт им воспользоваться (§«объявленный исход без источника», 10.09).
    for (const p of [
      'lib/navigation/handoff.ts',
      'components/shared/NavigateTo.tsx',
      'public/images/nav/organic-maps.svg',
      'public/images/nav/yandex-maps.svg',
      'public/images/nav/2gis.svg',
      'public/images/nav/maps-me.svg',
    ]) {
      expect(existsSync(join(ROOT, p)), `${p} должен быть удалён`).toBe(false);
    }
  });

  it('спасательный путь чужие ссылки СОХРАНИЛ — их снятие было бы дефектом', () => {
    // Не формальность: правка «убрать чужие навигаторы» естественно тянется
    // и сюда, а здесь она отняла бы у спасателя способ открыть координату.
    const qr = readFileSync(join(ROOT, 'components/safety/SosQrScanner.tsx'), 'utf-8');
    expect(qr).toMatch(/geo:\$\{state\.code\.lat\}/);
    const sos = readFileSync(join(ROOT, 'app/sos/page.tsx'), 'utf-8');
    expect(sos).toContain('geo:');
  });
});

describe('замена на месте: своё вместо чужого', () => {
  it('лист места на карте ведёт на свой расчёт, а не в системный выбор', () => {
    const sheet = readFileSync(join(ROOT, 'components/map/PlaceMapSheet.tsx'), 'utf-8');
    expect(sheet).toContain('const ownRouteUrl = `/places/${initialData.id}?route=1`');
    expect(sheet).toMatch(/<Link href=\{ownRouteUrl\}/);
  });

  it('карточка места принимает ?route=1 и начинает расчёт сама', () => {
    const card = readFileSync(join(ROOT, 'app/places/[id]/_PlaceDetailClient.tsx'), 'utf-8');
    expect(card).toMatch(/get\('route'\) === '1'/);
    expect(card).toMatch(/<PlaceOwnRoute [^>]*autoStart=\{autoRoute\}/);
  });

  it('отказ графа не тупик: называется словами и отдаёт координату', () => {
    // Пока рядом стояли чужие марки, «пути нет» значило «возьми другой
    // навигатор». Их больше нет — значит отказ обязан оставить человека с
    // тем, что работает всегда.
    const own = readFileSync(join(ROOT, 'components/places/PlaceOwnRoute.tsx'), 'utf-8');
    expect(own).toContain('Координаты места:');
    expect(own).toContain('Скопировать координаты');
  });
});
