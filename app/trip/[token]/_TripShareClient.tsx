'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Copy, Check, MapPin, Calendar, Share2, ExternalLink, ShieldCheck, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import type { MapMarker } from '@/components/shared/leaflet-types';

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false });

interface DayPlan {
  day: number;
  zone: string;
  title: string;
  activityType: string;
  priceFrom: number;
  priceTo: number;
  coords: [number, number];
  defaultTransport: string;
}

/** Тур к дню — прикладывает share-API (top_tours по activityType). */
interface ShareTour {
  id: string;
  title: string;
  base_price: string;
  operator_name: string;
}

interface Trip {
  id: string;
  title: string;
  arrival_date: string | null;
  departure_date: string | null;
  places: string[];
  activities: string[];
  days: DayPlan[];
  transport_by_day: Record<string, string>;
  top_tours?: Record<string, ShareTour>;
  /** Доступность на дату дня: day → {date, remaining} (share-API, B-4). */
  availability?: Record<string, { date: string; remaining: number }>;
}

/** «12.08» из YYYY-MM-DD — для строки доступности. */
function shortDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
}

/** Статус дня из safety-слоя платформы (fail-soft: нет данных — блока нет). */
function useDayStatus(): { title: string | null; hasAlert: boolean } | null {
  const [status, setStatus] = useState<{ title: string | null; hasAlert: boolean } | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/public/safety-status', { signal: ctrl.signal })
      .then(r => (r.ok ? r.json() : null))
      .then((d: unknown) => {
        const data = (d as { data?: { topTitle?: unknown; hasAlert?: unknown } } | null)?.data;
        if (!data) return;
        setStatus({
          title: typeof data.topTitle === 'string' ? data.topTitle : null,
          hasAlert: data.hasAlert === true,
        });
      })
      .catch(() => { /* нет данных — нет блока */ });
    return () => ctrl.abort();
  }, []);
  return status;
}

const ZONE_LABELS: Record<string, string> = {
  avachinsky: 'Авачинская',
  western: 'Мильковская',
  eastern: 'Карагинская',
  northern: 'Тигильская',
};

const ZONE_COLORS: Record<string, string> = {
  avachinsky: 'var(--accent)',
  eastern: 'var(--ocean)',
  northern: 'var(--success)',
  western: '#8B5CF6',
};

const TRANSPORT_LABELS: Record<string, string> = {
  walking: 'Пешком',
  jeep: 'Джип',
  helicopter: 'Вертолёт',
  boat: 'Катер',
};

function formatPrice(from: number, to: number): string {
  if (!from && !to) return '';
  if (from === to) return `${from.toLocaleString('ru')} ₽`;
  return `${from.toLocaleString('ru')} – ${to.toLocaleString('ru')} ₽`;
}

export function TripShareClient({ trip, token }: { trip: Trip; token: string }) {
  const [copied, setCopied] = useState(false);
  const dayStatus = useDayStatus();

  // Карта плана: нумерованные точки дней (координаты уже в данных дня).
  const mapMarkers: MapMarker[] = trip.days
    .filter((d) => Array.isArray(d.coords) && d.coords.length === 2)
    .map((d) => ({
      id: String(d.day),
      coords: d.coords,
      title: `День ${d.day}: ${d.title}`,
      color: d.zone === 'avachinsky' ? 'orange' : d.zone === 'eastern' ? 'blue' : d.zone === 'northern' ? 'green' : 'purple',
    }));
  const shareUrl = typeof window !== 'undefined' ? window.location.href : `https://vedarai.ru/trip/${token}`;
  const shareText = `${trip.title} — маршрут по Камчатке на ${trip.days.length} дней`;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const tgUrl = `https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(shareText)}`;
  const dateRange = trip.arrival_date && trip.departure_date
    ? `${trip.arrival_date} – ${trip.departure_date}` : null;

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <div className="border-b" style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}>
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <Link href="/" className="font-bold text-lg" style={{ color: 'var(--accent)' }}>KH</Link>
          <Link href="/planner" className="ds-btn ds-btn-primary text-sm px-4 py-2">
            Создать свой маршрут
          </Link>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        <div>
          <h1 className="font-playfair text-3xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
            {trip.title}
          </h1>
          <div className="flex flex-wrap gap-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
            {dateRange && (
              <span className="flex items-center gap-1">
                <Calendar className="w-4 h-4" />{dateRange}
              </span>
            )}
            <span className="flex items-center gap-1">
              <MapPin className="w-4 h-4" />
              {trip.days.length} {trip.days.length === 1 ? 'день' : trip.days.length < 5 ? 'дня' : 'дней'}
            </span>
          </div>
          {dayStatus && (
            <div className="flex items-center gap-2 mt-3 text-sm"
              style={{ color: dayStatus.hasAlert ? 'var(--warning)' : 'var(--success)' }}>
              {dayStatus.hasAlert
                ? <ShieldAlert className="w-4 h-4 flex-none" />
                : <ShieldCheck className="w-4 h-4 flex-none" />}
              <span>{dayStatus.hasAlert && dayStatus.title ? dayStatus.title : 'На Камчатке спокойно — данные safety-мониторинга платформы'}</span>
            </div>
          )}
        </div>

        {mapMarkers.length > 0 && (
          <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)' }}>
            <LeafletMap markers={mapMarkers} height="260px" />
          </div>
        )}

        <div className="rounded-lg p-4 space-y-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            <Share2 className="w-4 h-4" style={{ color: 'var(--accent)' }} />
            Поделиться маршрутом
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={handleCopy}
              className="flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-all"
              style={{ background: 'var(--bg-hover)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}>
              {copied ? <Check className="w-4 h-4" style={{ color: 'var(--success)' }} /> : <Copy className="w-4 h-4" />}
              {copied ? 'Скопировано' : 'Копировать ссылку'}
            </button>
            <a href={tgUrl} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium"
              style={{ background: 'color-mix(in srgb, var(--ocean) 15%, transparent)', color: 'var(--ocean)', border: '1px solid color-mix(in srgb, var(--ocean) 30%, transparent)' }}>
              <ExternalLink className="w-4 h-4" />Telegram
            </a>
            <a href="https://max.ru/id4101147649_bot" target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium"
              style={{ background: 'color-mix(in srgb, var(--accent) 12%, transparent)', color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)' }}>
              <ExternalLink className="w-4 h-4" />MAX
            </a>
          </div>
        </div>

        <div className="space-y-3">
          {trip.days.map((day) => {
            const transport = trip.transport_by_day?.[String(day.day)] || day.defaultTransport;
            const zoneColor = ZONE_COLORS[day.zone] || 'var(--text-secondary)';
            const price = formatPrice(day.priceFrom, day.priceTo);
            const tour = trip.top_tours?.[day.activityType];
            return (
              <div key={day.day} className="rounded-lg p-4"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <div className="flex-none w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white"
                      style={{ background: zoneColor }}>
                      {day.day}
                    </div>
                    <div>
                      <div className="font-medium text-sm mb-1" style={{ color: 'var(--text-primary)' }}>
                        {day.title}
                      </div>
                      <div className="flex flex-wrap gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        <span className="px-2 py-0.5 rounded-full"
                          style={{ background: `${zoneColor}20`, color: zoneColor }}>
                          {ZONE_LABELS[day.zone] || day.zone}
                        </span>
                        {transport && (
                          <span className="px-2 py-0.5 rounded-full" style={{ background: 'var(--bg-hover)' }}>
                            {TRANSPORT_LABELS[transport] || transport}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  {price && (
                    <div className="text-xs font-medium flex-none" style={{ color: 'var(--text-secondary)' }}>
                      {price}
                    </div>
                  )}
                </div>
                {/* Реальный тур к этому дню: план ведёт к брони, а не только
                    показывает цены «от-до» — отличие от планировщиков,
                    которые «plan brilliantly; do not book». Дата дня уходит
                    в ?date= — форма брони подхватит её сама (B-3), а строка
                    мест — честная занятость на эту дату (B-4). */}
                {tour && (() => {
                  const avail = trip.availability?.[String(day.day)];
                  const href = avail
                    ? `/catalog/tours/${tour.id}?date=${avail.date}`
                    : `/catalog/tours/${tour.id}`;
                  return (
                    <Link href={href}
                      className="mt-3 flex items-center justify-between gap-2 px-3 py-2 rounded-md transition-colors"
                      style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)' }}>
                      <div className="min-w-0">
                        <div className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>{tour.title}</div>
                        <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                          {tour.operator_name}
                          {avail && (
                            <span style={{ color: 'var(--success)' }}>
                              {' '}· на {shortDate(avail.date)} — {avail.remaining} {avail.remaining === 1 ? 'место' : avail.remaining < 5 ? 'места' : 'мест'}
                            </span>
                          )}
                        </div>
                      </div>
                      <span className="text-xs font-semibold whitespace-nowrap flex-none" style={{ color: 'var(--accent)' }}>
                        от {Number(tour.base_price).toLocaleString('ru-RU')} ₽ · забронировать
                      </span>
                    </Link>
                  );
                })()}
              </div>
            );
          })}
        </div>

        <div className="rounded-lg p-6 text-center space-y-3"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
          <h2 className="font-playfair text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
            Хочешь свой маршрут?
          </h2>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            AI-планировщик подберёт маршрут по Камчатке под твои даты и интересы
          </p>
          <Link href="/planner" className="ds-btn ds-btn-primary inline-flex px-6 py-3">
            Создать бесплатно
          </Link>
        </div>
      </div>
    </div>
  );
}
