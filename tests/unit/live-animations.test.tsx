// @vitest-environment jsdom
/**
 * Пять анимаций обстановки (12.11, выбор владельца «Все пять»): пульс и
 * возраст радара, кольцо офлайн-скачивания с галочкой, подсветка нового
 * предупреждения, плавный цвет KVERT, переезжающая плашка нижнего меню.
 *
 * Сторож судит то, что видит человек, и честность движения:
 * - пульс только у свежих данных, у «нет данных» точки нет;
 * - возраст идёт сам от настоящей метки, а не замирает;
 * - кольцо — настоящая доля, «Можно без сети» — только после полного
 *   скачивания в этой сессии, у частичного галочки нет;
 * - «новое» — то, чего этот браузер не показывал; в первый визит подсветки нет;
 * - плашка встаёт по нажатию, но не по отменённому переходу.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { LiveFreshnessDot } from '@/components/ui/LiveFreshnessDot';
import { ProgressRing } from '@/components/ui/ProgressRing';
import { useNow } from '@/hooks/use-now';
import { dataFreshness, freshnessShort } from '@/lib/home/data-freshness';
import { alertKey, newAlertKeys, nextSeen, SEEN_ALERTS_KEY, SEEN_ALERTS_CAP } from '@/lib/safety/new-alerts';
import { AlertsTicker } from '@/components/safety/LiveStatus';
import BottomNav, { activeNavIndex } from '@/components/shared/BottomNav';
import type { SafetyAlert } from '@/app/_home/data';
import type { UseOfflineRegionReturn } from '@/lib/offline/useOfflineRegion';

vi.mock('next/link', () => ({
  default: ({ href, children, onClick, ...rest }: { href: string; children: React.ReactNode; onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void }) => (
    <a href={href} {...rest} onClick={(e) => { onClick?.(e); e.preventDefault(); }}>{children}</a>
  ),
}));

let region: UseOfflineRegionReturn;
vi.mock('@/lib/offline/useOfflineRegion', () => ({ useOfflineRegion: () => region }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  try { window.localStorage.clear(); } catch { /* jsdom */ }
});

describe('радар: пульс и возраст', () => {
  it('пульс только у свежих; устаревшие стоят; «нет данных» — без точки', () => {
    const { container, rerender } = render(<LiveFreshnessDot state="fresh" />);
    expect(container.querySelector('[data-freshness="fresh"]')).toHaveAttribute('data-pulse', 'on');
    rerender(<LiveFreshnessDot state="stale" />);
    expect(container.querySelector('[data-freshness="stale"]')).toHaveAttribute('data-pulse', 'off');
    expect((container.querySelector('[data-freshness="stale"]') as HTMLElement).style.background).toBe('var(--warning)');
    rerender(<LiveFreshnessDot state="unavailable" />);
    const none = container.querySelector('[data-freshness="unavailable"]') as HTMLElement;
    expect(none).not.toHaveAttribute('data-pulse');
    expect(none.style.background).toBe('var(--bg-card)');
  });

  it('возраст идёт сам от метки источника', () => {
    vi.useFakeTimers();
    const start = new Date('2026-11-12T10:00:00Z');
    vi.setSystemTime(start);
    const updatedAt = '2026-11-12T09:57:00Z';
    function Age() {
      const now = useNow(30_000);
      return <span>{freshnessShort(dataFreshness({ updatedAt, source: 'safety', now }))}</span>;
    }
    render(<Age />);
    expect(screen.getByText('3 мин назад')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(120_000); });
    expect(screen.getByText('5 мин назад')).toBeInTheDocument();
  });
});

describe('офлайн: кольцо и галочка', () => {
  const base = (over: Partial<UseOfflineRegionReturn>): UseOfflineRegionReturn => ({
    status: 'idle', progress: { done: 0, failed: 0, total: 0, percent: 0 }, regionMeta: null, error: null,
    download: async () => {}, remove: async () => {}, ...over,
  });
  const meta = { regionId: 'avacha-group', downloadedAt: Date.parse('2026-11-12T10:00:00Z'), routesCount: 41, tilesCount: 900 } as unknown as UseOfflineRegionReturn['regionMeta'];

  it('кольцо — настоящая доля; пока доля неизвестна, оно пустое', () => {
    const { container, rerender } = render(<ProgressRing percent={40} label="Скачано 40%" />);
    expect(screen.getByRole('progressbar', { name: 'Скачано 40%' })).toHaveAttribute('aria-valuenow', '40');
    const arc = container.querySelector('[data-ring-arc]') as SVGCircleElement;
    const c = Number(arc.getAttribute('stroke-dasharray'));
    expect(Number(arc.getAttribute('stroke-dashoffset'))).toBeCloseTo(c * 0.6, 3);
    rerender(<ProgressRing percent={null} label="Готовим" />);
    expect(screen.getByRole('progressbar', { name: 'Готовим' })).not.toHaveAttribute('aria-valuenow');
    expect(Number(arc.getAttribute('stroke-dashoffset'))).toBeCloseTo(c, 3);
  });

  it('«Можно без сети» — после полного скачивания в этой сессии, не у частичного', async () => {
    const { default: RegionCard } = await import('@/components/Offline/RegionCard');
    const { REGIONS } = await import('@/lib/geo/regions');
    region = base({ status: 'caching-tiles', progress: { done: 40, failed: 0, total: 100, percent: 40 } });
    const { rerender } = render(<RegionCard region={REGIONS['avacha-group']} />);
    expect(screen.getByRole('progressbar', { name: 'Скачано 40%' })).toBeInTheDocument();
    expect(screen.queryByText('Можно без сети')).toBeNull();

    region = base({ status: 'cached', regionMeta: meta });
    rerender(<RegionCard region={REGIONS['avacha-group']} />);
    expect(screen.getByRole('status')).toHaveTextContent('Можно без сети');
    cleanup();

    region = base({ status: 'caching-tiles', progress: { done: 90, failed: 10, total: 100, percent: 100 } });
    const r2 = render(<RegionCard region={REGIONS['avacha-group']} />);
    region = base({ status: 'partial', regionMeta: meta });
    r2.rerender(<RegionCard region={REGIONS['avacha-group']} />);
    expect(screen.queryByText('Можно без сети')).toBeNull();
    cleanup();

    // Открыли страницу с уже скачанным регионом — галочке не за что.
    region = base({ status: 'cached', regionMeta: meta });
    render(<RegionCard region={REGIONS['avacha-group']} />);
    expect(screen.queryByText('Можно без сети')).toBeNull();
  });
});

describe('перед выходом: новое предупреждение', () => {
  const a = (title: string, at: string): SafetyAlert => ({ title, description: null, type: null, severity: 1, at, until: null, manual: false, basis: null });

  it('первый визит — нового нет; потом новое — то, чего не показывали', () => {
    expect(newAlertKeys(['x'], null).size).toBe(0);
    expect([...newAlertKeys(['x', 'y'], ['x'])]).toEqual(['y']);
    expect(nextSeen(['y'], ['x', 'y'])).toEqual(['y', 'x']);
    expect(nextSeen([], Array.from({ length: 300 }, (_, i) => `k${i}`))).toHaveLength(SEEN_ALERTS_CAP);
  });

  it('лента подсвечивает новое один раз и запоминает показанное', async () => {
    const old = a('Паводок на реке', '2026-11-11T08:00:00Z');
    const fresh = a('Камнепад на перевале', '2026-11-12T09:00:00Z');
    window.localStorage.setItem(SEEN_ALERTS_KEY, JSON.stringify([alertKey(old)]));
    const { container } = render(<AlertsTicker alerts={[fresh, old]} />);
    await waitFor(() => expect(container.querySelectorAll('li[data-new="true"]')).toHaveLength(1));
    expect(container.querySelector('li[data-new="true"]')).toHaveTextContent('Камнепад на перевале');
    expect(JSON.parse(window.localStorage.getItem(SEEN_ALERTS_KEY) ?? '[]')).toContain(alertKey(fresh));
    cleanup();

    // Второй показ того же — без подсветки.
    const again = render(<AlertsTicker alerts={[fresh, old]} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(again.container.querySelectorAll('li[data-new="true"]')).toHaveLength(0);
  });

  it('первый визит — ничего не подсвечено', async () => {
    const { container } = render(<AlertsTicker alerts={[a('Паводок', '2026-11-11T08:00:00Z')]} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelectorAll('li[data-new="true"]')).toHaveLength(0);
    expect(window.localStorage.getItem(SEEN_ALERTS_KEY)).not.toBeNull();
  });
});

describe('нижнее меню: плашка', () => {
  beforeEach(() => { vi.stubGlobal('ResizeObserver', undefined); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('одна плашка встаёт под пункт адреса и переезжает по нажатию', () => {
    expect(activeNavIndex('/')).toBe(0);
    expect(activeNavIndex('/ai-assistant')).toBe(2);
    expect(activeNavIndex('/about')).toBe(-1);
    const { container } = render(<BottomNav activePath="/" />);
    expect(container.querySelectorAll('[data-nav-plaque]')).toHaveLength(1);
    expect(container.querySelector('[data-nav-plaque]')).toHaveAttribute('data-nav-plaque', '0');
    fireEvent.click(screen.getByRole('link', { name: 'Туры' }));
    expect(container.querySelector('[data-nav-plaque]')).toHaveAttribute('data-nav-plaque', '3');
    expect((container.querySelector('[data-nav-plaque]') as HTMLElement).style.transform).toBe('translateX(300%)');
  });

  it('отменённый переход плашку не двигает; на чужом адресе её нет', () => {
    const { container } = render(<BottomNav activePath="/map" onNavClick={(e) => e.preventDefault()} />);
    fireEvent.click(screen.getByRole('link', { name: 'Туры' }));
    expect(container.querySelector('[data-nav-plaque]')).toHaveAttribute('data-nav-plaque', '1');
    cleanup();
    const other = render(<BottomNav activePath="/about" />);
    expect(other.container.querySelector('[data-nav-plaque]')).toBeNull();
  });
});
