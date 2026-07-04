'use client';

/**
 * MobilePullToRefresh — pull-to-refresh для мобильного дашборда без библиотек:
 * touch-события + Tailwind-транзишены (CLAUDE.md §3 — никаких сторонних
 * анимационных зависимостей).
 *
 * Потянуть вниз от верха страницы > 70px → router.refresh() (перезапрашивает
 * server-данные, в т.ч. баннер тревоги) + remount потомков через key
 * (перезапускает клиентские fetch'и радара/погоды/наблюдений).
 */

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LoaderCircle } from 'lucide-react';

const PULL_THRESHOLD_PX = 70;
const MAX_PULL_PX = 110;
/** Индикатору нужно время исчезнуть после refresh — сколько держим спиннер */
const SPINNER_HOLD_MS = 900;

interface MobilePullToRefreshProps {
  children: React.ReactNode;
}

export function MobilePullToRefresh({ children }: MobilePullToRefreshProps) {
  const router = useRouter();
  const startY = useRef<number | null>(null);
  const [pullPx, setPullPx] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const onTouchStart = (e: React.TouchEvent) => {
    // Жест активен только от самого верха страницы — иначе это обычный скролл
    if (window.scrollY <= 0 && !refreshing) {
      startY.current = e.touches[0].clientY;
    } else {
      startY.current = null;
    }
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (startY.current === null || refreshing) return;
    const delta = e.touches[0].clientY - startY.current;
    if (delta > 0 && window.scrollY <= 0) {
      // Сопротивление: тянется медленнее пальца, как в нативных списках
      setPullPx(Math.min(MAX_PULL_PX, delta * 0.45));
    }
  };

  const onTouchEnd = () => {
    if (startY.current === null) return;
    startY.current = null;
    if (pullPx >= PULL_THRESHOLD_PX && !refreshing) {
      setRefreshing(true);
      setRefreshKey(k => k + 1); // remount потомков → клиентские fetch заново
      router.refresh();          // server-данные (баннер тревоги и т.п.)
      setTimeout(() => {
        setRefreshing(false);
        setPullPx(0);
      }, SPINNER_HOLD_MS);
    } else {
      setPullPx(0);
    }
  };

  const showSpinner = refreshing || pullPx >= PULL_THRESHOLD_PX;

  return (
    <div onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
      {/* Индикатор — раскрывается по мере вытягивания */}
      <div
        aria-hidden={!refreshing}
        className="flex items-center justify-center overflow-hidden transition-all duration-200"
        style={{ height: refreshing ? 48 : pullPx }}
      >
        <LoaderCircle
          size={22}
          strokeWidth={1.5}
          className={showSpinner ? 'animate-spin text-[var(--accent)]' : 'text-[var(--text-muted)]'}
          style={{ opacity: Math.min(1, pullPx / PULL_THRESHOLD_PX) || (refreshing ? 1 : 0) }}
        />
      </div>
      <div key={refreshKey}>{children}</div>
    </div>
  );
}
