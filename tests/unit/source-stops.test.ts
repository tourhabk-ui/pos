/**
 * Этапы маршрута на странице источника — чтение, а не импорт.
 *
 * Перепись: у 264 маршрутов путь не описан точками. Владелец: «мы просто не
 * забрали эти точки, это ошибка разбора». Основание сильное — связи из
 * источника заводились двумя разовыми проходами по тридцати страницам, а сам
 * разбор страницы этапы не ищет вовсе.
 *
 * Но брать все ссылки подряд НЕЛЬЗЯ: ровно так сделана миграция 167, и
 * последствия — краевой музей среди этапов подъёма на вулкан. Ссылка в списке
 * этапов и ссылка в блоке «рядом» в HTML выглядят одинаково, отличает их
 * окружение. Поэтому модуль возвращает признаки, а не вердикт.
 */
import { describe, it, expect } from 'vitest';
import { extractStopLinks, looksLikeStopList } from '@/lib/routes/source-stops';

const stopList = `
  <h2>Точки маршрута</h2>
  <ol>
    <li><a href="/kam/places/1465">Халактырский пляж</a></li>
    <li><a href="/kam/places/1477">Авачинский перевал</a></li>
    <li><a href="/kam/places/1480">Экструзия Верблюд</a></li>
  </ol>
`;

const nearbyBlock = `
  <h2>Рядом интересное</h2>
  <div>
    <a href="/kam/places/2542">Музей лосося</a>
    <a href="/kam/places/2620">Вулканариум</a>
  </div>
`;

describe('ссылки на места со страницы маршрута', () => {
  it('этапы читаются вместе с подписями', () => {
    const links = extractStopLinks(stopList);
    expect(links).toHaveLength(3);
    expect(links.map(l => l.id)).toEqual(['1465', '1477', '1480']);
    expect(links[0].text).toBe('Халактырский пляж');
    expect(links.every(l => l.routeContext)).toBe(true);
  });

  it('блок «рядом» помечается как улика против этапа', () => {
    const links = extractStopLinks(nearbyBlock);
    expect(links.every(l => l.nearbyContext)).toBe(true);
    expect(looksLikeStopList(links), 'блок «рядом» принят за список этапов').toBe(false);
  });

  it('сама страница в свои этапы не попадает', () => {
    const html = `<a href="/kam/places/1461">эта же страница</a>${stopList}`;
    const links = extractStopLinks(html, '1461');
    expect(links.map(l => l.id)).not.toContain('1461');
  });

  it('одна ссылка списком этапов не считается', () => {
    // Чаще всего это сам объект или соседняя достопримечательность.
    const html = '<p>Маршрут проходит мимо <a href="/kam/places/999">Верблюда</a></p>';
    expect(looksLikeStopList(extractStopLinks(html))).toBe(false);
  });

  it('экранированные слэши в JSON-теле тоже читаются', () => {
    // Страница отдаёт часть разметки внутри JSON, где «/» экранирован.
    const html = '{"list":"<a href=\\"\\/kam\\/places\\/1519\\">Точка маршрута</a>"}';
    expect(extractStopLinks(html).map(l => l.id)).toContain('1519');
  });

  it('повтор одной ссылки не удваивает счёт', () => {
    // Ссылка встречается и в списке, и в скрипте карты.
    const html = stopList + '<script>var pts=["/kam/places/1465"]</script>';
    expect(extractStopLinks(html)).toHaveLength(3);
  });

  it('страница со списком этапов отличается от страницы без него', () => {
    expect(looksLikeStopList(extractStopLinks(stopList))).toBe(true);
    expect(looksLikeStopList(extractStopLinks(nearbyBlock))).toBe(false);
  });
});
