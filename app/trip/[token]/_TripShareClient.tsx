'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Copy, Check, MapPin, Calendar, Share2, ExternalLink, ShieldCheck, ShieldAlert, Download, Navigation, LifeBuoy } from 'lucide-react';
import Link from 'next/link';
import type { MapMarker } from '@/components/shared/leaflet-types';
import { MCHS_ONLINE_FORM_URL, MCHS_DEADLINE_SHORT } from '@/lib/safety/mchs-registration';

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
  /** Прогноз на дату дня (Open-Meteo, горизонт 16 суток; B-5). */
  weather?: Record<string, { date: string; tempMin: number; tempMax: number; windKmh: number; precipMm: number; description: string; bad: boolean }>;
  /** Запасные туры дня при непогоде (contingency_rules операторов; B-5). */
  plan_b?: Record<string, Array<{ tour_id: string; title: string }>>;
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

  // Регистрация МЧС из плана (C-7): маршрут и даты уже в плане — несём их в
  // /register предзаполнением. В query только название, дни и даты; ПД (имена,
  // телефоны группы) человек вводит сам на форме. Регистрацию подтверждает
  // сам турист — автоотправки от его имени нет.
  const mchsQuery = (() => {
    const q = new URLSearchParams();
    q.set('name', trip.title.slice(0, 200));
    const desc = trip.days.map((d) => `День ${d.day}: ${d.title}`).join('\n').slice(0, 2000);
    if (desc) q.set('desc', desc);
    if (trip.arrival_date && /^\d{4}-\d{2}-\d{2}$/.test(trip.arrival_date)) q.set('start', trip.arrival_date);
    if (trip.departure_date && /^\d{4}-\d{2}-\d{2}$/.test(trip.departure_date)) q.set('end', trip.departure_date);
    return q.toString();
  })();

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

        {/* Офлайн-план (C-6): за городом на Камчатке связи нет, а план — это
            координаты. GPX открывается в Organic Maps / Garmin без сети;
            сама страница кэшируется service worker'ом при первом открытии. */}
        {mapMarkers.length > 0 && (
          <div className="rounded-lg p-4 space-y-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              <Navigation className="w-4 h-4" style={{ color: 'var(--accent)' }} />
              В поход без связи
            </div>
            <a href={`/api/trips/share/${token}/gpx`} download
              className="flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium w-fit"
              style={{ background: 'color-mix(in srgb, var(--accent) 12%, transparent)', color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)' }}>
              <Download className="w-4 h-4" />Скачать GPX для навигатора
            </a>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Точки всех дней с датами — откроется в Organic Maps, Garmin и любом GPS-навигаторе.
              Страница плана сохраняется на телефоне и открывается без интернета.
            </p>
          </div>
        )}

        {/* Перед выходом (C-7): регистрация группы в МЧС. Кнопка несёт маршрут
            и даты плана в /register — там форма группы, PDF-заявление и ссылка
            на официальную регистрацию. Альтернатива — форма МЧС напрямую. */}
        {trip.days.length > 0 && (
          <div className="rounded-lg p-4 space-y-3"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderLeft: '4px solid var(--warning)' }}>
            <div className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              <LifeBuoy className="w-4 h-4" style={{ color: 'var(--warning)' }} />
              Перед выходом — регистрация в МЧС
            </div>
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              Уведомите спасателей о выходе на маршрут: бесплатно, 5 минут.
              Маршрут и даты из плана подставятся сами — останется вписать состав группы.
            </p>
            {/* План — то место, где до выхода ещё есть время. Именно здесь срок
                меняет поведение, а не на карточке маршрута накануне выезда. */}
            <p className="text-xs font-semibold" style={{ color: 'var(--warning)' }}>
              {MCHS_DEADLINE_SHORT}
            </p>
            <div className="flex flex-wrap gap-2">
              <Link href={`/register?${mchsQuery}`}
                className="flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium"
                style={{ background: 'color-mix(in srgb, var(--warning) 14%, transparent)', color: 'var(--warning)', border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)' }}>
                <ShieldCheck className="w-4 h-4" />Зарегистрировать маршрут
              </Link>
              <a href={MCHS_ONLINE_FORM_URL} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium"
                style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                <ExternalLink className="w-4 h-4" />Форма МЧС напрямую
              </a>
            </div>
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
                        {/* Deep-link в навигатор (C-6): geo: открывает точку дня
                            в Organic Maps / любых картах телефона — офлайн. */}
                        {Array.isArray(day.coords) && day.coords.length === 2 && (
                          <a href={`geo:${day.coords[0]},${day.coords[1]}?z=12`}
                            className="px-2 py-0.5 rounded-full flex items-center gap-1"
                            style={{ background: 'color-mix(in srgb, var(--success) 12%, transparent)', color: 'var(--success)' }}>
                            <Navigation className="w-3 h-3" />Навигатор
                          </a>
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
                {/* Погода на дату дня (B-5): прогноз Open-Meteo по координатам
                    дня; плохая (ветер/осадки) подсвечивается warning-цветом. */}
                {(() => {
                  const w = trip.weather?.[String(day.day)];
                  if (!w) return null;
                  const alts = trip.plan_b?.[String(day.day)];
                  return (
                    <div className="mt-2 space-y-1.5">
                      <div className="text-xs" style={{ color: w.bad ? 'var(--warning)' : 'var(--text-muted)' }}>
                        Прогноз на {shortDate(w.date)}: {w.tempMin}…{w.tempMax} °C · ветер {w.windKmh} км/ч
                        {w.precipMm > 0 ? ` · осадки ${w.precipMm} мм` : ''} · {w.description}
                      </div>
                      {alts && alts.length > 0 && (
                        <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                          План Б при непогоде:{' '}
                          {alts.map((a, i) => (
                            <span key={a.tour_id}>
                              {i > 0 && ' · '}
                              <Link href={`/catalog/tours/${a.tour_id}`} style={{ color: 'var(--ocean)' }}>
                                {a.title}
                              </Link>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
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
