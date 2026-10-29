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
import { orderPlates, PLATES_LIMIT, HOME_PLATES_ORDER_NOTE } from '@/lib/home/plate-facts';
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
    // С 29.10 (правило 1в) — сама ближайшая свободная дата: по ней порядок,
    // «даты есть» выводится из неё. Тот же фрагмент, на котором стоит
    // hasAvailabilitySql каталога.
    expect(plates).toContain("${nearestFreeDateSql('ot')} AS nearest_free_date");
    expect(plates).toMatch(/has_availability: r\.nearest_free_date != null/);
    // Живой тур — шлюз витрины publicTourSql; второй канон того же правила
    // (LIVE_TOUR_CONDITIONS) снят находкой аудита 15.10 P1-04.
    expect(plates).toContain("${publicTourSql('ot')}");
    expect(data, 'главная считает свободные даты сама').not.toContain('FROM tour_availability');
    expect(data, 'главная считает занятость сама').not.toMatch(/occupiedOnDaySql\(/);
    expect(plates, 'свой список условий живого тура').not.toMatch(/is_published\s*=\s*true/);
    expect(data).toMatch(/import \{[^}]*nearestFreeDateSql[^}]*\} from '@\/lib\/tours\/nearest-free-date'/);
  });

  it('каталог сам зовёт тот же фрагмент — условие одно на обе витрины', async () => {
    // Иначе экспорт мог бы жить рядом со своей копией в листинге каталога, и
    // «одно условие» снова стало бы двумя.
    const search = readFileSync(join(process.cwd(), 'lib/search/tour-search.ts'), 'utf-8');
    // Каталог берёт сам фрагмент ближайшей даты (ключ порядка, 29.10), а
    // «даты есть» выводит из него — то же условие, что hasAvailabilitySql.
    expect(search).toMatch(/\$\{nearestFreeDateSql\('ot'\)\} AS nearest_free_date/);
    // С 29.10 (правило 1в) и сам фрагмент — не своя копия: «даты есть» значит
    // «есть ближайшая свободная дата» (lib/tours/nearest-free-date), та же,
    // по которой строится порядок витрин. Своего FROM tour_availability в
    // каталоге нет вовсе.
    expect(search, 'каталог считает свободные даты сам').not.toContain('FROM tour_availability');
    const { hasAvailabilitySql } = await import('@/lib/search/tour-search');
    const { nearestFreeDateSql } = await import('@/lib/tours/nearest-free-date');
    expect(hasAvailabilitySql()).toBe(`(${nearestFreeDateSql('ot')} IS NOT NULL)`);
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
    expect(plates).toMatch(/return orderPlates\(plates\);/);
  });
});

describe('orderPlates: витрина главной — правило 1в, только туры со снимком (29.10)', () => {
  type P = {
    id: string; availability: CatalogAvailability; imageUrl: string | null;
    partnerId: string | null; operatorName: string | null; nearestFreeDate: string | null;
  };
  const DAY = '2026-10-29';
  const t = (id: string, availability: CatalogAvailability, partnerId: string | null, extra: Partial<P> = {}): P => ({
    id, availability, partnerId, operatorName: partnerId ? `Компания ${partnerId}` : null,
    imageUrl: `tours/${id}.jpg`, nearestFreeDate: availability === 'dates' ? '2026-11-10' : null, ...extra,
  });

  it('тур без снимка на главную не попадает при любом сезоне; тур со снимком той же компании — попадает', () => {
    const out = orderPlates([
      t('n1', 'dates', 'A', { imageUrl: null }),
      t('n2', 'on_request', 'A', { imageUrl: '  ' }),
      t('n3', 'season_over', 'A', { imageUrl: null }),
      t('y1', 'on_request', 'A'),
    ], { day: DAY });
    expect(out.map((p) => p.id)).toEqual(['y1']);
  });

  it('33 тура одной компании и 1 другой — в восьми плитках обе компании', () => {
    const input = [
      ...Array.from({ length: 33 }, (_, i) => t(`a${i}`, 'on_request', 'A')),
      t('b0', 'on_request', 'B'),
    ];
    for (const day of ['2026-10-29', '2026-10-30', '2026-11-01', '2026-12-31']) {
      const out = orderPlates(input, { day });
      expect(PLATES_LIMIT).toBe(8);
      expect(out).toHaveLength(8);
      expect(out.map((p) => p.id), day).toContain('b0');
      expect(out.slice(0, 2).map((p) => p.partnerId).sort()).toEqual(['A', 'B']);
    }
  });

  it('сезон кончился — после всех открытых, даже при круге компаний', () => {
    const out = orderPlates([
      t('s0', 'season_over', 'A'), t('a0', 'dates', 'A'), t('b0', 'on_request', 'B'), t('a1', 'on_request', 'A'),
    ], { day: DAY });
    expect(out.map((p) => p.id).slice(-1)).toEqual(['s0']);
    expect(out.map((p) => p.id).slice(0, 3).sort()).toEqual(['a0', 'a1', 'b0']);
  });

  it('компания с ближайшей свободной датой — первой; внутри компании — тур с датой раньше', () => {
    const out = orderPlates([
      t('b0', 'on_request', 'B'),
      t('a1', 'dates', 'A', { nearestFreeDate: '2026-12-01' }),
      t('c0', 'dates', 'C', { nearestFreeDate: '2026-11-05' }),
      t('a0', 'dates', 'A', { nearestFreeDate: '2026-11-20' }),
    ], { day: DAY });
    expect(out.map((p) => p.id)).toEqual(['c0', 'a0', 'b0', 'a1']);
  });

  it('новизна и порядок выборки не влияют: перестановка входа — тот же итог; жребий воспроизводим', () => {
    const input = [
      ...Array.from({ length: 6 }, (_, i) => t(`a${i}`, 'on_request', 'A')),
      ...Array.from({ length: 6 }, (_, i) => t(`b${i}`, 'on_request', 'B')),
      ...Array.from({ length: 6 }, (_, i) => t(`c${i}`, 'on_request', 'C')),
    ];
    const a = orderPlates(input, { day: DAY }).map((p) => p.id);
    const b = orderPlates([...input].reverse(), { day: DAY }).map((p) => p.id);
    expect(b).toEqual(a);
    expect(orderPlates(input, { day: DAY }).map((p) => p.id)).toEqual(a);
  });

  it('тур без компании — сам себе очередь, а не «одна компания на всех»', () => {
    const out = orderPlates([t('x', 'on_request', null), t('y', 'on_request', null), t('a0', 'on_request', 'A'), t('a1', 'on_request', 'A')], { day: DAY });
    expect(out.slice(0, 3).map((p) => p.id).sort()).toEqual(['a0', 'x', 'y']);
  });

  it('подпись называет правило, допуск по снимку и кончается «Место в списке не продаётся.»', () => {
    expect(HOME_PLATES_ORDER_NOTE).toMatch(/туры со снимками; все туры — в каталоге/);
    expect(HOME_PLATES_ORDER_NOTE).toMatch(/Место в списке не продаётся\.$/);
  });

  it('не мутирует вход', () => {
    const input = [t('a', 'season_over', 'A'), t('b', 'dates', 'B')];
    orderPlates(input, { day: DAY });
    expect(input.map((p) => p.id)).toEqual(['a', 'b']);
  });
});
