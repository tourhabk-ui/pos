/**
 * PlaceMapSheet — описание места не теряется после перехода /map на VedarMap.
 *
 * VedarMap несёт с тапа только id/имя/тип/координаты (описание тапа не
 * бывает — оно живёт на месте, не в GeoJSON-слое), поэтому вызывающий
 * (_MapPageClient) передаёт initialData.description как пустую строку и
 * ждёт, что сам лист догрузит текст из /api/places/[id]. До этой правки
 * fetch-эффект листа разбирал из ответа только photoUrl и routes — поле
 * description из тела ответа выбрасывалось, и текст не появлялся никогда,
 * даже после успешной загрузки. На старой Leaflet-карте бага не было видно:
 * там initialData.description уже нёс текст из allRoutes.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import React from 'react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('next/image', () => ({
  default: (props: { src: string; alt: string }) => React.createElement('img', { src: props.src, alt: props.alt }),
}));

vi.mock('@/hooks/use-wishlist', () => ({
  useWishlist: () => ({ on: false, busy: false, error: null, toggle: vi.fn() }),
}));

import { PlaceMapSheet } from '@/components/map/PlaceMapSheet';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PlaceMapSheet — описание догружается с /api/places/[id]', () => {
  it('тап с VedarMap (description пуст) показывает текст после ответа API', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        success: true,
        data: { photoUrl: null, routes: [], description: 'Вулкан виден с любой точки города.' },
      }),
    }));

    render(
      <PlaceMapSheet
        initialData={{ id: 'p1', title: 'Авачинский', locationType: 'volcano', lat: 53.1, lng: 158.8, description: '' }}
        userPos={null}
        isOffline={false}
        onClose={() => {}}
        distLabel={null}
      />
    );

    expect(screen.queryByText(/Вулкан виден с любой точки города/)).toBeNull();
    await waitFor(() => {
      expect(screen.getByText(/Вулкан виден с любой точки города/)).toBeTruthy();
    });
  });

  it('старая карта (initialData.description уже есть) показывает текст сразу, без ожидания сети', () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));

    render(
      <PlaceMapSheet
        initialData={{ id: 'p2', title: 'Корякская сопка', locationType: 'volcano', lat: 53.3, lng: 158.7, description: 'Действующий вулкан.' }}
        userPos={null}
        isOffline={false}
        onClose={() => {}}
        distLabel={null}
      />
    );

    expect(screen.getByText(/Действующий вулкан/)).toBeTruthy();
  });

  it('офлайн — сеть не зовётся, initialData.description остаётся единственным источником', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    render(
      <PlaceMapSheet
        initialData={{ id: 'p3', title: 'Место без сети', locationType: 'lake', lat: 53.0, lng: 158.0, description: 'Офлайн-описание.' }}
        userPos={null}
        isOffline={true}
        onClose={() => {}}
        distLabel={null}
      />
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/Офлайн-описание/)).toBeTruthy();
  });
});
