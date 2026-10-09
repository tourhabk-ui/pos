/**
 * Главная «Подходит вам сейчас» показывает РЕАЛЬНЫЕ туры операторов, а не
 * места/маршруты. Прежде тянули из agent_route_knowledge (места+маршруты, туров
 * там нет) и добивали маршрутами — на телефоне коммерция была спрятана. Теперь
 * источник — operator_tours (только опубликованные, фото-first), честная пустота
 * без мест-заглушек.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { orderPlates, PLATES_LIMIT } from '@/lib/home/plate-facts';
import type { CatalogAvailability } from '@/lib/tours/catalog-availability';

const data = readFileSync(join(process.cwd(), 'app/_home/data.ts'), 'utf-8');
const plates = data.slice(data.indexOf('async function fetchPlates'), data.indexOf('export const EXPLORE_LIMIT'));

describe('главная: платы = туры операторов', () => {
  it('fetchPlates берёт из operator_tours, а не из каталога мест/маршрутов', () => {
    expect(plates).toContain('FROM operator_tours');
    expect(plates).toContain("kind: 'tour'");
  });

  it('«живой тур» и «даты есть» — фрагменты каталога, а не копии', () => {
    // Ревью 24.09: fetchPlates держал ручную копию EXISTS по tour_availability
    // из lib/search/tour-search. Поправь условие в каталоге — и главная стала бы
    // по-другому решать «даты есть / по запросу» для того же тура (#1780).
    // Прежняя проверка `toContain('is_published = true')` требовала именно
    // своей копии условия — снята, вместо неё требуется общий фрагмент.
    expect(plates).toContain('${hasAvailabilitySql()}');
    expect(plates).toContain("${LIVE_TOUR_CONDITIONS.join(' AND ')}");
    expect(data, 'главная считает свободные даты сама').not.toContain('FROM tour_availability');
    expect(data, 'главная считает занятость сама').not.toMatch(/occupiedOnDaySql\(/);
    expect(plates, 'свой список условий живого тура').not.toMatch(/is_published\s*=\s*true/);
    expect(data).toMatch(/import \{[^}]*hasAvailabilitySql[^}]*\} from '@\/lib\/search\/tour-search'/);
  });

  it('каталог сам зовёт тот же фрагмент — условие одно на обе витрины', () => {
    // Иначе экспорт мог бы жить рядом со своей копией в листинге каталога, и
    // «одно условие» снова стало бы двумя.
    const search = readFileSync(join(process.cwd(), 'lib/search/tour-search.ts'), 'utf-8');
    expect(search).toMatch(/\$\{hasAvailabilitySql\(\)\} as has_availability/);
    expect(search.match(/FROM tour_availability/g) ?? []).toHaveLength(1);
  });
  it('не добивает витрину маршрутами (queryCatalog в турах убран)', () => {
    // С 25.09 queryCatalog в data.ts есть — им «Исследовать» берёт МЕСТА
    // (fetchExplore). Запрет держится там, где он имеет смысл: в витрине туров.
    expect(plates).not.toContain('queryCatalog');
    expect(plates).not.toMatch(/kind: 'route'/);
  });
  it('«Исследовать» — места, и только места: туры туда не возвращаются', () => {
    const at = data.indexOf('export async function fetchExplore');
    const explore = data.slice(at, data.indexOf('\n}\n', at));
    expect(at).toBeGreaterThan(-1);
    expect(explore).toMatch(/queryCatalog\(\{ kind: 'place'/);
    expect(explore).not.toMatch(/operator_tours|kind: 'tour'|kind: 'route'/);
    // Отказ не молчит: «мест нет» и «запрос упал» различимы в логе (§4.0).
    expect(explore).toMatch(/console\.error\('\[home\] fetchExplore не выполнен'/);
  });
  it('честная пустота: нет туров → пустой массив, но отказ не молчит', () => {
    // До 24.09 здесь требовался ровно `catch { return []; }` — то есть сторож
    // закреплял глушение: «туров нет» и «запрос упал» были неотличимы (§4.0).
    // Пустой массив остаётся (блок не рисуется), но отказ пишется в лог.
    expect(plates).toMatch(/catch\s*\(err\)\s*\{[\s\S]*?console\.error\([\s\S]*?return \[\];\s*\}/);
    expect(plates).not.toMatch(/catch\s*\{\s*return \[\];\s*\}/);
  });

  it('карточка знает оператора, длительность, единицу цены и условия отмены', () => {
    // Аудит 24.09 (#39/#122): «тур оператора» вместо имени и цена без «/чел.».
    expect(plates).toMatch(/p\.name AS operator_name/);
    for (const col of ['ot.price_unit', 'ot.duration_hours', 'ot.multi_day_count', 'ot.cancellation_policy']) {
      expect(plates, `${col} не выбирается`).toContain(col);
    }
  });

  it('тур с кончившимся сезоном не прячется, а уходит в конец — правилом каталога', () => {
    // Своей копии порогов сезона здесь быть не должно — только catalogAvailability.
    expect(plates).toContain('catalogAvailability(');
    expect(plates, 'закрытый сезон отсекается в SQL — тур пропал бы с витрины').not.toMatch(/season_end\s*>=\s*CURRENT_DATE/);
    // Первая редакция сторожа искала только слово AVAILABILITY_RANK и зеленела
    // с удалённой сортировкой (мутация ревью 24.09). Порядок теперь — чистая
    // orderPlates, её поведение проверяется ниже; здесь — что витрина её зовёт
    // на результате выборки, а не возвращает строки в порядке SQL.
    // порядок и потолок — orderPlates; трансфер (09.10) встаёт после него и потолка не растит
    expect(plates).toMatch(/return withTransferPlate\(orderPlates\(plates\), await fetchTransferPlate\(\)\);/);
  });
});

describe('orderPlates: порядок витрины главной', () => {
  type P = { id: string; availability: CatalogAvailability };
  const t = (id: string, availability: CatalogAvailability): P => ({ id, availability });

  it('даты → по запросу → сезон кончился', () => {
    const out = orderPlates([t('a', 'season_over'), t('b', 'dates'), t('c', 'on_request')]);
    expect(out.map((p) => p.id)).toEqual(['b', 'c', 'a']);
  });

  it('внутри группы сохраняется порядок выборки (фото, свежесть)', () => {
    const out = orderPlates([
      t('s1', 'season_over'), t('d1', 'dates'), t('r1', 'on_request'),
      t('d2', 'dates'), t('s2', 'season_over'), t('r2', 'on_request'), t('d3', 'dates'),
    ]);
    expect(out.map((p) => p.id)).toEqual(['d1', 'd2', 'd3', 'r1', 'r2', 's1', 's2']);
  });

  it('не больше восьми карточек, и закрытый сезон не вытесняет открытые', () => {
    const input = [
      ...Array.from({ length: 5 }, (_, i) => t(`s${i}`, 'season_over')),
      ...Array.from({ length: 8 }, (_, i) => t(`d${i}`, 'dates')),
    ];
    const out = orderPlates(input);
    expect(PLATES_LIMIT).toBe(8);
    expect(out).toHaveLength(8);
    expect(out.every((p) => p.availability === 'dates')).toBe(true);
  });

  it('один оператор не забирает витрину: операторы идут по очереди (08.10)', () => {
    // Прод 08.10: девять туров рыбалки с датами, одиннадцать «Края Вулканов»
    // по запросу, один рафтинг — строгое «даты сначала» отдавало рыбалке все восемь мест.
    type Q = P & { operatorName: string | null };
    const q = (id: string, availability: CatalogAvailability, operatorName: string | null): Q => ({ id, availability, operatorName });
    const input = [
      ...Array.from({ length: 11 }, (_, i) => q(`v${i}`, 'on_request', 'Край Вулканов')),
      ...Array.from({ length: 9 }, (_, i) => q(`f${i}`, 'dates', 'Камчатская рыбалка')),
      q('r0', 'on_request', 'Семейный Рафтинг'),
    ];
    const out = orderPlates(input);
    expect(out).toHaveLength(8);
    // Оператор с датами впереди круга, внутри оператора — прежний порядок.
    expect(out.map((p) => p.id)).toEqual(['f0', 'v0', 'r0', 'f1', 'v1', 'f2', 'v2', 'f3']);
    const per = new Map<string | null, number>();
    for (const p of out) per.set(p.operatorName, (per.get(p.operatorName) ?? 0) + 1);
    expect(per.get('Камчатская рыбалка')).toBeLessThan(8);
    expect(per.get('Край Вулканов')).toBeGreaterThan(0);
  });

  it('закрытый сезон по-прежнему после всех открытых, даже при круге операторов', () => {
    type Q = P & { operatorName: string | null };
    const q = (id: string, availability: CatalogAvailability, operatorName: string | null): Q => ({ id, availability, operatorName });
    const out = orderPlates([q('s0', 'season_over', 'A'), q('a0', 'dates', 'A'), q('b0', 'on_request', 'B'), q('a1', 'on_request', 'A')]);
    expect(out.map((p) => p.id)).toEqual(['a0', 'b0', 'a1', 's0']);
  });

  it('не мутирует вход', () => {
    const input = [t('a', 'season_over'), t('b', 'dates')];
    orderPlates(input);
    expect(input.map((p) => p.id)).toEqual(['a', 'b']);
  });
});
