/**
 * PlaceOwnRoute подключён на карточке места сразу после PlaceActionBar —
 * не в конце страницы. Владелец 07.09: до этой правки НИ ОДНА кнопка
 * навигации на карточке не вела на платформу (обе — внешние навигаторы,
 * PlaceActionBar/MobileBottomBar), и человек не видел свой расчёт, не
 * прокрутив весь экран.
 *
 * 13.09 внешние навигаторы с карточки сняты совсем (владелец: «кнопка
 * навигация до сих пор открывает сторонние сервисы»), и этот блок стал
 * единственным расчётом дороги — плюс autoStart для прихода с карты
 * (?route=1). Сторож охвата — no-external-navigators.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLIENT = readFileSync(join(process.cwd(), 'app/places/[id]/_PlaceDetailClient.tsx'), 'utf-8');

describe('_PlaceDetailClient — PlaceOwnRoute подключён рядом с шапкой', () => {
  it('импортирован динамически, как остальные секции карточки', () => {
    expect(CLIENT).toMatch(/import\('@\/components\/places\/PlaceOwnRoute'\)/);
  });

  it('стоит СРАЗУ после PlaceActionBar, до блока с фото-кэшем', () => {
    const actionBarAt = CLIENT.indexOf('<PlaceActionBar');
    const ownRouteAt = CLIENT.indexOf('<PlaceOwnRoute', actionBarAt);
    const cacheNoticeAt = CLIENT.indexOf('fromCache &&', actionBarAt);
    expect(actionBarAt).toBeGreaterThan(-1);
    expect(ownRouteAt).toBeGreaterThan(actionBarAt);
    expect(cacheNoticeAt).toBeGreaterThan(ownRouteAt);
  });

  it('получает координаты и имя места', () => {
    expect(CLIENT).toMatch(/<PlaceOwnRoute lat=\{place\.lat\} lng=\{place\.lng\} name=\{place\.name\}/);
  });
});
