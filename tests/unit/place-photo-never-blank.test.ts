// @vitest-environment node
/**
 * У карточки места не бывает пустого героя.
 *
 * ── Что показал владелец 19.09 ────────────────────────────────────────────
 *
 * Снимок экрана «Вулкан Вилючинский»: вместо фотографии — тёмный прямоугольник
 * в пол-экрана. Слова владельца: «где фото, почему было и куда делось».
 *
 * По коду нашлись ДВА дефекта, и вместе они дают ровно это.
 *
 * 1. СВОИ СНИМКИ ПРОИГРЫВАЛИ ЧУЖИМ ССЫЛКАМ. `photoUrl` выбирался в порядке:
 *    `places.photo_url` → `places.images[0]` → наш собственный снимок. Первые
 *    два поля собраны импортом с посторонних сайтов и живут ровно столько,
 *    сколько захочет их владелец. За два часа до снимка экрана в
 *    `ai_route_images` легли два собственных кадра владельца (миграция 979) —
 *    и карточка их не выбрала, потому что чужая ссылка стояла раньше.
 *
 *    Соседний блок `images` В ТОМ ЖЕ ФАЙЛЕ объявляет обратное правило словами:
 *    «Свои важнее чужих намеренно... здесь фотографии, у которых мы знаем
 *    автора и права». Одно правило, записанное дважды, разошлось.
 *
 * 2. МЁРТВАЯ ССЫЛКА ОСТАВЛЯЛА ДЫРУ. `next/image` на неотдавшийся адрес не
 *    рисует ничего, а запасной градиент стоял в ветке «снимков нет вовсе».
 *    То есть сломанный показ был неотличим от отсутствия фотографии — и хуже:
 *    выглядел как поломка вёрстки.
 *
 * Сторож держит оба правила. Состояние данных он не проверяет — этого из
 * репозитория не видно; он держит ПОРЯДОК ВЫБОРА и НАЛИЧИЕ ЗАПАСНОГО ПУТИ.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const API = readFileSync(join(ROOT, 'app', 'api', 'places', '[id]', 'route.ts'), 'utf-8');
const HERO = readFileSync(join(ROOT, 'components', 'places', 'PlaceHero.tsx'), 'utf-8');

/** Тело функции, собирающей photoUrl. */
function photoUrlBody(): string {
  const at = API.indexOf('photoUrl: (() => {');
  expect(at, 'блок photoUrl не найден — сторож смотрит не туда').toBeGreaterThan(0);
  return API.slice(at, API.indexOf('})(),', at));
}

describe('свой снимок выбирается раньше чужой ссылки', () => {
  it('собственное фото стоит первым в порядке выбора', () => {
    const body = photoUrlBody();
    const own = body.indexOf('photo_count');
    const foreign = body.indexOf('r.photo_url');
    const scraped = body.indexOf('r.images');
    expect(own).toBeGreaterThan(0);
    expect(own, 'places.photo_url — импортированная чужая ссылка, она не может идти раньше').toBeLessThan(foreign);
    expect(own, 'places.images — тоже импорт с посторонних сайтов').toBeLessThan(scraped);
  });

  it('чужие ссылки не выброшены — они остаются запасом', () => {
    const body = photoUrlBody();
    expect(body).toContain('r.photo_url');
    expect(body).toContain('r.images');
  });

  it('герой и галерея следуют одному правилу', () => {
    // Блок `images` объявляет «свои важнее чужих» словами; если герой снова
    // начнёт выбирать иначе, правило разойдётся во второй раз.
    expect(API).toContain('Свои важнее чужих');
  });
});

describe('мёртвая ссылка не оставляет дыру', () => {
  it('каждый кадр героя умеет сообщить о своём отказе', () => {
    const images = HERO.match(/<Image\s[^>]*>/g) ?? [];
    expect(images.length).toBeGreaterThan(0);
    const silent = images.filter(tag => !tag.includes('onError'));
    expect(silent, 'кадр без onError оставит пустой прямоугольник вместо градиента').toEqual([]);
  });

  it('отвалившийся кадр выбывает из галереи', () => {
    expect(HERO).toContain('markBroken');
    expect(HERO).toMatch(/gallery\s*=\s*allSources\.filter\(s => !broken\.has\(s\)\)/);
  });

  it('когда не осталось ни одного кадра — честный градиент, а не пустота', () => {
    expect(HERO).toContain('RouteGradientPlaceholder');
    // Ветка градиента — последняя в цепочке, то есть срабатывает и тогда,
    // когда снимки были, но все отвалились.
    const gradientAt = HERO.indexOf('<RouteGradientPlaceholder');
    const singleAt = HERO.indexOf('gallery.length === 1');
    expect(singleAt).toBeGreaterThan(0);
    expect(gradientAt).toBeGreaterThan(singleAt);
  });

  it('счётчик снимков не подменяется: сколько числим — столько и говорим', () => {
    // `photoCount` приходит из базы и остаётся как есть: скрытый отказ показа
    // не должен переписывать факт о данных.
    expect(HERO).toContain('photoCount');
    expect(HERO).not.toMatch(/setPhotoCount|photoCount\s*=\s*gallery\.length/);
  });
});
