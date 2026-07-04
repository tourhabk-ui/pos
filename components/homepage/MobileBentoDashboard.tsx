'use client';

/**
 * MobileBentoDashboard — Bento-сетка мобильного Field OS дашборда:
 * радар безопасности (реальные статусы из /api/safety/routes — НЕ заглушки:
 * фейковый факт о безопасности хуже отсутствия данных), карта, офлайн.
 *
 * Тайлы — сплошные var(--bg-card): они лежат на сплошном фоне, блюрить нечего
 * (glassmorphism разрешён владельцем 2026-07-03, но только поверх фото/тёмных
 * подложек — см. CLAUDE.md §2). «N ГБ доступно» — реальное число из
 * navigator.storage.estimate(), не фикция.
 */

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ChevronRight, Download, Map as MapIcon } from 'lucide-react';
import { getStorageEstimate } from '@/lib/offline/db';

interface RadarItem {
  id: number;
  title: string;
  status: string; // 'green' | 'yellow' | 'red'
  reason: string;
}

interface GlobalSafetyStatus {
  hasAlert: boolean;
  maxSeverity: number;
  activeCount: number;
  topTitle: string | null;
}

const STATUS_COLOR: Record<string, string> = {
  green: 'var(--success)',
  yellow: 'var(--warning)',
  red: 'var(--danger)',
};

const STATUS_LABEL: Record<string, string> = {
  green: 'Безопасно',
  yellow: 'Умеренно',
  red: 'Опасно',
};

function formatGb(bytes: number): string {
  return (bytes / (1024 ** 3)).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1);
}

export function MobileBentoDashboard() {
  const [radar, setRadar] = useState<RadarItem[] | null>(null);
  const [radarFailed, setRadarFailed] = useState(false);
  const [globalAlert, setGlobalAlert] = useState<GlobalSafetyStatus | null>(null);
  const [freeGb, setFreeGb] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/safety/routes?mode=adventure&limit=5')
      .then(res => (res.ok ? res.json() : Promise.reject(new Error('unavailable'))))
      .then((json: { data?: RadarItem[] }) => {
        if (cancelled) return;
        if (Array.isArray(json.data) && json.data.length > 0) setRadar(json.data);
        else setRadarFailed(true);
      })
      .catch(() => { if (!cancelled) setRadarFailed(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/public/safety-status')
      .then(res => (res.ok ? res.json() : null))
      .then((json: { success?: boolean; data?: GlobalSafetyStatus } | null) => {
        if (!cancelled && json?.success && json.data) setGlobalAlert(json.data);
      })
      .catch(() => { /* строка общего статуса просто не показывается */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getStorageEstimate()
      .then(est => {
        if (cancelled || !est?.quota) return;
        setFreeGb(formatGb(est.quota - (est.usage ?? 0)));
      })
      .catch(() => { /* число просто не показываем */ });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="grid grid-cols-2 gap-3 px-4 pt-4">
      {/* Радар безопасности — широкий тайл */}
      <div className="col-span-2 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
        <Link href="/safety" className="flex items-center justify-between">
          <span className="font-playfair text-lg font-bold text-[var(--text-primary)]">
            Радар безопасности
          </span>
          <ChevronRight size={18} strokeWidth={1.5} className="text-[var(--text-muted)]" aria-hidden />
        </Link>
        <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
          Актуальная обстановка на маршрутах
        </p>

        {globalAlert && (
          <p
            className="mt-2 flex items-center gap-1.5 text-xs"
            style={{ color: globalAlert.hasAlert ? (globalAlert.maxSeverity >= 3 ? 'var(--danger)' : 'var(--warning)') : 'var(--success)' }}
          >
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: 'currentColor' }}
            />
            {globalAlert.hasAlert
              ? `Активных предупреждений: ${globalAlert.activeCount}${globalAlert.topTitle ? ` — ${globalAlert.topTitle}` : ''}`
              : 'Активных предупреждений нет'}
          </p>
        )}

        <div className="mt-3 space-y-1">
          {radar === null && !radarFailed && (
            <div className="space-y-2" aria-hidden>
              {[0, 1, 2].map(i => (
                <div key={i} className="h-9 animate-pulse rounded-lg bg-[var(--bg-hover)]" />
              ))}
            </div>
          )}
          {radarFailed && (
            <p className="py-2 text-sm text-[var(--text-secondary)]">
              Статусы временно недоступны.{' '}
              <Link href="/safety" className="text-[var(--ocean)] underline">
                Раздел безопасности
              </Link>
            </p>
          )}
          {radar?.map(item => (
            <Link
              key={item.id}
              href={`/routes?q=${encodeURIComponent(item.title)}`}
              className="flex items-center gap-2.5 rounded-lg px-2 py-2 transition-all duration-200 active:bg-[var(--bg-hover)]"
            >
              <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: STATUS_COLOR[item.status] ?? 'var(--text-muted)' }}
              />
              <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]">
                {item.title}
              </span>
              <span
                className="shrink-0 text-xs"
                style={{ color: STATUS_COLOR[item.status] ?? 'var(--text-muted)' }}
              >
                {STATUS_LABEL[item.status] ?? item.reason}
              </span>
              <ChevronRight size={14} strokeWidth={1.5} className="shrink-0 text-[var(--text-muted)]" aria-hidden />
            </Link>
          ))}
        </div>
      </div>

      {/* Карта — квадратный тайл */}
      <Link
        href="/map"
        className="relative h-40 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]"
      >
        <Image
          src="/images/hero/IMG_20260316_133113.jpg"
          alt=""
          fill
          sizes="50vw"
          className="object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/60 to-black/30" aria-hidden />
        <div className="absolute inset-x-0 top-0 flex items-center justify-between p-3">
          <span className="font-playfair text-base font-bold text-white">Карта</span>
          <ChevronRight size={16} strokeWidth={1.5} className="text-white/70" aria-hidden />
        </div>
        <MapIcon
          size={28}
          strokeWidth={1.5}
          className="absolute bottom-3 left-3 text-white/80"
          aria-hidden
        />
      </Link>

      {/* Офлайн — квадратный тайл */}
      <Link
        href="/offline/manage"
        className="flex h-40 flex-col justify-between rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-3"
      >
        <div className="flex items-center justify-between">
          <span className="font-playfair text-base font-bold text-[var(--text-primary)]">Офлайн</span>
          <ChevronRight size={16} strokeWidth={1.5} className="text-[var(--text-muted)]" aria-hidden />
        </div>
        <div className="flex flex-col items-center gap-2">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--bg-hover)]">
            <Download size={22} strokeWidth={1.5} className="text-[var(--success)]" aria-hidden />
          </span>
          <span className="text-center text-xs leading-tight text-[var(--text-secondary)]">
            Карты и данные для офлайн-доступа
            {freeGb && (
              <>
                <br />
                <span className="text-[var(--success)]">{freeGb} ГБ доступно</span>
              </>
            )}
          </span>
        </div>
      </Link>
    </div>
  );
}
