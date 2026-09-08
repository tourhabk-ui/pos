/**
 * Карточка маршрута: подъезд к старту — свой расчёт, не чужая карта.
 *
 * Владелец 08.09: «на примере места открываются сторонние карты, но не
 * наша — кринж, убери их отсюда, оставь нашу». До этой правки блок
 * «Навигация» карточки маршрута (оба вида — десктопный и компактный) вёл на
 * Organic Maps (`omaps://`) и Яндекс.Карты (`yandex.ru/maps`) — оба
 * решением владельца 11.08 («чужой навигатор строит дорогу лучше нас»),
 * которое здесь прямо отменяется: свой роутер (roadGraphCarProvider) уже
 * подключён и посчитан, тем же компонентом, что стоит на карточке места
 * (PlaceOwnRoute). GPX остаётся — это НАШ экспорт, не чужая карта.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLIENT = readFileSync(join(process.cwd(), 'app/routes/[id]/_RouteDetailClient.tsx'), 'utf-8');

describe('_RouteDetailClient — своя навигация вместо сторонних карт', () => {
  it('Organic Maps (omaps://) и Яндекс.Карты нигде на карточке маршрута не упоминаются', () => {
    expect(CLIENT).not.toContain('omaps://');
    expect(CLIENT).not.toContain('yandex.ru/maps');
    expect(CLIENT).not.toContain('Organic Maps');
    expect(CLIENT).not.toContain('O.Maps');
    expect(CLIENT).not.toContain('Доехать до старта');
  });

  it('PlaceOwnRoute подключён динамически, тем же способом, что на карточке места', () => {
    expect(CLIENT).toMatch(/import\('@\/components\/places\/PlaceOwnRoute'\)/);
  });

  it('оба вида блока «Навигация» (десктопный и компактный) зовут PlaceOwnRoute с точкой старта трека', () => {
    const occurrences = [...CLIENT.matchAll(/<PlaceOwnRoute lat=\{trackCoords!\[0\]\[0\]\} lng=\{trackCoords!\[0\]\[1\]\} name="Старт маршрута" \/>/g)];
    expect(occurrences.length).toBe(2);
  });

  it('GPX остаётся — это наш экспорт, не чужая карта', () => {
    const gpxOccurrences = [...CLIENT.matchAll(/href=\{`\/api\/routes\/\$\{route\.id\}\/export\?format=gpx`\}/g)];
    expect(gpxOccurrences.length).toBeGreaterThanOrEqual(2);
  });
});
