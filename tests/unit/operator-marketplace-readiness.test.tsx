/**
 * Кабинет оператора говорит правду о витринах.
 *
 * Третье расхождение, найденное 04.09 (после переписи и лент). Кабинет считал
 * тур полным при описании в ДВАДЦАТЬ знаков, а витрины требуют триста и
 * вдобавок ответ «как турист попадает на тур» и условия отмены. Про эти два
 * поля кабинет не знал вовсе.
 *
 * Значит оператор открывал свою страницу, видел «сто процентов, всё
 * заполнено» — и его тур молча не уходил ни на Авито, ни в Яндекс. Экран,
 * который говорит «готово» там, где не готово, хуже отсутствующего: он не
 * просто молчит о работе, он сообщает, что работы нет.
 *
 * Чинится не новым порогом в кабинете, а общим правилом: судит то же
 * missingFields, которым отбирают ленты. Два правила разошлись бы снова.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, act } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { missingFields, blockerLabel, BLOCKER_LABELS, MIN_DESCRIPTION_CHARS, type ReadinessRow } from '@/lib/tours/readiness';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
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
const API = read('app/api/operator/completeness/route.ts');
// SQL экрана переехал в общий модуль 11.09 (#1794): его текст обязан
// исполняться на настоящем PostgreSQL, а роут его только зовёт.
const SQL = read('lib/operator/screen-queries.ts');

afterEach(cleanup);

describe('кабинет судит тем же правилом, что и витрина', () => {
  it('зовёт общее missingFields, а не свой порог', () => {
    expect(API).toMatch(/from '@\/lib\/tours\/readiness'/);
    expect(API).toMatch(/const marketplaceBlockers = missingFields\(/);
  });

  it('старый порог в двадцать знаков остаётся только для «заполненности карточки»', () => {
    // Он не выкидывается: заполненность карточки — свой, более мягкий вопрос.
    // Но витринную готовность он больше не решает.
    expect(API).toMatch(/tour\.description\.length >= 20/);
    expect(MIN_DESCRIPTION_CHARS).toBe(300);
  });

  it('читает поля витринной готовности из базы', () => {
    for (const col of ['ot.pickup_type', 'pickup_details_chars', 'has_cancellation_policy', 'has_operator_contact']) {
      expect(SQL, `кабинет не читает ${col}`).toContain(col);
    }
    // Роут не держит свой SELECT — иначе pg-тест проверял бы не тот запрос.
    expect(API).toMatch(/COMPLETENESS_TOURS_SQL/);
  });
});

describe('блокеры названы человеческими словами', () => {
  it('оператору говорят, что сделать, а не какого поля нет в базе', () => {
    expect(blockerLabel('pickup')).toMatch(/заберёте, встретите или он едет сам/);
    expect(blockerLabel('description')).toContain(String(MIN_DESCRIPTION_CHARS));
    expect(blockerLabel('operator_contact')).toMatch(/профиле компании/);
  });

  it('у каждого блокера правила есть формулировка', () => {
    const allBlockers: ReadinessRow = {
      id: 1, title: '', operator_id: null, operator_name: null,
      description_chars: 0, photo_count: 0, base_price: null, duration_hours: null,
      pickup_type: null, pickup_details_chars: 0, has_meeting_point: false,
      has_cancellation_policy: false, has_coords: false, has_operator_contact: false,
      included_count: 0, program_steps: 0,
    };
    for (const f of missingFields(allBlockers)) {
      expect(BLOCKER_LABELS[f], `блокер «${f}» показался бы оператору кодовым именем`).toBeTruthy();
    }
  });

  it('незнакомый код показывается как есть, а не прячется', () => {
    expect(blockerLabel('что-то новое')).toBe('что-то новое');
  });
});

/** Ответ API экрана: два тура — один не уходит на витрины, второй готов. */
const SCREEN = {
  success: true,
  data: {
    stats: { totalTours: 2, avgTotalScore: 0, fullyComplete: 0, criticallyIncomplete: 0, publishedTours: 2 },
    tours: [
      {
        tour_id: '51', tour_title: 'Рыбалка', is_active: true, is_published: true, on_storefront: true,
        required_score: 100, recommended_score: 50, total_score: 85,
        missing_required: ['tour_image'], missing_recommended: [],
        marketplace_ready: false,
        marketplace_blockers: [
          { field: 'description', label: blockerLabel('description') },
          { field: 'pickup', label: blockerLabel('pickup') },
        ],
      },
      {
        tour_id: '52', tour_title: 'Вулкан Горелый', is_active: true, is_published: true, on_storefront: true,
        required_score: 100, recommended_score: 100, total_score: 100,
        missing_required: [], missing_recommended: [],
        marketplace_ready: true, marketplace_blockers: [],
      },
    ],
  },
};

describe('экран не говорит «готово» там, где не готово (рендер)', () => {
  it('витрины — отдельной строкой у каждого тура, блокеры словами и до заполненности карточки', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify(SCREEN), { status: 200 }))) as unknown as typeof fetch;
    render(<CompletenessClient />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    // Тур со стознаковым описанием и без ответа о трансфере — не готов, и
    // экран говорит это словами лент, а не процентом.
    expect(screen.getByText('Не уйдёт на Авито и Яндекс — не хватает: 2')).toBeInTheDocument();
    expect(screen.getByText('Готов к выкладке на Авито и Яндекс')).toBeInTheDocument();
    expect(screen.queryByText(/100\s?%/)).toBeNull();

    // Блокеры — те же формулировки, что отдаёт правило (BLOCKER_LABELS).
    const blockers = screen.getByRole('list', { name: 'Чего не хватает: Рыбалка' });
    expect(blockers).toHaveTextContent(blockerLabel('description'));
    expect(blockers).toHaveTextContent(blockerLabel('pickup'));
    // Готовый тур списка блокеров не имеет.
    expect(screen.queryByRole('list', { name: 'Чего не хватает: Вулкан Горелый' })).toBeNull();

    // Блок витрин стоит ПЕРЕД заполненностью карточки: это ответ на вопрос
    // «почему моего тура нет на площадках», и он важнее процента.
    const cardGaps = screen.getByRole('button', { name: /Ещё для карточки на Ведаре/ });
    expect(blockers.compareDocumentPosition(cardGaps) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('тур со стознаковым описанием и без ответа о трансфере — не готов', () => {
    const almost: ReadinessRow = {
      id: 1, title: 'Рыбалка', operator_id: null, operator_name: null,
      description_chars: 100, photo_count: 4, base_price: 25000, duration_hours: 8,
      pickup_type: null, pickup_details_chars: 0, has_meeting_point: false,
      has_cancellation_policy: true, has_coords: true, has_operator_contact: true,
      included_count: 3, program_steps: 2,
    };
    const blockers = missingFields(almost);
    expect(blockers).toContain('description');
    expect(blockers).toContain('pickup');
    // Именно такой тур кабинет раньше показывал как полностью заполненный:
    // 100 знаков больше двадцати.
    expect(almost.description_chars).toBeGreaterThan(20);
  });
});
