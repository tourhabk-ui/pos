'use client';

/**
 * OnSiteBanner — верхняя полоса режима «Я на Камчатке».
 * Показывает район и координаты + офлайн-скачивание + выход из режима.
 * Рендерится на главной когда geo mode === 'on-site'.
 *
 * Полевой скриншот 01.08: правый кластер кнопок не сжимался, и тексту
 * слева оставалось ~90px — «Привет, ты юг Камчатки» ложился столбиком по
 * слову. Теперь слева одна усекаемая строка, справа два компактных
 * действия. Собственной кнопки SOS здесь НЕТ и возвращать нельзя:
 * единственный SOS — в шапке (EmergencyAction, решение владельца #887);
 * копия в баннере уже разошлась поведением с оригиналом (вела на
 * /emergency вместо инлайн-панели) — тот самый класс бага, ради которого
 * дубли SOS запрещены.
 */

import { MapPin, Compass, Download, CheckCircle } from 'lucide-react';
import { useGeo } from '@/contexts/GeoContext';
import { useOfflineRegion } from '@/lib/offline/useOfflineRegion';

export function OnSiteBanner() {
  const { mode, location, region, disableOnSite } = useGeo();
  const { status, progress, download } = useOfflineRegion('avacha-group');

  if (mode !== 'on-site' || !location) return null;

  const coords = `${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}`
    + (location.accuracy < 100 ? ` (±${Math.round(location.accuracy)}м)` : '');

  return (
    <div className="bg-[var(--bg-card)] border-b border-[var(--border)] px-4 py-2">
      <div className="max-w-7xl mx-auto flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-[var(--success)]/15 flex items-center justify-center shrink-0">
          <MapPin className="w-4 h-4 text-[var(--success)]" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[var(--text-primary)] leading-tight truncate">
            {region}
          </p>
          <p className="text-xs text-[var(--text-muted)] truncate">{coords}</p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {status === 'idle' && (
            <button
              onClick={() => void download()}
              className="flex items-center gap-1 px-2.5 min-h-[44px] rounded-lg border border-[var(--border)] text-[var(--text-muted)] text-xs hover:text-[var(--text-primary)] transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Офлайн
            </button>
          )}
          {status === 'caching-tiles' && (
            <span className="text-xs text-[var(--text-muted)]">{progress.percent}%</span>
          )}
          {status === 'cached' && (
            <span className="flex items-center gap-1 text-xs text-[var(--success)]">
              <CheckCircle className="w-3.5 h-3.5" />
              Офлайн
            </span>
          )}
          <button
            onClick={disableOnSite}
            className="flex items-center gap-1 px-2.5 min-h-[44px] rounded-lg border border-[var(--border)] text-[var(--text-muted)] text-xs hover:text-[var(--text-primary)] transition-colors"
          >
            <Compass className="w-3.5 h-3.5" />
            Планирую
          </button>
        </div>
      </div>
    </div>
  );
}
