// @vitest-environment node
/**
 * Карточка места не глушит отказ метаданных и JSON-LD (14.10, §4.0) — вызовом
 * generateMetadata и страницы с падающей базой.
 *
 * Оба пути ловили ошибку пустым `catch`. Метаданные при отказе отдавали общий
 * «Место на Камчатке» без canonical и описания, JSON-LD пропадал целиком —
 * поисковик терял TouristAttraction и крошки. В логе при этом не было ни
 * строки: поломка выглядела как «данных нет». Теперь страница по-прежнему
 * рисуется, но отказ называет себя — имя проверки, место и SQLSTATE.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const query = vi.fn();
vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), cache: <T,>(fn: T) => fn }));
vi.mock('@/lib/database', () => ({ query: (sql: string, params?: unknown[]) => query(sql, params) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('@/app/places/[id]/_PlaceDetailClient', () => ({ default: () => null }));
vi.mock('@/components/places/PlaceSOS', () => ({ default: () => null }));
vi.mock('@/lib/places/aliases', () => ({ resolveMergedTarget: vi.fn(async () => null) }));
vi.mock('@/lib/places/place-detail', () => ({
  loadPlaceDetail: vi.fn(async () => ({ status: 200, body: { data: { name: 'Вулкан Ксудач' } } })),
}));

const ARK = '0f2c8a9e-2222-4c4c-9d9d-000000001410';
const dbDown = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  query.mockReset();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { errSpy.mockRestore(); });

describe('метаданные места: отказ базы назван в логе', () => {
  it('общий заголовок остаётся запасным, но отказ — в логе с SQLSTATE', async () => {
    query.mockRejectedValue(dbDown());
    const { generateMetadata } = await import('@/app/places/[id]/page');
    const meta = await generateMetadata({ params: Promise.resolve({ id: 'vulkan-ksudach' }) });
    expect(meta.title).toBe('Место на Камчатке');
    expect(errSpy).toHaveBeenCalledWith(
      '[places/page] метаданные места не прочитаны:', 'vulkan-ksudach', 'sqlstate=57014',
      'canceling statement due to statement timeout',
    );
  });
});

describe('JSON-LD места: отказ базы назван в логе, страница рисуется', () => {
  it('резолв прошёл, запрос разметки упал — страница отдана, отказ в логе', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT ark_id::text AS ark_id, slug FROM places')) {
        return { rows: [{ ark_id: ARK, slug: 'vulkan-ksudach' }] };
      }
      throw dbDown();
    });
    const { default: PlaceDetailPage } = await import('@/app/places/[id]/page');
    const page = await PlaceDetailPage({ params: Promise.resolve({ id: 'vulkan-ksudach' }) });
    expect(page).toBeTruthy();
    expect(errSpy).toHaveBeenCalledWith(
      '[places/page] JSON-LD места не собран:', 'vulkan-ksudach', 'sqlstate=57014',
      'canceling statement due to statement timeout',
    );
  });

  it('база ответила — строки об отказе нет', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT ark_id::text AS ark_id, slug FROM places')) {
        return { rows: [{ ark_id: ARK, slug: 'vulkan-ksudach' }] };
      }
      return { rows: [] };
    });
    const { default: PlaceDetailPage } = await import('@/app/places/[id]/page');
    await PlaceDetailPage({ params: Promise.resolve({ id: 'vulkan-ksudach' }) });
    expect(errSpy).not.toHaveBeenCalled();
  });
});

describe('проверка слияния места: отказ базы не роняет страницу (#2613)', () => {
  it('резолв слияния упал по таймауту подключения — страница отдана, отказ в логе', async () => {
    const { resolveMergedTarget } = await import('@/lib/places/aliases');
    vi.mocked(resolveMergedTarget).mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'));
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT ark_id::text AS ark_id, slug FROM places')) {
        return { rows: [{ ark_id: ARK, slug: 'vulkan-ksudach' }] };
      }
      return { rows: [] };
    });
    const { default: PlaceDetailPage } = await import('@/app/places/[id]/page');
    const page = await PlaceDetailPage({ params: Promise.resolve({ id: 'vulkan-ksudach' }) });
    expect(page).toBeTruthy();
    expect(errSpy).toHaveBeenCalledWith('[places/page] проверка слияния места не удалась', {
      id: 'vulkan-ksudach',
      message: 'timeout exceeded when trying to connect',
    });
  });
});
