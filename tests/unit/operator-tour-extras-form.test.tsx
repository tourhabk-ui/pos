/**
 * Форма тура оператора — программа, правила безопасности, видео, подпись
 * снимков и «Как видит турист» (08.11), рендером страницы редактора.
 *
 * Блоки взяты из кабинета гида (components/guide/OwnTourExtras). Своё правило
 * у оператора одно: в правку уходит только то, что он поменял, — тур из
 * миграции с программой, которой форма раньше не касалась, сохраняет цену,
 * не пересылая чужие старые данные.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ id: '51' }),
}));

import EditTourClient from '@/app/hub/operator/tours/[id]/_EditTourClient';

const CLIP = {
  key: 'videos/mestechko/clip-kurilskoe.mp4', poster: 'videos/mestechko/clip-kurilskoe.poster.jpg', label: 'Над озером',
  url: 'https://s3.test/b/videos/mestechko/clip-kurilskoe.mp4', posterUrl: 'https://s3.test/b/videos/mestechko/clip-kurilskoe.poster.jpg',
};

const TOUR = {
  id: '51', title: 'Курильское озеро (вертолёт)', short_description: null, description: null,
  location_type: 'lake', activity_type: 'helicopter', location_name: 'Курильское озеро',
  latitude: null, longitude: null, base_price: 180000, price_old: null, price_unit: 'per_person',
  max_participants: 20, min_participants: null, duration_hours: 10, duration_type: 'day', multi_day_count: null,
  season_start: null, season_end: null, seasonal_only: false, difficulty: null, weather_dependent: true,
  is_active: true, is_published: true, included: [], not_included: [], what_to_bring: [],
  cancellation_policy: null, pickup_type: null, pickup_details: null,
  photos: ['/images/tours/a.jpg', '/images/tours/b.jpg'], tour_image: null,
  program: [{ title: 'День 1. Вылет из Елизова', text: 'Сбор в 08:00.' }],
  safety_notes: ['Слушать пилота'],
  video_clips: [CLIP],
  photo_credits: { '/images/tours/a.jpg': 'Местечко Камчатка' },
  on_storefront: true,
};

let patchBodies: Array<Record<string, unknown>>;
let gets: number;

function mockFetch(tour: Record<string, unknown>, after?: Record<string, unknown>) {
  patchBodies = [];
  gets = 0;
  globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (init?.method === 'PATCH') {
      patchBodies.push(JSON.parse(String(init.body)));
      return json({ success: true, data: { id: '51' } });
    }
    if (u.includes('/availability')) return json({ success: true, data: [] });
    gets += 1;
    return json({ success: true, data: gets > 1 && after ? { ...tour, ...after } : tour });
  }) as unknown as typeof fetch;
}

const save = async () => {
  fireEvent.click(screen.getAllByText('Сохранить')[0]);
  await waitFor(() => expect(patchBodies.length).toBe(1));
  return patchBodies[0];
};

beforeEach(() => vi.restoreAllMocks());

describe('форма тура оператора: что видно', () => {
  it('программа, правила, видео и подписи снимков — из тура; ссылка на карточку', async () => {
    mockFetch(TOUR);
    render(<EditTourClient />);
    expect(await screen.findByDisplayValue('День 1. Вылет из Елизова')).toBeTruthy();
    expect(screen.getByLabelText('Шаг 1 — что происходит')).toHaveProperty('value', 'Сбор в 08:00.');
    expect(screen.getByLabelText('Правила безопасности тура — по одному пункту на строке')).toHaveProperty('value', 'Слушать пилота');
    expect(screen.getByLabelText('Подпись видео 1')).toHaveProperty('value', 'Над озером');
    expect(screen.getByText('Видео (1)')).toBeTruthy();
    expect(screen.getByText('Фото: Местечко Камчатка')).toBeTruthy();
    expect(screen.getByText('Без подписи')).toBeTruthy();
    expect(screen.getByTestId('op-tour-credit-state').textContent).toBe('Без подписи: 1 из 2. Уже подписанные не меняются.');
    const link = screen.getByRole('link', { name: /Как видит турист/ });
    expect(link.getAttribute('href')).toBe('/catalog/tours/51');
  });

  it('тур не на витрине — ссылки на карточку нет, сказано словами', async () => {
    mockFetch({ ...TOUR, on_storefront: false });
    render(<EditTourClient />);
    expect(await screen.findByText(/Туристы тур пока не видят/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Как видит турист/ })).toBeNull();
  });

  it('у тура без программы и видео — честная пустота, не заглушка', async () => {
    mockFetch({ ...TOUR, program: null, safety_notes: null, video_clips: [] });
    render(<EditTourClient />);
    expect(await screen.findByText('Программа не записана.')).toBeTruthy();
    expect(screen.getByText('Видео нет.')).toBeTruthy();
    expect(screen.getByText('Видео (0)')).toBeTruthy();
  });
});

describe('форма тура оператора: что уходит в правку', () => {
  it('ничего из этих блоков не тронуто — их полей в правке нет', async () => {
    mockFetch(TOUR);
    render(<EditTourClient />);
    await screen.findByDisplayValue('День 1. Вылет из Елизова');
    const body = await save();
    for (const k of ['program', 'safety_notes', 'video_clips', 'photo_credit']) expect(body, k).not.toHaveProperty(k);
    expect(body.base_price).toBe(180000);
  });

  it('правка программы и правил, подпись снимков — уходят; видео не тронуто — нет', async () => {
    mockFetch(TOUR, { photo_credits: { '/images/tours/a.jpg': 'Местечко Камчатка', '/images/tours/b.jpg': 'Иван Петров' } });
    render(<EditTourClient />);
    const title = await screen.findByDisplayValue('День 1. Вылет из Елизова');
    fireEvent.change(title, { target: { value: 'День 1. Вылет и облёт кальдеры' } });
    fireEvent.change(screen.getByLabelText('Правила безопасности тура — по одному пункту на строке'),
      { target: { value: 'Слушать пилота\n\nНе подходить к лопастям ' } });
    fireEvent.change(screen.getByLabelText(/Чьи снимки/), { target: { value: 'Иван Петров' } });
    expect(screen.getByTestId('op-tour-credit-state').textContent).toMatch(/После «Сохранить» им встанет «Фото: Иван Петров»/);
    const body = await save();
    expect(body.program).toEqual([{ title: 'День 1. Вылет и облёт кальдеры', text: 'Сбор в 08:00.' }]);
    expect(body.safety_notes).toEqual(['Слушать пилота', 'Не подходить к лопастям']);
    expect(body.photo_credit).toBe('Иван Петров');
    expect(body).not.toHaveProperty('video_clips');
    // После записи подписи — с сервера: второй снимок подписан.
    expect(await screen.findByText('Фото: Иван Петров')).toBeTruthy();
    expect(screen.queryByText('Без подписи')).toBeNull();
  });

  it('после записи изменённое становится загруженным: второе «Сохранить» его не пересылает', async () => {
    mockFetch(TOUR);
    render(<EditTourClient />);
    fireEvent.change(await screen.findByDisplayValue('День 1. Вылет из Елизова'), { target: { value: 'День 1. Вылет' } });
    expect((await save()).program).toEqual([{ title: 'День 1. Вылет', text: 'Сбор в 08:00.' }]);
    await waitFor(() => expect(gets).toBe(2));
    fireEvent.click(screen.getAllByText('Сохранить')[0]);
    await waitFor(() => expect(patchBodies.length).toBe(2));
    expect(patchBodies[1]).not.toHaveProperty('program');
  });

  it('видео убрано — уходит пустой список; правила стёрты — null', async () => {
    mockFetch(TOUR);
    render(<EditTourClient />);
    fireEvent.click(await screen.findByLabelText('Убрать видео 1'));
    fireEvent.change(screen.getByLabelText('Правила безопасности тура — по одному пункту на строке'), { target: { value: '  \n' } });
    const body = await save();
    expect(body.video_clips).toEqual([]);
    expect(body.safety_notes).toBeNull();
  });

  it('новый шаг программы и подпись видео — в правке', async () => {
    mockFetch({ ...TOUR, program: null });
    render(<EditTourClient />);
    fireEvent.click(await screen.findByText('Добавить шаг'));
    fireEvent.change(screen.getByLabelText('Шаг 1 — название'), { target: { value: 'Вылет' } });
    fireEvent.change(screen.getByLabelText('Подпись видео 1'), { target: { value: 'Над кальдерой' } });
    const body = await save();
    expect(body.program).toEqual([{ title: 'Вылет', text: '' }]);
    expect(body.video_clips).toEqual([{ key: CLIP.key, poster: CLIP.poster, label: 'Над кальдерой' }]);
  });

  it('фото больше двадцати — сказано, чего не хватает, правка не уходит', async () => {
    mockFetch({ ...TOUR, photos: Array.from({ length: 21 }, (_, i) => `/images/tours/p${i}.jpg`) });
    render(<EditTourClient />);
    await screen.findByDisplayValue('День 1. Вылет из Елизова');
    fireEvent.click(screen.getAllByText('Сохранить')[0]);
    expect(await screen.findByText('Чтобы сохранить, не хватает: фото — не больше 20.')).toBeTruthy();
    expect(patchBodies).toEqual([]);
  });
});
