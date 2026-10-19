'use client';

/**
 * «Перед поездкой» — один блок действий в карточке поездки кабинета туриста:
 * регистрация группы в МЧС, ссылка для близких, снаряжение к туру и GPX.
 *
 * Ссылка для близких — существующая /trip/[token]: там только название, даты,
 * дни и туры плана, без состава группы, рейсов и контактов. Поездка
 * публикуется только по нажатию «Поделиться».
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ShieldCheck, Share2, Copy, Check, Backpack, Download, ChevronRight, Loader, Send, MessageCircle, ExternalLink } from 'lucide-react';
import { MCHS_DEADLINE_SHORT, MCHS_ONLINE_FORM_URL } from '@/lib/safety/mchs-registration';
import { planGpxPoints } from '@/lib/trips/plan-gpx';

export interface TripActionsDay {
  day: number;
  title: string;
  coords?: [number, number];
  realTour?: { tourId: string; title?: string };
}

export interface TripActionsTrip {
  id: string;
  title: string;
  arrival_date: string | null;
  departure_date: string | null;
  days: TripActionsDay[];
}

const isoDay = (d: string | null) => (d ? d.slice(0, 10) : null);

/** Маршрут и даты плана — в /register; имена и телефоны группы человек вписывает сам. */
export function mchsQueryFor(trip: TripActionsTrip): string {
  const q = new URLSearchParams();
  q.set('name', trip.title.slice(0, 200));
  const desc = trip.days.map((d) => `День ${d.day}: ${d.title}`).join('\n').slice(0, 2000);
  if (desc) q.set('desc', desc);
  const start = isoDay(trip.arrival_date);
  const end = isoDay(trip.departure_date);
  if (start && /^\d{4}-\d{2}-\d{2}$/.test(start)) q.set('start', start);
  if (end && /^\d{4}-\d{2}-\d{2}$/.test(end)) q.set('end', end);
  return q.toString();
}

/** Даты дня от даты прилёта; без даты прилёта — пусто. */
function dayDate(arrival: string | null, day: number): string | null {
  const a = isoDay(arrival);
  if (!a) return null;
  const ms = new Date(`${a}T00:00:00Z`).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + (day - 1) * 86400000).toISOString().slice(0, 10);
}

interface GearLink { routeId: string; title: string; date: string | null }

function Row({ icon: Icon, title, hint, children }: {
  icon: React.ElementType; title: string; hint?: string; children?: React.ReactNode;
}) {
  return (
    <div className="px-5 py-4 space-y-2.5">
      <div className="flex items-start gap-3">
        <span className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 bg-[var(--bg-hover)] border border-[var(--border)]">
          <Icon className="w-4 h-4 text-[var(--text-primary)]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[var(--text-primary)]">{title}</p>
          {hint && <p className="text-xs text-[var(--text-muted)] mt-0.5">{hint}</p>}
        </div>
      </div>
      {children && <div className="pl-11 flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

const chip = 'ds-btn ds-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium';

export function TripActions({ trip }: { trip: TripActionsTrip }) {
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState('');
  const [copied, setCopied] = useState(false);
  const [gear, setGear] = useState<GearLink[]>([]);

  const hasPoints = planGpxPoints(trip.days.map((d) => ({ day: d.day, title: d.title, coords: d.coords }))).length > 0;

  // Снаряжение — по маршруту тура дня (operator_tours.route_id). Нет маршрута — пункта нет.
  useEffect(() => {
    const tourDays = trip.days.filter((d) => d.realTour?.tourId);
    if (tourDays.length === 0) return;
    let alive = true;
    Promise.all(tourDays.map((d) =>
      fetch(`/api/tours/${encodeURIComponent(d.realTour!.tourId)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          const rid = j?.success ? (j.data?.routeId as string | null) : null;
          return rid ? { routeId: rid, title: (j.data?.title as string) || d.title, date: dayDate(trip.arrival_date, d.day) } : null;
        })
        .catch(() => null),
    )).then((list) => {
      if (!alive) return;
      const seen = new Set<string>();
      setGear(list.filter((g): g is GearLink => !!g && !seen.has(g.routeId) && !!seen.add(g.routeId)));
    });
    return () => { alive = false; };
  }, [trip]);

  const shareText = `Мой маршрут по Камчатке: ${trip.title}`;

  async function ensureShareUrl(): Promise<string | null> {
    if (shareUrl) return shareUrl;
    setSharing(true);
    setShareError('');
    try {
      const res = await fetch(`/api/trips/${trip.id}/share`, { method: 'POST' });
      const j = await res.json();
      if (!j.success) { setShareError(j.error ?? 'Не получилось сделать ссылку'); return null; }
      setShareUrl(j.shareUrl);
      return j.shareUrl as string;
    } catch {
      setShareError('Нет соединения');
      return null;
    } finally {
      setSharing(false);
    }
  }

  async function onShare() {
    const url = await ensureShareUrl();
    if (!url) return;
    if (typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share({ title: trip.title, text: shareText, url }); } catch { /* закрыли окно */ }
    }
  }

  async function onCopy() {
    const url = await ensureShareUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { setShareError('Не удалось скопировать — ссылка ниже'); }
  }

  async function openIn(kind: 'tg' | 'max') {
    // Окно открываем сразу, иначе браузер заблокирует его после запроса.
    const w = window.open('', '_blank');
    if (w) w.opener = null;
    const url = await ensureShareUrl();
    if (!url) { w?.close(); return; }
    const target = kind === 'tg'
      ? `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(shareText)}`
      : `https://max.ru/:share?text=${encodeURIComponent(`${shareText}\n${url}`)}`;
    if (w) w.location.href = target; else window.location.href = target;
  }

  return (
    <section className="ds-card overflow-hidden" data-testid="trip-actions" aria-labelledby="trip-actions-title">
      <div className="px-5 pt-4 pb-1">
        <h2 id="trip-actions-title" className="text-sm font-semibold text-[var(--text-primary)]">Перед поездкой</h2>
      </div>
      <div className="divide-y divide-[var(--border)]">
        {trip.days.length > 0 && (
          <Row icon={ShieldCheck} title="Регистрация группы в МЧС"
            hint={`Бесплатно, около 5 минут. Маршрут и даты подставятся сами, останется вписать группу. ${MCHS_DEADLINE_SHORT}`}>
            <Link href={`/register?${mchsQueryFor(trip)}`} className={chip}>
              Зарегистрировать <ChevronRight className="w-3.5 h-3.5" />
            </Link>
            <a href={MCHS_ONLINE_FORM_URL} target="_blank" rel="noopener noreferrer" className={chip}>
              <ExternalLink className="w-3.5 h-3.5" />Форма МЧС
            </a>
          </Row>
        )}

        <Row icon={Share2} title="Поделиться с близкими"
          hint="Ссылка на план: даты и дни маршрута. Состав группы, рейсы и контакты по ней не видны.">
          <button type="button" onClick={onShare} disabled={sharing} className={chip}>
            {sharing ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Share2 className="w-3.5 h-3.5" />}Поделиться
          </button>
          <button type="button" onClick={onCopy} disabled={sharing} className={chip}>
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}{copied ? 'Скопировано' : 'Копировать'}
          </button>
          <button type="button" onClick={() => openIn('tg')} disabled={sharing} className={chip}>
            <Send className="w-3.5 h-3.5" />Telegram
          </button>
          <button type="button" onClick={() => openIn('max')} disabled={sharing} className={chip}>
            <MessageCircle className="w-3.5 h-3.5" />MAX
          </button>
          {shareError && <p className="w-full text-xs text-[var(--danger)]">{shareError}</p>}
          {shareUrl && <p className="w-full text-xs text-[var(--text-muted)] break-all">{shareUrl}</p>}
        </Row>

        {gear.length > 0 && (
          <Row icon={Backpack} title="Что взять с собой" hint="Список снаряжения под маршрут тура и погоду на дату.">
            {gear.map((g) => (
              <Link key={g.routeId} className={chip}
                href={`/tools/equipment?routeId=${g.routeId}${g.date ? `&date=${g.date}` : ''}`}>
                <span className="truncate max-w-[14rem]">{g.title}</span><ChevronRight className="w-3.5 h-3.5" />
              </Link>
            ))}
          </Row>
        )}

        {hasPoints && (
          <Row icon={Download} title="Маршрут для навигатора" hint="Точки всех дней в GPX: Organic Maps, Garmin и другие навигаторы, работает без сети.">
            <a href={`/api/trips/${trip.id}/gpx`} download className={chip}>
              <Download className="w-3.5 h-3.5" />Скачать GPX
            </a>
          </Row>
        )}
      </div>
    </section>
  );
}
