/**
 * Имя оператора — ссылка на его страницу везде, где его видит турист
 * (решение владельца 13.10 со снимка блока «Кто проводит»: «я хочу отсюда
 * открывать лендинг, и везде, где есть название оператора, должна быть
 * ссылка на оператора»).
 *
 * Что держит сторож:
 *  - правило адреса одно: operatorPagePath — страница есть у партнёра с
 *    адресом и открытой карточкой, иначе null, и имя остаётся текстом
 *    (ссылка на 404 хуже её отсутствия);
 *  - каждая поверхность из реестра рендерит имя через OperatorNameLink, а не
 *    голым текстом; новая ручная сборка `/operators/${…}` вне реестра
 *    допустимых — красная;
 *  - у каждого источника данных рядом с именем выбраны slug и is_public —
 *    иначе компонент честно покажет текст, и ссылка «молча» исчезнет;
 *  - там, где карточка целиком была ссылкой на тур, ссылка на тур стала
 *    слоем под содержимым, а имя оператора — своей ссылкой поверх: <a> в <a>
 *    недопустим (проверено рендером, не только по исходнику);
 *  - на телефонной главной у ссылки тач-зона 44px (правило home-hitboxes).
 *
 * Хвост (владелец 13.10, «улучши»): планы /plans и /trip, модалка операторов
 * планера, /fish/[id], «Туры проводят» на /hub/fishing (и адрес оператора в
 * JSON-LD только у открытой карточки), карточки туров в чатах Кузьмича и
 * ИИ-помощника, строка «Журнал» на главной. Там же, где карточка была ссылкой
 * на тур целиком, — слой-ссылка, имя оператора — своей ссылкой поверх.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { operatorPagePath } from '@/lib/operators/page-link';
import { OperatorNameLink } from '@/components/operators/OperatorNameLink';
import PlaceTours from '@/components/places/PlaceTours';
import { ToursForQuery } from '@/components/search/ToursForQuery';
import { FishingPageClient } from '@/app/hub/fishing/_FishingPageClient';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
/** Без комментариев: упоминание старой формы в комментарии — не рендер. */
const code = (p: string) => read(p).replace(/\{\/\*[\s\S]*?\*\/\}|\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');

afterEach(cleanup);

describe('operatorPagePath — одно правило адреса', () => {
  it('страница есть только у открытой карточки с адресом', () => {
    expect(operatorPagePath({ slug: 'mestechko', is_public: true })).toBe('/operators/mestechko');
    expect(operatorPagePath({ slug: 'mestechko', is_public: false })).toBeNull();
    expect(operatorPagePath({ slug: 'mestechko', is_public: null })).toBeNull();
    expect(operatorPagePath({ slug: 'mestechko' })).toBeNull();
    expect(operatorPagePath({ slug: null, is_public: true })).toBeNull();
    expect(operatorPagePath({ slug: '  ', is_public: true })).toBeNull();
  });
});

describe('OperatorNameLink — ссылка или текст', () => {
  it('открытая карточка → ссылка на /operators/<slug>; закрытая → то же имя текстом', () => {
    const a = render(<OperatorNameLink name="Местечко Камчатка" slug="mestechko" isPublic />);
    const link = a.container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/operators/mestechko');
    expect(link?.textContent).toBe('Местечко Камчатка');
    cleanup();
    const b = render(<OperatorNameLink name="Местечко Камчатка" slug="mestechko" isPublic={false} />);
    expect(b.container.querySelector('a')).toBeNull();
    expect(b.container.textContent).toBe('Местечко Камчатка');
  });
});

/** Поверхности, где турист видит имя оператора: файл и голая форма, которой больше быть не должно. */
const SURFACES: Array<{ file: string; bare: RegExp }> = [
  { file: 'app/catalog/tours/[id]/_TourDetailClient.tsx', bare: />\{tour\.operator_name\}</ },
  { file: 'components/marketplace/MarketplaceClient.tsx', bare: /^\s*\{tour\.operator_name\}\s*$/m },
  { file: 'components/search/ToursForQuery.tsx', bare: /t\.operator_name\]\.filter/ },
  { file: 'components/places/PlaceTours.tsx', bare: /<span>\{t\.operatorName\}<\/span>/ },
  { file: 'app/_home/_HomeV8Client.tsx', bare: /\[pf\.duration, pf\.operator\]/ },
  { file: 'components/homepage/desk/DeskTours.tsx', bare: /f\.operator\]\.filter/ },
  { file: 'app/routes/[id]/_RouteDetailClient.tsx', bare: />\{offer\.operator\.name\}</ },
  { file: 'app/booking-success/[id]/_BookingSuccessClient.tsx', bare: />\{booking\.operator_name\}</ },
  { file: 'app/calendar/_CalendarClient.tsx', bare: /^\s*\{tour\.operator\.name\}\s*$/m },
  // Хвост 13.10.
  { file: 'app/plans/[slug]/page.tsx', bare: /\{tour\.title\} · \{tour\.operator_name\}/ },
  { file: 'app/trip/[token]/_TripShareClient.tsx', bare: /^\s*\{tour\.operator_name\}\s*$/m },
  { file: 'app/fish/[id]/page.tsx', bare: /^\s*\{tour\.operator_name\}\s*$/m },
  { file: 'app/hub/fishing/_FishingPageClient.tsx', bare: /operators\.join\(', '\)/ },
  { file: 'app/kuzmich/_KuzmichClient.tsx', bare: /">\{tour\.operator_name\}<\/p>/ },
  { file: 'app/ai-assistant/_AIAssistantClient.tsx', bare: /">\{tour\.operator_name\}<\/p>/ },
  { file: 'app/_home/_HomeV8Client.tsx', bare: /<span className="t">\{feed\[0\]\.text\}|· \{feed\[0\]\.operatorName\}/ },
  { file: 'app/planner/_PlannerClient.tsx', bare: /">\{p\.name\}<\/p>/ },
];

describe('поверхности с именем оператора', () => {
  it.each(SURFACES)('$file: имя — через OperatorNameLink, не голым текстом', ({ file, bare }) => {
    const src = code(file);
    expect(src).toMatch(/<OperatorNameLink name=\{/);
    expect(src).not.toMatch(bare);
  });

  it('ручная сборка `/operators/${…}` на туристских поверхностях — только в реестре', () => {
    // Список операторов и карточка перевозчика строят адрес из своей выборки,
    // где гейт is_public уже стоит (lib/operators/list-query, lib/transfers/
    // charter). Новое место — через operatorPagePath.
    const allowed = new Set(['app/operators/_OperatorsClient.tsx', 'components/transfers/CharterCard.tsx']);
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execSync("grep -rln '`/operators/\\${' app components --include=*.tsx --include=*.ts || true", { cwd: ROOT, encoding: 'utf-8' });
    const files = out.split('\n').filter(Boolean).filter((f) => !f.startsWith('app/hub/'));
    expect(files.filter((f) => !allowed.has(f))).toEqual([]);
    expect(code('app/routes/[id]/_RouteDetailClient.tsx')).toMatch(/operatorPagePath\(\{ slug: first\.operator\.slug, is_public: first\.operator\.isPublic \}\)/);
  });

  it('на телефонной главной у ссылки тач-зона 44px без сдвига строки', () => {
    expect(code('app/_home/_HomeV8Client.tsx')).toMatch(/<OperatorNameLink name=\{pf\.operator\}[^>]*className="inline-block py-\[15px\] -my-\[15px\]"/);
  });

  it('на странице оператора бейдж категории — словом, не ключом (prod-check 117)', () => {
    expect(code('app/operators/[slug]/page.tsx')).toMatch(/operator: 'Туроператор'/);
  });
});

describe('источники данных отдают slug и is_public рядом с именем', () => {
  it.each([
    ['lib/search/tour-search.ts', /p\.slug as operator_slug,\s*p\.is_public as operator_public/],
    ['lib/tours/tour-detail-query.ts', /p\.slug AS operator_slug, p\.is_public AS operator_public/],
    ['app/_home/data.ts', /p\.slug AS operator_slug, p\.is_public AS operator_public/],
    ['lib/places/place-detail.ts', /p\.slug AS operator_slug, p\.is_public AS operator_public/],
    ['app/api/availability/day/route.ts', /p\.is_public\s+AS operator_public/],
    ['app/api/hub/bookings/[id]/route.ts', /p\.is_public\s+AS operator_public/],
    ['lib/routes/route-detail.ts', /JOIN partners p ON p\.id = v\.operator_id[\s\S]*?p\.is_public AS operator_public|p\.is_public AS operator_public[\s\S]*?JOIN partners p ON p\.id = v\.operator_id/],
    // Хвост 13.10.
    ['app/fish/[id]/page.tsx', /p\.slug AS operator_slug, p\.is_public AS operator_public/],
    ['app/hub/fishing/page.tsx', /p\.slug AS operator_slug, p\.is_public AS operator_public/],
    ['app/_home/data.ts', /p\.slug AS operator_slug, p\.is_public AS operator_public, ob\.created_at::text/],
    ['app/api/planner/partners/route.ts', /p\.slug,\s*p\.is_public,/],
  ])('%s', (file, re) => {
    expect(read(file)).toMatch(re);
  });

  it('у резолверов с двумя SELECT поля стоят в обоих: туры плана и подсказки чата', () => {
    for (const file of ['lib/tours/top-tour-by-activity.ts', 'lib/ai/booking-intent.ts']) {
      const n = (read(file).match(/p\.slug AS operator_slug, p\.is_public AS operator_public/g) ?? []).length;
      expect(n, `${file}: slug и is_public в каждом SELECT`).toBe(2);
    }
  });

  it('кэш страницы плана сменил ключ вместе с формой строки тура', () => {
    expect(read('app/plans/[slug]/page.tsx')).toMatch(/\['plan-preset-v2'\]/);
  });

  // Адрес оператора в JSON-LD рыбалки только у открытой карточки — проверяется
  // вызовом страницы на строках «из базы» (tests/unit/fishing-jsonld.test.ts),
  // а не литералом исходника (правило 13.10). Здесь — только запрет ручной сборки.
  it('JSON-LD рыбалки не собирает адрес оператора руками', () => {
    expect(code('app/hub/fishing/page.tsx')).not.toMatch(/\/operators\/\$\{/);
  });

  it('витрина: смена формы строки — смена ключа кэша', () => {
    expect(read('lib/search/tour-search.ts')).toMatch(/\['marketplace-tours-query-v3', JSON\.stringify\(filters\)\]/);
  });

  it('«Туры по запросу»: страница копирует slug и is_public в блок', () => {
    const page = read('app/routes/(list)/page.tsx');
    expect(page).toMatch(/operator_slug: t\.operator_slug,\s*operator_public: t\.operator_public,/);
  });
});

describe('карточка-ссылка на тур: имя оператора — своя ссылка, <a> в <a> нет', () => {
  const tour = { id: '53', slug: 'mestechko-halaktyrskiy-plyazh', title: 'Халактырский пляж', basePrice: 7000, durationDays: null, operatorName: 'Местечко Камчатка', operatorSlug: 'mestechko', operatorPublic: true };

  it('PlaceTours: две ссылки — тур слоем и оператор поверх; закрытый оператор — одна', () => {
    const { container } = render(<PlaceTours tours={[tour]} />);
    const links = [...container.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/catalog/tours/mestechko-halaktyrskiy-plyazh', '/operators/mestechko']);
    expect(container.querySelectorAll('a a')).toHaveLength(0);
    cleanup();
    const closed = render(<PlaceTours tours={[{ ...tour, operatorPublic: false }]} />);
    expect([...closed.container.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/catalog/tours/mestechko-halaktyrskiy-plyazh']);
    expect(closed.container.textContent).toContain('Местечко Камчатка');
  });

  it('ToursForQuery: то же — тур слоем, оператор своей ссылкой', () => {
    const { container } = render(
      <ToursForQuery q="пляж" state={{ status: 'ok', tours: [{ id: 53, slug: 'mestechko-halaktyrskiy-plyazh', title: 'Халактырский пляж', operator_name: 'Местечко Камчатка', operator_slug: 'mestechko', operator_public: true, activity_type: 'jeep_safari', base_price: 7000 }] }} />,
    );
    const hrefs = [...container.querySelectorAll('li a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/catalog/tours/mestechko-halaktyrskiy-plyazh', '/operators/mestechko']);
    expect(container.querySelectorAll('a a')).toHaveLength(0);
  });

  it('«Туры проводят» на странице рыбалки: открытый оператор — ссылкой, закрытый — текстом, без дублей', () => {
    const base = {
      id: 1, slug: 't', title: 'Рыбалка', short_description: null, description: null, base_price: 25000,
      duration_hours: 10, max_participants: 8, min_participants: 1, difficulty: null, photos: [], included: null,
      season_start: null, season_end: null, operator_name: 'Камчатская рыбалка', operator_slug: 'fishingkam', operator_public: true,
    };
    const { container } = render(<FishingPageClient tours={[
      base,
      { ...base, id: 2, slug: 'u', title: 'Ещё рыбалка' },
      { ...base, id: 3, slug: 'v', title: 'Закрытый', operator_name: 'Тихий оператор', operator_slug: 'tihiy', operator_public: false },
    ]} />);
    const sentence = [...container.querySelectorAll('p')].find((p) => p.textContent?.startsWith('Туры проводят:'));
    expect(sentence).toBeDefined();
    expect(sentence?.textContent).toMatch(/^Туры проводят: Камчатская рыбалка, Тихий оператор\./);
    const links = [...sentence!.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([['Камчатская рыбалка', '/operators/fishingkam']]);
  });

  it('DeskTours: ссылка на тур — слоем, содержимое поверх, вложенного <Link> нет', () => {
    const src = code('components/homepage/desk/DeskTours.tsx');
    expect(src.match(/className="absolute inset-0 z-\[1\]/g)?.length).toBe(2);
    expect(src).not.toMatch(/<Link\s+href=\{tourPath\(p\)\}\s+className="group/);
    expect(src.match(/pointer-events-none/g)?.length).toBe(2);
  });
});
