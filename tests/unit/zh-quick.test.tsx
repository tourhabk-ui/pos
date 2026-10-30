/**
 * /zh — общая витрина по правилу §0 и язык раздела (аудит 15.10, CN-quick;
 * карт-бланш владельца 15.10).
 *
 * До этого дня туры на /zh шли по updated_at DESC — выше стоял тот, кто чаще
 * правит тур, и правило порядка нигде не было названо; список резался на 40,
 * а заголовок писал число показанных как общее; страница отдавалась под
 * <html lang="ru"> без единого сигнала языка в <head>; обходчик, читающий
 * китайскую страницу, не считался ничем.
 *
 * С 29.10 порядок — правило 1в (слово владельца «1в 2б 3 да»,
 * lib/tours/offer-order), одно на все общие витрины туров: со свободной датой
 * — по ближайшему выезду, остальные — жребий дня. Алфавит компаний (15.10)
 * ставил одних и тех же впереди навсегда.
 *
 * Судится тем, что видит человек и обходчик: рендер страницы с данными базы
 * (порядок в документе, подпись правила, число без среза, имя компании
 * ссылкой), запись счётчика по семейству и её отсутствие для человека, рендер
 * документа с layout раздела (meta Content-Language в <head>).
 */
import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, screen, within } from '@testing-library/react';

// Курс ЦБ (≈ ¥ у цены) — без сети: страница ждала бы настоящий cbr.ru.
vi.mock('@/lib/currency/cbr-rate', async (orig) => ({ ...(await orig<typeof import('@/lib/currency/cbr-rate')>()), loadCnyRate: async () => null }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
const reqHeaders = vi.hoisted(() => ({ ua: '' }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'user-agent': reqHeaders.ua }) }));

import { pool } from '@/lib/db-pool';
import ZhEntryPage from '@/app/zh/page';
import ZhLayout from '@/app/zh/layout';
import { ZhTourList } from '@/components/zh/ZhTourList';
import { orderZhTours, type ZhTourRow } from '@/lib/zh/entry';
import { ZH_TOURS_ORDER_NOTE } from '@/lib/operators/order-note';
import { offerOrderDay, tourLot, OFFER_ORDER_NOTE } from '@/lib/tours/offer-order';
import { nearestFreeDateSql } from '@/lib/tours/nearest-free-date';
import { ZH_PAGE } from '@/lib/mcp/zh-layer';
import { ZH_CONTENT_LANGUAGE } from '@/lib/zh/pages';

const query = vi.mocked(pool.query);
const BAIDU = 'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)';
const HUMAN = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const tour = (id: number, operator: string, title: string, extra: Partial<ZhTourRow> = {}): ZhTourRow => ({
  id: String(id), slug: null, title, base_price: '10000', price_unit: 'per_person', duration_hours: '8',
  operator_name: operator, operator_slug: null, operator_public: null, ...extra,
});

/** 45 туров — больше прежнего среза в 40; порядок из базы — «кто правил последним». */
function storefront(): ZhTourRow[] {
  const ops = ['Шатун', 'Местечко Камчатка', 'Край Вулканов', 'Аэротур'];
  const rows: ZhTourRow[] = [];
  for (let i = 0; i < 45; i++) {
    rows.push(tour(1000 - i, ops[i % ops.length], `Тур ${String.fromCharCode(1040 + ((i * 7) % 26))} ${i}`));
  }
  rows.push(tour(5, 'Местечко Камчатка', 'Долина гейзеров', { operator_slug: 'mestechko', operator_public: true }));
  // Три тура со свободной датой — в глубине выдачи базы, у разных компаний.
  rows[30] = { ...rows[30], nearest_free_date: '2027-07-26' };
  rows[12] = { ...rows[12], nearest_free_date: '2026-12-05' };
  rows[41] = { ...rows[41], nearest_free_date: '2027-02-14' };
  return rows;
}

let tourRows: ZhTourRow[] = [];

beforeEach(() => {
  reqHeaders.ua = BAIDU;
  tourRows = storefront();
  query.mockReset();
  query.mockImplementation((async (sql: string) => (String(sql).includes('FROM operator_tours') ? { rows: tourRows } : { rows: [] })) as never);
});
afterEach(cleanup);

/** Порядок, который человек видит в документе: id туров сверху вниз. */
const shownIds = (root: HTMLElement) => [...root.querySelectorAll('[data-zh-tour]')].map((el) => el.getAttribute('data-zh-tour'));

async function renderTours(): Promise<HTMLElement> {
  render(await ZhEntryPage());
  return screen.getByRole('heading', { level: 2, name: /当前团队游/ }).closest('section') as HTMLElement;
}

describe('/zh: один порядок для всех, названный на странице (§0)', () => {
  it('правило 1в: со свободной датой — по ближайшему выезду, остальные — жребий дня; дата правки порядок не меняет', async () => {
    const section = await renderTours();
    const day = offerOrderDay();
    const shown = shownIds(section);
    expect(shown).toEqual(orderZhTours(tourRows, { day }).map((t) => t.id));
    // Сверху — три тура с датой, раньше дата — выше.
    expect(shown.slice(0, 3)).toEqual([tourRows[12].id, tourRows[41].id, tourRows[30].id]);
    // Остальные — по жребию дня (FNV-1a с fmix32 от даты по Камчатке и id), не по алфавиту.
    const rest = tourRows.filter((t) => !t.nearest_free_date).map((t) => t.id)
      .sort((a, b) => tourLot(day, a) - tourLot(day, b));
    expect(shown.slice(3)).toEqual(rest);
    // Свежая правка (первая строка базы) не поднимает тур наверх.
    expect(shown[0]).not.toBe(tourRows[0].id);
  });

  it('правило порядка названо по-китайски одной строкой из общего источника, место не продаётся', async () => {
    const section = await renderTours();
    expect(within(section).getByText(ZH_TOURS_ORDER_NOTE)).toBeTruthy();
    expect(ZH_TOURS_ORDER_NOTE).toBe(OFFER_ORDER_NOTE.zh);
    expect(ZH_TOURS_ORDER_NOTE).toMatch(/最近出发/);
    expect(ZH_TOURS_ORDER_NOTE).toMatch(/不出售/);
    expect(ZH_TOURS_ORDER_NOTE).not.toMatch(/旅行社名称/);
  });

  it('число в заголовке — все туры витрины, без среза на 40; запрос не режет и не сортирует по дате правки', async () => {
    const section = await renderTours();
    expect(tourRows.length).toBeGreaterThan(40);
    expect(within(section).getByRole('heading', { level: 2 }).textContent).toBe(`当前团队游（${tourRows.length}）`);
    expect(shownIds(section)).toHaveLength(tourRows.length);
    const sql = String(query.mock.calls.find(([s]) => String(s).includes('FROM operator_tours'))?.[0]);
    // LIMIT 1 внутри подзапроса ближайшей даты — это выбор одной даты тура, не срез витрины.
    expect(sql).toContain(nearestFreeDateSql('ot'));
    expect(sql.replace(nearestFreeDateSql('ot'), '')).not.toMatch(/\bLIMIT\b/i);
    expect(sql.replace(nearestFreeDateSql('ot'), '')).not.toMatch(/\bORDER BY\b/i);
    expect(sql).not.toMatch(/updated_at/);
  });

  it('компания рядом с туром — ссылкой на её страницу, если страница открыта; иначе текстом', async () => {
    const section = await renderTours();
    const li = section.querySelector('[data-zh-tour="5"]') as HTMLElement;
    expect(within(li).getByRole('link', { name: 'Местечко Камчатка' }).getAttribute('href')).toBe('/operators/mestechko');
    const closed = section.querySelector(`[data-zh-tour="${tourRows[0].id}"]`) as HTMLElement;
    expect(within(closed).queryByRole('link', { name: tourRows[0].operator_name })).toBeNull();
  });

  it('отказ базы и пустая витрина — разные слова, подписи порядка без списка нет', () => {
    const failed = render(<ZhTourList tours={null} />);
    expect(failed.container.textContent).toContain(ZH_PAGE.catalogUnavailable);
    expect(failed.container.textContent).not.toContain(ZH_TOURS_ORDER_NOTE);
    cleanup();
    const empty = render(<ZhTourList tours={[]} />);
    expect(empty.container.textContent).toContain(ZH_PAGE.catalogEmpty);
    expect(ZH_PAGE.catalogUnavailable).not.toBe(ZH_PAGE.catalogEmpty);
  });

  it('порядок не зависит от имён и от порядка строк базы: те же id — то же место', () => {
    const day = '2026-10-29';
    const a = tour(2, 'Шатун', 'Вахтовка'), b = tour(1, 'Аэротур', 'Авача');
    const renamed = [tour(2, 'Аааа', 'Аааа'), tour(1, 'Яяяя', 'Яяяя')];
    const ids = orderZhTours([a, b], { day }).map((t) => t.id);
    expect(orderZhTours([b, a], { day }).map((t) => t.id)).toEqual(ids);
    expect(orderZhTours(renamed, { day }).map((t) => t.id)).toEqual(ids);
  });
});

describe('/zh: перепись краулеров', () => {
  const entryHits = () => query.mock.calls
    .filter(([sql]) => String(sql).includes('INSERT INTO agent_entry_hits'))
    .map(([, params]) => params as unknown[]);

  it('обходчик на /zh записан по семейству', async () => {
    reqHeaders.ua = BAIDU;
    await renderTours();
    expect(entryHits()).toEqual([['/zh', 'baidu']]);
  });

  it('человек на /zh не записан: это перепись обходчиков, людей считает page_views', async () => {
    reqHeaders.ua = HUMAN;
    await renderTours();
    expect(entryHits()).toEqual([]);
  });

  it('отказ записи счётчика страницу не роняет и не глушится', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockImplementation((async (sql: string) => {
      if (String(sql).includes('INSERT INTO agent_entry_hits')) throw Object.assign(new Error('no table'), { code: '42P01' });
      return String(sql).includes('FROM operator_tours') ? { rows: tourRows } : { rows: [] };
    }) as never);
    const section = await renderTours();
    expect(shownIds(section)).toHaveLength(tourRows.length);
    await new Promise((r) => setTimeout(r, 0));
    expect(err).toHaveBeenCalledWith(expect.stringContaining('[agent-entry-hits]'), 'SQLSTATE=42P01', expect.any(String));
    err.mockRestore();
  });
});

describe('/zh: язык раздела в <head>', () => {
  it('layout раздела поднимает meta http-equiv content-language в <head> документа; <html lang> корня не меняет', () => {
    const html = renderToString(
      <html lang="ru">
        {/* eslint-disable-next-line @next/next/no-head-element -- документ целиком, как его собирает корневой layout */}
        <head><title>t</title></head>
        <body><ZhLayout><main lang="zh-CN">内容</main></ZhLayout></body>
      </html>,
    );
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
    expect(head).toContain(`<meta http-equiv="content-language" content="${ZH_CONTENT_LANGUAGE}"/>`);
    expect(html.slice(html.indexOf('<body>'))).not.toContain('http-equiv');
    expect(html).toMatch(/^<html lang="ru">/);
    expect(ZH_CONTENT_LANGUAGE).toBe('zh-CN');
  });
});
