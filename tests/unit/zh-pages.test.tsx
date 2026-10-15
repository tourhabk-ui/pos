/**
 * Китайские конспекты туров и мест — рендером с данными (аудит 15.10,
 * CN-pages; Китай, шаг 7, вариант «в»).
 *
 * Конспект — НЕ вторая карточка тура (CLAUDE.md §11): брони и своей SOS нет,
 * бронь — одна, на русской карточке, и конспект ведёт на неё. Машинный
 * перевод помечен; цифры и оператор — из полей базы, а не из перевода;
 * безопасность — по-русски с пометкой; непереведённое — русский текст с
 * пометкой, без придуманной транслитерации; устаревший по хэшу перевод не
 * показывается. Пара hreflang ru ↔ zh-CN — только у переведённой страницы, и
 * у русской карточки тоже.
 *
 * Судится то, что видит человек и обходчик: текст, href, lang, порядок,
 * метаданные — не исходник (CLAUDE.md §4).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, within } from '@testing-library/react';

vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), cache: <T,>(fn: T) => fn }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
const poolQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));
const dbQuery = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => dbQuery(...a) }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'user-agent': 'Mozilla/5.0 test' }) }));
const loadTourCard = vi.fn();
vi.mock('@/lib/tours/tour-detail-query', () => ({
  loadTourCard: (...a: unknown[]) => loadTourCard(...a),
  getTourReviews: async () => [],
}));
vi.mock('@/app/catalog/tours/[id]/_TourDetailClient', () => ({ default: () => null }));
vi.mock('@/app/places/[id]/_PlaceDetailClient', () => ({ default: () => null }));
vi.mock('@/components/places/PlaceSOS', () => ({ default: () => null }));

import { ZhTourSummary, ZhPlaceSummary } from '@/components/zh/ZhDetail';
import { ZH_DETAIL } from '@/lib/zh/detail-text';
import { ZH_PLACES_RULE, type ZhPlaceSourceRow, type ZhTourSourceRow } from '@/lib/zh/content';
import {
  encodeStored, normalizeSource, sourceHash,
  type ZhFieldKind, type ZhFieldValue, type ZhStoredTranslation,
} from '@/lib/zh/fields';
import { priceZh } from '@/lib/zh/entry';
import { ZH_PAGE } from '@/lib/mcp/zh-layer';

const TOUR: ZhTourSourceRow = {
  id: '51',
  slug: 'dolina-geyzerov',
  title: 'Долина гейзеров на вертолёте',
  short_description: 'Полёт на Ми-8 в Кроноцкий заповедник.',
  description: 'Вылет в 9:00, три часа в долине и обед.',
  program: [{ title: 'Вылет', text: 'Сбор в 8:30 у вертолётной площадки' }, { title: 'Долина', text: '' }],
  included: ['Обед', 'Трансфер'],
  not_included: null,
  what_to_bring: ['Дождевик'],
  base_price: '105000',
  price_unit: 'per_person',
  duration_hours: '8',
  max_participants: 20,
  season_start: '2026-06-01',
  season_end: '2026-09-30',
  safety_notes: ['Не отходить от группы в долине'],
  operator_name: 'Вертолётный Тест',
  operator_slug: 'heli-test',
  operator_public: true,
};

const ZH_TITLE = '直升机游间歇泉谷';
const ZH_DESC = '9:00起飞，在山谷停留三小时并享用午餐。';

/** Строка перевода с хэшем нынешнего исходника (или с хэшем другого текста — устаревшая). */
function tr(field: string, kind: ZhFieldKind, raw: unknown, zh: ZhFieldValue, opts: { staleFrom?: unknown; at?: string } = {}): [string, ZhStoredTranslation] {
  const src = normalizeSource(kind, opts.staleFrom ?? raw);
  if (src === null) throw new Error(`пустой исходник у ${field}`);
  return [field, {
    field,
    text: encodeStored(kind, zh),
    source_hash: sourceHash(kind, src),
    translated_at: opts.at ?? '2026-10-15T10:00:00Z',
    reviewed_at: null,
  }];
}

function translated(...rows: Array<[string, ZhStoredTranslation]>): Map<string, ZhStoredTranslation> {
  return new Map(rows);
}

const FRESH = () => translated(
  tr('title', 'text', TOUR.title, ZH_TITLE),
  tr('description', 'text', TOUR.description, ZH_DESC, { at: '2026-10-14T08:00:00Z' }),
);

afterEach(cleanup);

describe('конспект тура: перевод помечен, оригинал рядом, бронь одна — на русской карточке', () => {
  it('китайское название и русский оригинал рядом; пометка машинного перевода с датой; ссылка на единственную карточку', () => {
    const { container } = render(<ZhTourSummary tour={TOUR} translations={FRESH()} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(ZH_TITLE);
    const original = container.querySelector('[data-zh-original-title]') as HTMLElement;
    expect(original.textContent).toBe(TOUR.title);
    expect(original.getAttribute('lang')).toBe('ru');
    const note = container.querySelector('[data-zh-mt-note]') as HTMLElement;
    expect(note.textContent).toContain(ZH_DETAIL.mtUnreviewed);
    expect(note.textContent).toContain('2026-10-15');
    expect(note.textContent).toContain(ZH_DETAIL.noBooking);
    const link = within(note).getByRole('link', { name: ZH_DETAIL.originalTour });
    expect(link.getAttribute('href')).toBe('/catalog/tours/dolina-geyzerov');
  });

  it('брони, формы и своей SOS нет: ни кнопки, ни поля, ни ссылки на экстренный вызов', () => {
    const { container } = render(<ZhTourSummary tour={TOUR} translations={FRESH()} />);
    expect(container.querySelector('form, button, input, select, textarea')).toBeNull();
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs.sort()).toEqual(['/catalog/tours/dolina-geyzerov', '/operators/heli-test', '/zh'].sort());
    expect(container.textContent).not.toMatch(/SOS/i);
    expect(hrefs.some((h) => /^tel:|emergency/.test(h ?? ''))).toBe(false);
    // 112 — словами, как на /zh, а не кнопкой.
    expect(container.textContent).toContain(ZH_PAGE.emergency);
  });

  it('цифры — из полей базы при показе, а не из перевода: правка цены видна сразу при том же переводе', () => {
    const { container, rerender } = render(<ZhTourSummary tour={TOUR} translations={FRESH()} />);
    const fact = (label: string) => (container.querySelector(`[data-zh-fact="${label}"]`) as HTMLElement).textContent;
    expect(fact(ZH_DETAIL.facts.price)).toBe(priceZh(TOUR));
    expect(fact(ZH_DETAIL.facts.price)).toBe('105,000 卢布 每人');
    expect(fact(ZH_DETAIL.facts.duration)).toBe('约 8 小时');
    expect(fact(ZH_DETAIL.facts.group)).toBe('最多 20 人');
    expect(fact(ZH_DETAIL.facts.season)).toBe('6月 – 9月');
    expect(fact(ZH_DETAIL.facts.operator)).toBe('Вертолётный Тест');

    rerender(<ZhTourSummary tour={{ ...TOUR, base_price: '99000', max_participants: null }} translations={FRESH()} />);
    expect(fact(ZH_DETAIL.facts.price)).toBe('99,000 卢布 每人');
    // Не записано — «未填写», а не ноль.
    expect(fact(ZH_DETAIL.facts.group)).toBe(ZH_DETAIL.notRecorded);
    rerender(<ZhTourSummary tour={{ ...TOUR, base_price: '0' }} translations={FRESH()} />);
    expect(fact(ZH_DETAIL.facts.price)).toBe(ZH_DETAIL.notRecorded);
    expect(container.textContent).not.toContain('0 卢布');
  });

  it('непереведённое — русский текст с пометкой «暂无中文翻译», без придуманной транслитерации', () => {
    const { container } = render(<ZhTourSummary tour={TOUR} translations={FRESH()} />);
    const program = container.querySelector('[data-zh-field="program"]') as HTMLElement;
    expect(program.getAttribute('data-zh-state')).toBe('missing');
    expect(within(program).getByText(ZH_DETAIL.missing)).toBeTruthy();
    const ru = program.querySelector('[lang="ru"]') as HTMLElement;
    expect(ru.textContent).toContain('Вылет');
    expect(ru.textContent).toContain('Сбор в 8:30 у вертолётной площадки');
    // Свежий перевод описания — по-китайски, без пометки.
    const desc = container.querySelector('[data-zh-field="description"]') as HTMLElement;
    expect(desc.getAttribute('data-zh-state')).toBe('fresh');
    expect(desc.textContent).toContain(ZH_DESC);
    expect(desc.querySelector('[data-zh-note]')).toBeNull();
    // Поля нет в исходнике — блока нет.
    expect(container.querySelector('[data-zh-field="not_included"]')).toBeNull();
  });

  it('перевод старого текста не показывается: исходник правили — русский текст и «原文已更新»', () => {
    const OLD_ZH = '旧的翻译';
    const tours = translated(
      tr('title', 'text', TOUR.title, ZH_TITLE),
      tr('description', 'text', TOUR.description, OLD_ZH, { staleFrom: 'Прежнее описание тура' }),
    );
    const { container } = render(<ZhTourSummary tour={TOUR} translations={tours} />);
    const desc = container.querySelector('[data-zh-field="description"]') as HTMLElement;
    expect(desc.getAttribute('data-zh-state')).toBe('stale');
    expect(within(desc).getByText(ZH_DETAIL.stale)).toBeTruthy();
    expect(container.textContent).not.toContain(OLD_ZH);
    expect((desc.querySelector('[lang="ru"]') as HTMLElement).textContent).toContain(TOUR.description as string);
  });

  it('переводы не прочитались — «暂时无法读取», а не «перевода нет»; название русское', () => {
    const { container } = render(<ZhTourSummary tour={TOUR} translations={null} />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe(TOUR.title);
    expect(h1.getAttribute('lang')).toBe('ru');
    expect((container.querySelector('[data-zh-field="description"]') as HTMLElement).getAttribute('data-zh-state')).toBe('unknown');
    expect(container.textContent).toContain(ZH_DETAIL.unknown);
    const note = container.querySelector('[data-zh-mt-note]') as HTMLElement;
    expect(note.textContent).toContain(ZH_DETAIL.noPageTranslation);
    expect(note.textContent).not.toContain(ZH_DETAIL.mtUnreviewed);
  });

  it('безопасность — по-русски из базы с пометкой «安全信息仅提供俄语原文»', () => {
    const { container } = render(<ZhTourSummary tour={TOUR} translations={FRESH()} />);
    const safety = container.querySelector('[data-zh-safety]') as HTMLElement;
    expect(safety.textContent).toContain(ZH_DETAIL.safetyRuOnly);
    const li = within(safety).getByText('Не отходить от группы в долине');
    expect(li.closest('[lang="ru"]')).not.toBeNull();
    cleanup();
    const none = render(<ZhTourSummary tour={{ ...TOUR, safety_notes: null }} translations={FRESH()} />);
    expect((none.container.querySelector('[data-zh-safety]') as HTMLElement).textContent).toContain(ZH_DETAIL.noSafetyNotes);
  });
});

const PLACE: ZhPlaceSourceRow = {
  id: '4f1217e7-31a4-4d21-bc98-3d46aaba122e',
  slug: 'kronotskij-zapovednik',
  ark_id: 'b0e1c2d3-0000-4000-8000-00000000a1c0',
  name: 'Кроноцкий заповедник',
  description: 'Заповедник на востоке полуострова.',
  lat: '54.8',
  lng: '160.6',
  altitude_m: null,
  hazard_types: ['bears', 'thermal'],
  profile_source: 'manual',
};

describe('конспект места: имя только из источника, правило названо, цен нет', () => {
  it('китайское имя из OSM с источником, русское рядом; правило отбора названо; ссылка на русскую карточку', () => {
    const rows = translated(tr('description', 'text', PLACE.description, '半岛东部的自然保护区。'));
    const { container } = render(
      <ZhPlaceSummary place={PLACE} zhName={{ name: '克罗诺基自然保护区', source: 'OpenStreetMap name:zh' }} translations={rows} rule={ZH_PLACES_RULE} />,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('克罗诺基自然保护区');
    expect((container.querySelector('[data-zh-original-title]') as HTMLElement).textContent).toBe(PLACE.name);
    expect((container.querySelector('[data-zh-name-source]') as HTMLElement).textContent).toBe('OpenStreetMap name:zh');
    expect((container.querySelector('[data-zh-places-rule]') as HTMLElement).textContent).toBe(ZH_PLACES_RULE);
    const note = container.querySelector('[data-zh-mt-note]') as HTMLElement;
    expect(note.textContent).toContain(ZH_DETAIL.mtUnreviewed);
    expect(within(note).getByRole('link', { name: ZH_DETAIL.originalPlace }).getAttribute('href')).toBe('/places/kronotskij-zapovednik');
    // Место — не тур: ни цены, ни брони.
    expect(container.textContent).not.toContain('卢布');
    expect(container.textContent).not.toContain(ZH_DETAIL.noBooking);
    expect(container.querySelector('form, button')).toBeNull();
  });

  it('китайского имени в источнике нет — русское имя с «（俄文名）», без транслитерации', () => {
    const { container } = render(<ZhPlaceSummary place={PLACE} zhName={null} translations={new Map()} rule={ZH_PLACES_RULE} />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe(`${PLACE.name}${ZH_DETAIL.ruName}`);
    expect((h1.querySelector('[lang="ru"]') as HTMLElement).textContent).toBe(PLACE.name);
    expect(container.querySelector('[data-zh-original-title]')).toBeNull();
    // Описание без перевода — русским с пометкой.
    const desc = container.querySelector('[data-zh-field="description"]') as HTMLElement;
    expect(desc.getAttribute('data-zh-state')).toBe('missing');
  });

  it('опасности — по-русски словарём платформы; шаблонный профиль фактом не произносится', () => {
    const { container } = render(<ZhPlaceSummary place={PLACE} zhName={null} translations={new Map()} rule={ZH_PLACES_RULE} />);
    const safety = container.querySelector('[data-zh-safety]') as HTMLElement;
    expect(safety.textContent).toContain(ZH_DETAIL.safetyRuOnly);
    expect(within(safety).getByText('Медведи').closest('[lang="ru"]')).not.toBeNull();
    expect(within(safety).getByText('Термальные зоны')).toBeTruthy();
    cleanup();
    const templ = render(<ZhPlaceSummary place={{ ...PLACE, profile_source: 'type_template' }} zhName={null} translations={new Map()} rule={ZH_PLACES_RULE} />);
    const s2 = templ.container.querySelector('[data-zh-safety]') as HTMLElement;
    expect(s2.textContent).not.toContain('Медведи');
    expect(s2.textContent).toContain(ZH_DETAIL.hazardsNone);
  });
});

// ── Страницы и метаданные: вызов с базой под подменой ─────────────────────

let PLACE_ROW: ZhPlaceSourceRow = { ...PLACE };
let tourRows: ZhTourSourceRow[] = [];
let translationRows: Array<ZhStoredTranslation & { entity_id: string }> = [];

function routeSql(sql: string): { rows: unknown[] } {
  if (sql.includes('FROM content_translations')) return { rows: translationRows };
  if (sql.includes('ot.short_description')) return { rows: tourRows };
  // Список /zh (lib/zh/entry): та же витрина, свои колонки.
  if (sql.includes('FROM operator_tours')) return { rows: tourRows };
  if (sql.includes('rw_zh') && sql.includes('FROM places p')) return { rows: [PLACE_ROW] };
  return { rows: [] };
}

beforeEach(() => {
  poolQuery.mockReset();
  dbQuery.mockReset();
  loadTourCard.mockReset();
  tourRows = [TOUR];
  translationRows = [];
  PLACE_ROW = { ...PLACE };
  poolQuery.mockImplementation(async (sql: string) => routeSql(String(sql)));
  dbQuery.mockImplementation(async () => ({ rows: [] }));
});

function withEntity(id: string, rows: Map<string, ZhStoredTranslation>) {
  return [...rows.values()].map((r) => ({ ...r, entity_id: id }));
}

describe('/zh/tours/[slug]: индексируется и получает пару языков только с переводом', () => {
  it('перевод есть — index, canonical на себя, hreflang ru ↔ zh-CN; страница рисует конспект без брони', async () => {
    translationRows = withEntity('51', FRESH());
    const mod = await import('@/app/zh/tours/[slug]/page');
    const meta = await mod.generateMetadata({ params: Promise.resolve({ slug: 'dolina-geyzerov' }) });
    expect(meta.robots).toMatchObject({ index: true });
    expect(meta.alternates?.canonical).toBe('https://vedarai.ru/zh/tours/dolina-geyzerov');
    expect(meta.alternates?.languages).toEqual({
      ru: 'https://vedarai.ru/catalog/tours/dolina-geyzerov',
      'zh-CN': 'https://vedarai.ru/zh/tours/dolina-geyzerov',
    });
    // absolute: бренд Vedar в строке, русского « | Ведар» шаблона layout нет (prod-check 137).
    const title = (meta.title as { absolute: string }).absolute;
    expect(title).toContain(ZH_TITLE);
    expect(title).toMatch(/｜Vedar$/);
    expect(title).not.toContain('Ведар');

    const page = await mod.default({ params: Promise.resolve({ slug: 'dolina-geyzerov' }) });
    const { container } = render(page);
    expect(container.querySelector('main')?.getAttribute('lang')).toBe('zh-CN');
    expect(container.querySelector('[data-zh-tour-summary="51"]')).not.toBeNull();
    expect(container.querySelector('form, button')).toBeNull();
  });

  it('перевода нет — noindex и без пары языков; страница всё равно открывается', async () => {
    const mod = await import('@/app/zh/tours/[slug]/page');
    const meta = await mod.generateMetadata({ params: Promise.resolve({ slug: 'dolina-geyzerov' }) });
    expect(meta.robots).toMatchObject({ index: false });
    expect(meta.alternates?.languages).toBeUndefined();
    const page = await mod.default({ params: Promise.resolve({ slug: 'dolina-geyzerov' }) });
    const { container } = render(page);
    expect(container.textContent).toContain(ZH_DETAIL.missing);
  });

  it('нет живого тура — 404, а не пустая страница', async () => {
    tourRows = [];
    const mod = await import('@/app/zh/tours/[slug]/page');
    await expect(mod.default({ params: Promise.resolve({ slug: 'net-takogo' }) })).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
  });

  it('отказ базы — ошибка страницы с причиной в логе, а не «не найдено»', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    poolQuery.mockRejectedValue(Object.assign(new Error('timeout'), { code: '57014' }));
    const mod = await import('@/app/zh/tours/[slug]/page');
    await expect(mod.default({ params: Promise.resolve({ slug: 'dolina-geyzerov' }) })).rejects.toThrow('timeout');
    expect(err).toHaveBeenCalledWith(expect.stringContaining('страница /zh/tours'), 'SQLSTATE=57014', 'timeout');
    err.mockRestore();
  });
});

describe('/zh: список ведёт на китайские конспекты', () => {
  it('тур — ссылкой на /zh/tours/<адрес>; китайское название только свежее, русский оригинал рядом', async () => {
    tourRows = [TOUR, { ...TOUR, id: '52', slug: null, title: 'Рыбалка на Быстрой', operator_name: 'Альфа' }];
    translationRows = withEntity('51', FRESH());
    const { default: ZhEntryPage } = await import('@/app/zh/page');
    const { container } = render(await ZhEntryPage());
    const first = container.querySelector('[data-zh-tour="51"]') as HTMLElement;
    const link = within(first).getByRole('link', { name: ZH_TITLE });
    expect(link.getAttribute('href')).toBe('/zh/tours/dolina-geyzerov');
    expect(within(first).getByText(TOUR.title).getAttribute('lang')).toBe('ru');
    // Без перевода — русское название, но ссылка всё равно на китайский конспект.
    const second = container.querySelector('[data-zh-tour="52"]') as HTMLElement;
    const ru = within(second).getByRole('link', { name: 'Рыбалка на Быстрой' });
    expect(ru.getAttribute('href')).toBe('/zh/tours/52');
    expect(ru.getAttribute('lang')).toBe('ru');
    // Ни одна ссылка списка не ведёт на русскую карточку мимо конспекта.
    const tourLinks = [...container.querySelectorAll('[data-zh-tour] a')].map((a) => a.getAttribute('href'));
    expect(tourLinks.some((h) => h?.startsWith('/catalog/tours/'))).toBe(false);
  });

  it('название переведено со старого текста — в списке русское', async () => {
    translationRows = withEntity('51', translated(tr('title', 'text', TOUR.title, ZH_TITLE, { staleFrom: 'Старое название' })));
    const { default: ZhEntryPage } = await import('@/app/zh/page');
    const { container } = render(await ZhEntryPage());
    expect(container.textContent).not.toContain(ZH_TITLE);
    expect(within(container.querySelector('[data-zh-tour="51"]') as HTMLElement).getByRole('link', { name: TOUR.title })).toBeTruthy();
  });
});

describe('/zh/places/[slug]: та же пара по тому же правилу', () => {
  it('описание переведено — index и hreflang на русскую карточку; нет — noindex', async () => {
    const mod = await import('@/app/zh/places/[slug]/page');
    const before = await mod.generateMetadata({ params: Promise.resolve({ slug: 'kronotskij-zapovednik' }) });
    expect(before.robots).toMatchObject({ index: false });
    expect(before.alternates?.languages).toBeUndefined();

    translationRows = withEntity(PLACE.id, translated(tr('description', 'text', PLACE.description, '半岛东部的自然保护区。')));
    const after = await mod.generateMetadata({ params: Promise.resolve({ slug: 'kronotskij-zapovednik' }) });
    expect(after.robots).toMatchObject({ index: true });
    expect(after.alternates?.languages).toEqual({
      ru: 'https://vedarai.ru/places/kronotskij-zapovednik',
      'zh-CN': 'https://vedarai.ru/zh/places/kronotskij-zapovednik',
    });
  });
});

describe('/zh/places/[slug]: адрес русской карточки и битый адрес (ревью волны 6)', () => {
  it('у места без ЧПУ hreflang и ссылка «оригинал» ведут на канонический /places/<ark_id>, а не на второй адрес', async () => {
    PLACE_ROW = { ...PLACE, slug: null };
    translationRows = withEntity(PLACE.id, translated(tr('description', 'text', PLACE.description, '半岛东部的自然保护区。')));
    const mod = await import('@/app/zh/places/[slug]/page');
    const meta = await mod.generateMetadata({ params: Promise.resolve({ slug: PLACE.id }) });
    expect(meta.alternates?.languages).toEqual({
      ru: `https://vedarai.ru/places/${PLACE.ark_id}`,
      'zh-CN': `https://vedarai.ru/zh/places/${PLACE.id}`,
    });
    const { container } = render(await mod.default({ params: Promise.resolve({ slug: PLACE.id }) }));
    const note = container.querySelector('[data-zh-mt-note]') as HTMLElement;
    expect(within(note).getByRole('link', { name: ZH_DETAIL.originalPlace }).getAttribute('href')).toBe(`/places/${PLACE.ark_id}`);
  });

  it('битая %-последовательность в адресе — 404 и noindex, а не 500; база не спрошена', async () => {
    const mod = await import('@/app/zh/places/[slug]/page');
    const meta = await mod.generateMetadata({ params: Promise.resolve({ slug: '%E0%A4%A' }) });
    expect(meta.robots).toMatchObject({ index: false });
    await expect(mod.default({ params: Promise.resolve({ slug: '%E0%A4%A' }) })).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    expect(poolQuery.mock.calls.some((c) => String(c[0]).includes('FROM places p'))).toBe(false);
  });
});

describe('русские карточки: ответная ссылка hreflang — только на переведённый конспект', () => {
  const CARD = {
    id: 51, slug: 'dolina-geyzerov', title: TOUR.title, description: TOUR.description,
    short_description: TOUR.short_description, activity_type: 'helicopter', operator_name: 'Вертолётный Тест',
    operator_verified: true, photos: [], tour_image: null,
  };

  it('карточка тура: перевод свежий — zh-CN в alternates; нет — только canonical', async () => {
    loadTourCard.mockResolvedValue({ tour: CARD, byId: false });
    const { generateMetadata } = await import('@/app/catalog/tours/[id]/page');
    const without = await generateMetadata({ params: Promise.resolve({ id: 'dolina-geyzerov' }) });
    expect(without.alternates).toEqual({ canonical: 'https://vedarai.ru/catalog/tours/dolina-geyzerov' });

    translationRows = withEntity('51', FRESH());
    const withZh = await generateMetadata({ params: Promise.resolve({ id: 'dolina-geyzerov' }) });
    expect(withZh.alternates?.languages).toEqual({
      ru: 'https://vedarai.ru/catalog/tours/dolina-geyzerov',
      'zh-CN': 'https://vedarai.ru/zh/tours/dolina-geyzerov',
    });

    // Оператор переписал название — перевод устарел, пары нет.
    loadTourCard.mockResolvedValue({ tour: { ...CARD, title: 'Новое название' }, byId: false });
    const stale = await generateMetadata({ params: Promise.resolve({ id: 'dolina-geyzerov' }) });
    expect(stale.alternates?.languages).toBeUndefined();
  });

  it('карточка места: пара только при свежем переводе описания', async () => {
    dbQuery.mockImplementation(async (sql: string) => (String(sql).includes('FROM places p')
      ? { rows: [{ place_pk: PLACE.id, name: PLACE.name, description: PLACE.description, slug: PLACE.slug, ark_id: '0c0aa41c-fd40-4f97-ac35-56f10bf94b69', lat: 54.8, lng: 160.6, location_type: 'reserve', hazard_types: [], images: [] }] }
      : { rows: [] }));
    const { generateMetadata } = await import('@/app/places/[id]/page');
    const without = await generateMetadata({ params: Promise.resolve({ id: 'kronotskij-zapovednik' }) });
    expect(without.alternates).toEqual({ canonical: '/places/kronotskij-zapovednik' });

    translationRows = withEntity(PLACE.id, translated(tr('description', 'text', PLACE.description, '半岛东部的自然保护区。')));
    const withZh = await generateMetadata({ params: Promise.resolve({ id: 'kronotskij-zapovednik' }) });
    expect(withZh.alternates?.languages).toEqual({
      ru: 'https://vedarai.ru/places/kronotskij-zapovednik',
      'zh-CN': 'https://vedarai.ru/zh/places/kronotskij-zapovednik',
    });
  });
});
