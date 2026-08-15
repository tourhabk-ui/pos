'use client';

/**
 * Карточка доверия: почему данным на экране можно (или нельзя) верить.
 *
 * Одна строка сути + раскрытие «Показать качество данных»: род линии и её
 * источник, состояние полевого пакета по ассетам, качество фикса. Это
 * data-trust-engine v0 из плана FCN — сборка уже существующих фактов в одно
 * объяснение, а не новая оценка.
 *
 * Карточка — контекст, не действие: спокойный фон, никаких кнопок опасного
 * рода. Слова важнее вида: «линия проверена» пишется только про снятый
 * трек, набросок называется наброском.
 */

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { TrackFidelity } from '@/lib/routes/track-fidelity';
import type { PackAssetState } from '@/lib/offline/field-pack';

export interface TrustCardProps {
  fidelity: TrackFidelity;
  /** Записанный источник линии; null — не записан; undefined — не спрошен. */
  geometrySource: string | null | undefined;
  hasTrack: boolean;
  /** Линия и точки маршрута расходятся (dataConflict). */
  conflict: boolean;
  packStates: PackAssetState[] | null;
  packReadiness: 'ready' | 'partial' | 'not_ready' | null;
  /** Человеческая строка качества фикса, например «GPS ±8 м». */
  fixLabel: string | null;
}

const KIND_LABELS: Record<PackAssetState['kind'], string> = {
  tiles: 'Карта',
  route: 'Линия',
  waypoints: 'Точки',
  safety_snapshot: 'Условия',
};

function headline(p: TrustCardProps): { text: string; color: string } {
  if (p.conflict) {
    return { text: 'Линия и точки маршрута расходятся', color: 'var(--warning)' };
  }
  if (!p.hasTrack) {
    return { text: 'Подтверждённой линии нет · ориентирование по точкам', color: 'var(--warning)' };
  }
  switch (p.fidelity) {
    case 'surveyed':
      return { text: 'Снятый трек · линия проверена', color: 'var(--success)' };
    case 'sketch':
      return { text: 'Набросок · линия построена прямыми между точками', color: 'var(--warning)' };
    default:
      return { text: 'Происхождение линии не записано', color: 'var(--warning)' };
  }
}

export function TrustCard(p: TrustCardProps) {
  const [open, setOpen] = useState(false);
  const head = headline(p);

  return (
    <div className="w-full rounded-xl"
      style={{
        background: 'var(--bg-card)',
        border: `1px solid color-mix(in srgb, ${head.color} 35%, transparent)`,
      }}>
      <button onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left"
        aria-expanded={open}>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate" style={{ color: head.color }}>
            {head.text}
          </p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {open ? 'Скрыть качество данных' : 'Показать качество данных'}
          </p>
        </div>
        <ChevronRight className={`w-4 h-4 shrink-0 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
          style={{ color: 'var(--text-muted)' }} />
      </button>

      {open && (
        <div className="px-4 pb-3 text-xs space-y-1.5" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="flex items-baseline gap-2 pt-2.5">
            <span className="w-14 shrink-0" style={{ color: 'var(--text-muted)' }}>Линия</span>
            <span style={{ color: 'var(--text-secondary)' }}>
              {p.hasTrack
                ? p.geometrySource
                  ? `источник: ${p.geometrySource}`
                  : 'источник не записан — вид выбран по плотности точек'
                : 'в данных маршрута нет'}
            </span>
          </div>
          {p.fixLabel && (
            <div className="flex items-baseline gap-2">
              <span className="w-14 shrink-0" style={{ color: 'var(--text-muted)' }}>GPS</span>
              <span style={{ color: 'var(--text-secondary)' }}>{p.fixLabel}</span>
            </div>
          )}
          {p.packStates ? (
            <>
              <div className="flex items-baseline justify-between pt-1">
                <span className="font-semibold" style={{ color: 'var(--text-secondary)' }}>Полевой пакет</span>
                <span className="font-semibold" style={{
                  color: p.packReadiness === 'ready' ? 'var(--success)' : 'var(--warning)',
                }}>
                  {p.packReadiness === 'ready' ? 'готов' : p.packReadiness === 'partial' ? 'не полон' : 'не готов'}
                </span>
              </div>
              {p.packStates.map(s => (
                <div key={s.kind} className="flex items-baseline gap-2">
                  <span className="w-14 shrink-0" style={{ color: 'var(--text-muted)' }}>{KIND_LABELS[s.kind]}</span>
                  <span style={{
                    color: s.status === 'ready'
                      ? 'var(--success)'
                      : s.status === 'missing' && s.kind === 'route'
                        // Отсутствие линии у points_only — природа маршрута.
                        ? 'var(--text-muted)'
                        : 'var(--warning)',
                  }}>
                    {s.note}
                  </span>
                </div>
              ))}
              {p.packReadiness !== 'not_ready' && (
                <p style={{ color: 'var(--text-muted)' }}>
                  Репетиция до выхода: включите авиарежим и откройте этот экран — карта и точки должны остаться на месте
                </p>
              )}
            </>
          ) : (
            <p style={{ color: 'var(--text-muted)' }}>
              Полевой пакет не сохранён — карта и условия без связи будут недоступны
            </p>
          )}
        </div>
      )}
    </div>
  );
}
