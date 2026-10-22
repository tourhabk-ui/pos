/**
 * Экран «Чего не хватает турам» (/hub/operator/completeness) — решение
 * владельца 13.10: «сделай экран „чего не хватает туру“ в кабинете».
 *
 * Экран существовал и раньше под именем «Полнота туров», но отвечал не на
 * тот вопрос: вёл с процента заполненности карточки (тур показывал «100%»
 * и при этом не уходил ни на одну витрину), а блокеры витрин лежали
 * свёрнутыми и без ссылок — оператор читал «нет условий отмены» и шёл
 * искать поле сам. Теперь готовность по правилу лент стоит первой, и у
 * КАЖДОГО блокера есть действие: якорь в редакторе тура, профиль компании
 * или быстрое поле прямо на экране.
 *
 * Сторож держит связку целиком (§10.09): у каждого кода правила есть адрес,
 * у каждого адреса — якорь в редакторе, и редактор умеет к нему прокрутить
 * (форма рисуется после fetch, браузерная прокрутка по хэшу промахивается).
 * Экран проверяется рендером: ссылки и цифры видны только живым компонентом.
 *
 * #2642: витрин две, и правила у них разные. Каталог Ведара судится шлюзом
 * publicTourSql — у тура бейдж «На витрине» / «Черновик — туристы не видят» /
 * «Скрыт»; ленты Авито и Яндекса берут только туры с витрины Ведара и уже из
 * них — по missingFields. До #2642 экран ставил «Опубликован» по одному
 * is_published и звал черновик со всеми полями «готовым к выкладке».
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, act, within, fireEvent } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLOCKER_LABELS } from '@/lib/tours/readiness';
import { BLOCKER_TARGETS, EDITOR_ANCHORS, blockerHref, blockerQuickField, OPERATOR_PROFILE_PATH } from '@/lib/operator/blocker-targets';
import { OPERATOR_MENU } from '@/components/operator/operator-menu';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/hub/operator/completeness',
  useParams: () => ({}),
}));
vi.mock('react-hot-toast', () => {
  const t = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), loading: vi.fn(() => 'id'), dismiss: vi.fn() });
  return { default: t, toast: t };
});

import CompletenessClient from '@/app/hub/operator/completeness/_CompletenessClient';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const UI = read('app/hub/operator/completeness/_CompletenessClient.tsx');
const EDITOR = read('app/hub/operator/tours/[id]/_EditTourClient.tsx');
const HELP = read('lib/help/content.ts');

// ─── Связка: код правила → адрес → якорь ────────────────────────────────────

describe('у каждого блокера правила есть адрес, и адрес ведёт на живой якорь', () => {
  it('множества кодов в BLOCKER_LABELS и BLOCKER_TARGETS равны', () => {
    const labels = Object.keys(BLOCKER_LABELS).sort();
    const targets = Object.keys(BLOCKER_TARGETS).sort();
    expect(targets, 'код правила без адреса показался бы строкой без кнопки').toEqual(labels);
  });

  it('у каждого якоря редактора есть элемент с таким id и отступом под шапку', () => {
    expect(EDITOR_ANCHORS.length).toBeGreaterThan(0);
    for (const anchor of EDITOR_ANCHORS) {
      const m = EDITOR.match(new RegExp(`<\\w+ id="${anchor}" className="([^"]*)"`));
      expect(m, `в редакторе нет элемента id="${anchor}"`).not.toBeNull();
      expect(m![1], `якорь «${anchor}» уедет под липкую шапку`).toMatch(/\bscroll-mt-\d+\b/);
    }
  });

  it('редактор прокручивает к #якорю после загрузки, а не доверяет браузеру', () => {
    // Форма рисуется после fetch: в момент открытия страницы секции в
    // документе нет, и браузерная прокрутка по хэшу попадает на спиннер.
    expect(EDITOR).toMatch(/window\.location\.hash/);
    expect(EDITOR).toMatch(/getElementById\(anchor\)\?\.scrollIntoView/);
    const effect = EDITOR.indexOf('window.location.hash');
    expect(EDITOR.slice(effect - 200, effect)).toMatch(/if \(loading \|\| !tour\) return;/);
  });

  it('адреса: редактор с якорем, профиль компании, быстрое поле — без адреса', () => {
    expect(blockerHref('cancellation_policy', '51')).toBe('/hub/operator/tours/51#cancellation');
    expect(blockerHref('pickup', '51')).toBe('/hub/operator/tours/51#pickup');
    expect(blockerHref('pickup_details', '51')).toBe('/hub/operator/tours/51#pickup');
    expect(blockerHref('coordinates', '51')).toBe('/hub/operator/tours/51#location');
    expect(blockerHref('photos', '51')).toBe('/hub/operator/tours/51#photos');
    expect(blockerHref('description', '51')).toBe('/hub/operator/tours/51#basics');
    expect(blockerHref('operator_contact', '51')).toBe(OPERATOR_PROFILE_PATH);
    expect(OPERATOR_PROFILE_PATH).toBe('/hub/operator/profile');
    // Быстрые поля заполняются на месте — только те, что quick-fill принимает.
    expect(blockerQuickField('base_price')).toBe('base_price');
    expect(blockerQuickField('duration_hours')).toBe('duration_hours');
    expect(blockerQuickField('title')).toBe('title');
    expect(blockerQuickField('cancellation_policy')).toBeNull();
    // Незнакомый код — в редактор без якоря, а не в никуда.
    expect(blockerHref('что-то новое', '51')).toBe('/hub/operator/tours/51');
  });

  it('описание — в редактор, а не в быстрое поле: триста знаков не одна строка', () => {
    expect(BLOCKER_TARGETS.description).toEqual({ kind: 'editor', anchor: 'basics' });
  });
});

// ─── Имя экрана одно: меню, страница, справка ───────────────────────────────

describe('экран зовётся «Чего не хватает» везде, где его называют', () => {
  it('пункт меню и заголовок страницы', () => {
    const item = OPERATOR_MENU.find((m) => m.href === '/hub/operator/completeness');
    expect(item?.label).toBe('Чего не хватает');
    expect(read('app/hub/operator/completeness/page.tsx')).toMatch(/title: 'Чего не хватает турам \| Оператор'/);
  });

  it('справка называет пункт его именем и обещает переход к полю', () => {
    expect(HELP).toMatch(/«Чего не хватает» показывает/);
    expect(HELP).not.toMatch(/«Полнота туров» показывает/);
  });
});

// ─── Рендер ─────────────────────────────────────────────────────────────────

type Tour = {
  tour_id: string; tour_title: string;
  is_active: boolean; is_published: boolean; on_storefront: boolean;
  required_score: number; recommended_score: number; total_score: number;
  missing_required: string[]; missing_recommended: string[];
  marketplace_ready: boolean; marketplace_blockers: Array<{ field: string; label: string }>;
};
const b = (field: string) => ({ field, label: BLOCKER_LABELS[field] });
// Флаги витрины — как их отдаёт API: оба флага и ответ шлюза каталога.
const ON = { is_active: true, is_published: true, on_storefront: true };
const DRAFT = { is_active: true, is_published: false, on_storefront: false };
const HIDDEN = { is_active: false, is_published: true, on_storefront: false };
const HIDDEN_DRAFT = { is_active: false, is_published: false, on_storefront: false };
const TOURS: Tour[] = [
  {
    tour_id: '51', tour_title: 'Сплав по реке Быстрая', ...ON,
    required_score: 100, recommended_score: 60, total_score: 88,
    missing_required: [], missing_recommended: ['tour_image', 'difficulty'],
    marketplace_ready: false,
    marketplace_blockers: [b('cancellation_policy'), b('pickup'), b('operator_contact'), b('base_price'), b('description')],
  },
  {
    tour_id: '52', tour_title: 'Вулкан Горелый', ...ON,
    required_score: 100, recommended_score: 100, total_score: 100,
    missing_required: [], missing_recommended: [],
    marketplace_ready: true, marketplace_blockers: [],
  },
  {
    tour_id: '53', tour_title: 'Черновик рыбалки', ...DRAFT,
    required_score: 40, recommended_score: 0, total_score: 28,
    missing_required: ['base_price'], missing_recommended: [],
    marketplace_ready: false, marketplace_blockers: [b('photos'), b('cancellation_policy')],
  },
  // #2642: новый тур со всеми полями — черновик. Каталог его не показывает,
  // ленты не берут, и «готов» он не числится.
  {
    tour_id: '54', tour_title: 'Новый тур на Мутновский', ...DRAFT,
    required_score: 100, recommended_score: 100, total_score: 100,
    missing_required: [], missing_recommended: [],
    marketplace_ready: false, marketplace_blockers: [],
  },
  {
    tour_id: '55', tour_title: 'Скрытый тур на Авачинский', ...HIDDEN,
    required_score: 100, recommended_score: 100, total_score: 100,
    missing_required: [], missing_recommended: [],
    marketplace_ready: false, marketplace_blockers: [],
  },
  // Ревью #2642: выключен И не опубликован. Бейдж «Скрыт», но лекарство —
  // обе отметки, и в счёт неопубликованных он входит.
  {
    tour_id: '56', tour_title: 'Выключенный черновик на Толбачик', ...HIDDEN_DRAFT,
    required_score: 100, recommended_score: 100, total_score: 100,
    missing_required: [], missing_recommended: [],
    marketplace_ready: false, marketplace_blockers: [],
  },
];

function installFetch(body: unknown, opts: { reject?: boolean } = {}) {
  globalThis.fetch = vi.fn(() => {
    if (opts.reject) return Promise.reject(new Error('сеть не ответила'));
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as unknown as typeof fetch;
}
const OK = (tours: Tour[]) => ({
  success: true,
  data: { stats: { totalTours: tours.length, avgTotalScore: 0, fullyComplete: 0, criticallyIncomplete: 0 }, tours },
});

async function flush() { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }

beforeEach(() => { push.mockReset(); });
afterEach(() => { cleanup(); });

describe('экран: блокеры с действиями, цифры, третий исход', () => {
  it('каждый блокер — строка с действием туда, где он чинится', async () => {
    installFetch(OK(TOURS));
    render(<CompletenessClient />);
    await flush();

    const list = screen.getByRole('list', { name: 'Чего не хватает: Сплав по реке Быстрая' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(5);

    const hrefOf = (label: string) => {
      const row = rows.find((r) => r.textContent?.includes(label));
      expect(row, `нет строки «${label}»`).toBeDefined();
      return within(row!).queryByRole('link')?.getAttribute('href') ?? null;
    };
    expect(hrefOf(BLOCKER_LABELS.cancellation_policy)).toBe('/hub/operator/tours/51#cancellation');
    expect(hrefOf(BLOCKER_LABELS.pickup)).toBe('/hub/operator/tours/51#pickup');
    expect(hrefOf(BLOCKER_LABELS.description)).toBe('/hub/operator/tours/51#basics');
    expect(hrefOf(BLOCKER_LABELS.operator_contact)).toBe('/hub/operator/profile');

    // Контакт — в профиле, и кнопка так и называется; редакторские — «в редакторе».
    const contactRow = rows.find((r) => r.textContent?.includes(BLOCKER_LABELS.operator_contact))!;
    expect(within(contactRow).getByRole('link')).toHaveTextContent('Открыть профиль');
    const cancelRow = rows.find((r) => r.textContent?.includes(BLOCKER_LABELS.cancellation_policy))!;
    expect(within(cancelRow).getByRole('link')).toHaveTextContent('Открыть в редакторе');

    // Цена — быстрое поле прямо здесь: кнопка открывает диалог с числовым полем.
    const priceRow = rows.find((r) => r.textContent?.includes(BLOCKER_LABELS.base_price))!;
    expect(within(priceRow).queryByRole('link')).toBeNull();
    fireEvent.click(within(priceRow).getByRole('button', { name: 'Заполнить' }));
    const dialog = screen.getByRole('dialog', { name: 'Заполнить поле' });
    expect(dialog).toHaveTextContent('Базовая цена');
    expect(dialog).toHaveTextContent('Сплав по реке Быстрая');
    expect(within(dialog).getByLabelText('Значение')).toHaveAttribute('type', 'number');
  });

  it('готовность названа словами лент и стоит у каждого тура', async () => {
    installFetch(OK(TOURS));
    render(<CompletenessClient />);
    await flush();
    const tour = (title: string) => screen.getByRole('article', { name: title });
    expect(tour('Сплав по реке Быстрая')).toHaveTextContent('Не уйдёт на Авито и Яндекс — не хватает: 5');
    expect(tour('Вулкан Горелый')).toHaveTextContent('Готов к выкладке на Авито и Яндекс');
    // Ленты берут только туры с витрины Ведара: у тура вне её счёт пробелов —
    // не весь ответ, и пустой список блокеров — ещё не «готов» (#2642).
    expect(tour('Черновик рыбалки')).toHaveTextContent('На Авито и Яндекс уходят только туры с витрины Ведара; для лент не хватает ещё: 2');
    for (const t of ['Новый тур на Мутновский', 'Скрытый тур на Авачинский', 'Выключенный черновик на Толбачик']) {
      expect(tour(t)).toHaveTextContent('На Авито и Яндекс уходят только туры с витрины Ведара — поля для лент заполнены');
      expect(tour(t)).not.toHaveTextContent('Готов к выкладке');
      expect(screen.queryByRole('list', { name: `Чего не хватает: ${t}` }), 'пустой список блокеров не рисуется').toBeNull();
    }
    expect(screen.getAllByText('Готов к выкладке на Авито и Яндекс')).toHaveLength(1);
    // Готовый тур блокеров не показывает.
    expect(screen.queryByRole('list', { name: 'Чего не хватает: Вулкан Горелый' })).toBeNull();
  });

  it('витрина Ведара — бейджем по шлюзу каталога, а не по одному флагу (#2642)', async () => {
    installFetch(OK(TOURS));
    render(<CompletenessClient />);
    await flush();
    const tour = (title: string) => screen.getByRole('article', { name: title });
    const badge = (title: string, label: string) => {
      const el = within(tour(title)).getByText(label);
      expect(el).toHaveClass('ds-badge');
      return el;
    };
    badge('Сплав по реке Быстрая', 'На витрине');
    badge('Вулкан Горелый', 'На витрине');
    badge('Черновик рыбалки', 'Черновик — туристы не видят');
    badge('Новый тур на Мутновский', 'Черновик — туристы не видят');
    // Выключенный тур при is_published = true прежде числился «Опубликован».
    badge('Скрытый тур на Авачинский', 'Скрыт');
    expect(screen.queryByText('Опубликован')).toBeNull();
    // Вне витрины — почему турист его не видит и где это меняется.
    expect(tour('Новый тур на Мутновский')).toHaveTextContent('в редакторе не отмечено «Опубликован»');
    expect(tour('Скрытый тур на Авачинский')).toHaveTextContent('Туристы его не видят: в редакторе не отмечено «Активен». «Активен» включает и глаз в списке туров.');
    // Ревью #2642: выключенному и неопубликованному одной «Активен» мало —
    // названы обе отметки, а не обещано лекарство, которого не хватит.
    badge('Выключенный черновик на Толбачик', 'Скрыт');
    expect(tour('Выключенный черновик на Толбачик')).toHaveTextContent('Туристы его не видят: в редакторе не отмечены «Активен» и «Опубликован».');
    expect(tour('Новый тур на Мутновский')).not.toHaveTextContent('«Активен»');
    expect(tour('Вулкан Горелый')).not.toHaveTextContent('Туристы его не видят');
  });

  it('сводка: витрина Ведара и ленты — отдельными счётами по списку, а не по stats', async () => {
    installFetch(OK(TOURS));
    render(<CompletenessClient />);
    await flush();
    const value = (title: string) => screen.getByText(title).nextElementSibling?.textContent;
    expect(value('На витрине Ведара')).toBe('2');
    expect(screen.getByText('На витрине Ведара').parentElement).toHaveTextContent('из 6 туров');
    expect(value('Готовы к Авито и Яндексу')).toBe('1');
    expect(value('Не хватает данных')).toBe('2');
    // Счёт по отметке «Опубликован», а не по бейджу: выключенный черновик в
    // нём есть, хотя бейдж у него «Скрыт» (ревью #2642).
    expect(value('Не опубликованы')).toBe('3');
    // Шапка не называет каталог Ведара судимым правилом лент.
    expect(screen.queryByText(/каталогу Ведара, Авито и Яндексу/)).toBeNull();
    expect(screen.getByText(/Каталог Ведара показывает тур, когда он активен и опубликован/)).toBeInTheDocument();
  });

  it('«чаще всего не хватает» — список работ по полям, худшее сверху', async () => {
    installFetch(OK(TOURS));
    render(<CompletenessClient />);
    await flush();
    const block = screen.getByText('Чаще всего не хватает').parentElement!;
    const items = within(block).getAllByRole('listitem').map((li) => li.textContent);
    expect(items[0]).toContain(BLOCKER_LABELS.cancellation_policy);
    expect(items[0]).toContain('2 тура');
    expect(items).toHaveLength(6);
  });

  it('туры без витринных пробелов идут после тех, где они есть', async () => {
    installFetch(OK(TOURS));
    render(<CompletenessClient />);
    await flush();
    const notReady = screen.getByRole('region', { name: 'Туры, которые не уйдут на Авито и Яндекс' });
    const ready = screen.getByRole('region', { name: 'Готовы к Авито и Яндексу' });
    expect(notReady.compareDocumentPosition(ready) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(notReady).toHaveTextContent('Сплав по реке Быстрая');
    expect(notReady).toHaveTextContent('Черновик рыбалки');
    // Черновик и скрытый со всеми полями — не среди готовых.
    expect(notReady).toHaveTextContent('Новый тур на Мутновский');
    expect(notReady).toHaveTextContent('Скрытый тур на Авачинский');
    expect(ready).toHaveTextContent('Вулкан Горелый');
    expect(ready).not.toHaveTextContent('Новый тур на Мутновский');
  });

  it('поле карточки, которого нет в quick-fill, ведёт в редактор (router.push)', async () => {
    installFetch(OK(TOURS));
    render(<CompletenessClient />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Ещё для карточки на Ведаре: 2 поля/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Главное фото' }));
    expect(push).toHaveBeenCalledWith('/hub/operator/tours/51');
  });

  it('третий исход: запрос не удался — «не смог проверить», а не «всё готово» и не «туров нет»', async () => {
    installFetch(null, { reject: true });
    render(<CompletenessClient />);
    await flush();
    expect(screen.getByText('Не смог проверить готовность')).toBeInTheDocument();
    expect(screen.getByText('сеть не ответила')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
    expect(screen.queryByText('На витрине Ведара')).toBeNull();
    expect(screen.queryByText('Туров пока нет')).toBeNull();
  });

  it('пустой список — «туров нет», с дорогой к созданию', async () => {
    installFetch(OK([]));
    render(<CompletenessClient />);
    await flush();
    expect(screen.getByText('Туров пока нет')).toBeInTheDocument();
    expect(screen.queryByText('Не смог проверить готовность')).toBeNull();
  });
});

// ─── Дизайн-система ─────────────────────────────────────────────────────────

describe('экран свёрстан токенами, без заглушек', () => {
  it('нет text-white, градиентов, хардкода hex и псевдографики', () => {
    expect(UI).not.toMatch(/\btext-white\b/);
    expect(UI).not.toMatch(/bg-gradient/);
    expect(UI).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    expect(UI).not.toMatch(/[✓○●✗]/);
    expect(UI).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it('бейдж витрины — тоже токенами, без хардкода', () => {
    // Бейдж — общий компонент списка туров и этого экрана (#2642); что он
    // рисует ds-badge, держит рендер выше.
    const BADGE = read('components/operator/StorefrontBadge.tsx');
    expect(BADGE).not.toMatch(/\btext-white\b/);
    expect(BADGE).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });

  it('кнопки и карточки — утилиты DS', () => {
    expect(UI).toMatch(/ds-btn ds-btn-primary/);
    expect(UI).toMatch(/ds-btn ds-btn-secondary/);
    expect(UI).toMatch(/className="ds-card/);
  });
});
