/**
 * Страница поездки по ссылке — для тех, кому ссылку дали, а не для поисковиков
 * (#3347, 14.11).
 *
 * В карточке поездки ссылка названа «ссылкой для близких», а метаданные
 * опубликованной страницы индексацию не закрывали: план чужой поездки с датами
 * мог попасть в выдачу. Закрыт был только черновик Кузьмича.
 *
 * Проверка — вызовом generateMetadata на подменённом ответе share-API.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let REPLY: { status: number; body: unknown } = { status: 404, body: { success: false } };
vi.mock('@/app/api/trips/share/[token]/route', () => ({
  GET: vi.fn(async () => new Response(JSON.stringify(REPLY.body), { status: REPLY.status, headers: { 'content-type': 'application/json' } })),
}));
// React.cache в тестовой среде отсутствует как серверная функция — подменяем
// тождественной обёрткой: кэш на запрос здесь не проверяется.
vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof import('react')>()), cache: <T,>(f: T) => f }));

import { generateMetadata } from '@/app/trip/[token]/page';

const trip = (source: string) => ({
  success: true,
  data: { id: 't', title: 'Маршрут 20.07', source, arrival_date: '2027-07-20', departure_date: '2027-07-26', days: [{}, {}, {}] },
});
const meta = (token = 'abc') => generateMetadata({ params: Promise.resolve({ token }) });

beforeEach(() => { REPLY = { status: 404, body: { success: false } }; });

describe('страница /trip/<токен> закрыта от поисковиков при любом исходе', () => {
  it('опубликованная поездка: индексация закрыта, превью для мессенджера остаётся', async () => {
    REPLY = { status: 200, body: trip('planner') };
    const m = await meta();
    expect(m.robots).toEqual({ index: false, follow: false });
    expect(m.title).toContain('Маршрут 20.07');
    expect(m.openGraph).toBeDefined();
  });

  it('черновик Кузьмича закрыт, как и раньше', async () => {
    REPLY = { status: 200, body: trip('draft') };
    expect((await meta()).robots).toEqual({ index: false, follow: false });
  });

  it('плана нет или он не прочитался — тоже не в индекс', async () => {
    expect((await meta()).robots).toMatchObject({ index: false });
    REPLY = { status: 503, body: { success: false } };
    expect((await meta()).robots).toMatchObject({ index: false });
  });
});
