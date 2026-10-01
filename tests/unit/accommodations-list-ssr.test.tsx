/**
 * Витрина жилья отдаёт первую страницу сервером (аудит vedarai.ru 01.10).
 *
 * Список собирался только в браузере: в HTML /accommodations не было ни
 * одной ссылки на карточку жилья, и обход сайта не находил их ни с одной
 * страницы. Теперь страница спрашивает тот же обработчик, что и браузер,
 * тем же запросом, а клиент повторно первую страницу не грузит.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/accommodations',
}));
vi.mock('next/image', () => ({
  default: (props: { src: string; alt: string }) => React.createElement('img', { src: props.src, alt: props.alt }),
}));

import { AccommodationsClient, type AccommodationsInitial } from '@/app/accommodations/_AccommodationsClient';
import { ACCOMMODATIONS_FIRST_PAGE_QUERY } from '@/lib/stay/catalog-first-page';

const ACC_ID = '33333333-3333-4333-8333-333333333333';
const INITIAL: AccommodationsInitial = {
  raw: {
    accommodations: [{
      id: ACC_ID,
      name: 'Гостевой дом «У вулкана»',
      type: 'guesthouse',
      description: 'Дом у подножия Авачинского',
      address: 'Елизово',
      starRating: null,
      pricePerNight: { from: 4000, to: null, currency: 'RUB' },
      amenities: [],
      rating: null,
      reviewCount: 0,
      isVerified: true,
      images: [],
    }],
    pagination: { total: 1 },
  },
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('/accommodations: первая страница с сервера', () => {
  it('клиент рисует пришедшее и не спрашивает витрину повторно', () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ authenticated: false }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<AccommodationsClient initial={INITIAL} />);
    expect(screen.getByText('Гостевой дом «У вулкана»')).toBeTruthy();
    expect(container.querySelector(`a[href="/accommodations/${ACC_ID}"]`)).not.toBeNull();
    const asked = fetchMock.mock.calls.map(c => String((c as unknown[])[0]));
    expect(asked.filter(u => u.startsWith('/api/accommodations'))).toEqual([]);
  });

  it('без данных с сервера клиент спрашивает сам тем же запросом', () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { accommodations: [], pagination: { total: 0 } } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<AccommodationsClient initial={null} />);
    const asked = fetchMock.mock.calls.map(c => String((c as unknown[])[0]));
    expect(asked).toContain(`/api/accommodations?${ACCOMMODATIONS_FIRST_PAGE_QUERY}`);
  });

  it('страница читает тот же обработчик, без своего SQL, и не запекается сборкой', () => {
    const page = readFileSync('app/accommodations/page.tsx', 'utf-8');
    expect(page).toMatch(/import \{ GET as getAccommodations \} from '@\/app\/api\/accommodations\/route'/);
    expect(page).toMatch(/ACCOMMODATIONS_FIRST_PAGE_QUERY/);
    expect(page).toMatch(/export const dynamic = 'force-dynamic'/);
    expect(page).not.toMatch(/FROM accommodations/);
    expect(page).toMatch(/<AccommodationsClient initial=\{initial\} \/>/);
  });
});
