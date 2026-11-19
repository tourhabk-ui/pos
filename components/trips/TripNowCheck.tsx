'use client';

/**
 * «Сейчас на ваши даты» — сохранённый план, перепроверенный сегодня (#3394,
 * слово владельца 19.11 «начни с обновления плана ближе к датам»).
 *
 * Данные — GET /api/trips/[id]/now (lib/trips/trip-now). Блок говорит, что
 * изменилось с дня сохранения: появившиеся и снятые предупреждения дней, места
 * туров на их даты, прогноз в пределах 16 суток. Чего не проверили — так и
 * сказано: «не проверено» не выдаётся за «всё хорошо» (§4.0).
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, CloudSun, Info, Users } from 'lucide-react';
import type { TripNow, TripNowDay } from '@/lib/trips/trip-now-types';
import { dayAvailabilityLine, ddmmOf } from '@/lib/trips/day-availability';
import { kamchatkaStamp } from '@/lib/safety/place-day-status';
import { formatKamchatkaDate } from '@/lib/admin/kamchatka-date';

const TONE_COLOR = { ok: 'var(--success)', warn: 'var(--warning)', muted: 'var(--text-secondary)' } as const;

function dayLabel(d: TripNowDay): string {
  return `День ${d.day}, ${ddmmOf(d.date)}`;
}

/** Что изменилось в строках безопасности. Нет изменений — так и сказано. */
function SafetyChanges({ days }: { days: TripNowDay[] }) {
  const changed = days.filter((d) => d.added.length > 0 || d.gone.length > 0);
  if (changed.length === 0) {
    return (
      <p className="flex items-start gap-2 text-xs text-[var(--text-secondary)]" data-testid="trip-now-safety-same">
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[var(--success)]" aria-hidden />
        <span>Закрытия парков, штормовые предупреждения и сводки МЧС на ваши даты с дня сохранения не изменились.</span>
      </p>
    );
  }
  return (
    <ul className="space-y-2" data-testid="trip-now-safety-changed">
      {changed.map((d) => (
        <li key={d.day} className="text-xs space-y-1">
          <p className="font-semibold text-[var(--text-primary)]">{dayLabel(d)}</p>
          {d.added.map((t, i) => (
            <p key={`a${i}`} className="flex items-start gap-1.5 text-[var(--warning)]">
              <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" aria-hidden />
              <span><span className="font-semibold">Появилось:</span> {t}</span>
            </p>
          ))}
          {d.gone.map((t, i) => (
            <p key={`g${i}`} className="flex items-start gap-1.5 text-[var(--text-secondary)]">
              <Info className="w-3 h-3 shrink-0 mt-0.5" aria-hidden />
              <span><span className="font-semibold">Больше не действует:</span> {t}</span>
            </p>
          ))}
        </li>
      ))}
    </ul>
  );
}

function Seats({ days }: { days: TripNowDay[] }) {
  const withTour = days.filter((d) => d.availability);
  if (withTour.length === 0) return null;
  return (
    <div className="space-y-1" data-testid="trip-now-seats">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-primary)]">
        <Users className="w-3.5 h-3.5" aria-hidden /> Места в турах
      </p>
      <ul className="space-y-1">
        {withTour.map((d) => {
          const view = dayAvailabilityLine(d.availability!);
          return (
            <li key={d.day} className="text-xs" style={{ color: TONE_COLOR[view.tone] }}>
              {dayLabel(d)}: {view.text}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Weather({ days }: { days: TripNowDay[] }) {
  const asked = days.filter((d) => d.weather_state !== 'not_checked');
  if (asked.length === 0) return null;
  const later = asked.filter((d) => d.weather_state === 'later');
  return (
    <div className="space-y-1" data-testid="trip-now-weather">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-primary)]">
        <CloudSun className="w-3.5 h-3.5" aria-hidden /> Погода
      </p>
      <ul className="space-y-1">
        {asked.filter((d) => d.weather_state !== 'later').map((d) => (
          <li key={d.day} className="text-xs"
            style={{ color: d.weather?.bad ? 'var(--warning)' : 'var(--text-secondary)' }}>
            {d.weather
              ? <>{dayLabel(d)}: {d.weather.tempMin}…{d.weather.tempMax} °C · ветер {d.weather.windKmh} км/ч
                  {d.weather.precipMm > 0 ? ` · осадки ${d.weather.precipMm} мм` : ''} · {d.weather.description}</>
              : <>{dayLabel(d)}: прогноз сейчас не получен</>}
          </li>
        ))}
      </ul>
      {later.length > 0 && (
        <p className="text-xs text-[var(--text-muted)]">
          {later.length === asked.length ? 'Прогноза на ваши даты пока нет' : `Для дней с ${ddmmOf(later[0].date)} прогноза пока нет`}:
          он бывает за 16 суток до даты. Загляните сюда ближе к поездке.
        </p>
      )}
    </div>
  );
}

/** Вид блока — чистый, под тестом рендером. */
export function TripNowView({ now, savedAt, rebuildHref }: {
  now: TripNow | 'loading' | 'failed';
  savedAt: string;
  rebuildHref: string;
}) {
  let body: React.ReactNode;
  if (now === 'loading') {
    body = <p className="text-xs text-[var(--text-muted)]">Проверяем план на ваши даты…</p>;
  } else if (now === 'failed') {
    body = (
      <p className="text-xs text-[var(--text-secondary)]" data-testid="trip-now-failed">
        Проверить план сейчас не получилось. Свежая обстановка — на странице{' '}
        <Link href="/safety" className="text-[var(--ocean)] hover:underline">«Обстановка»</Link>.
      </p>
    );
  } else if (now.state === 'no_dates') {
    body = (
      <p className="text-xs text-[var(--text-secondary)]">
        У поездки не записаны даты — проверять обстановку не на что.
      </p>
    );
  } else if (now.state === 'past') {
    body = (
      <p className="text-xs text-[var(--text-secondary)]">
        Поездка уже прошла (последний день — {ddmmOf(now.last_day)}), перепроверять нечего.
      </p>
    );
  } else {
    const seatsWarn = now.days.some((d) => d.availability && dayAvailabilityLine(d.availability).tone === 'warn');
    body = (
      <>
        <p className="text-xs text-[var(--text-muted)]">
          Проверено {kamchatkaStamp(now.checked_at)} по Камчатке; план сохранён {formatKamchatkaDate(savedAt)}.
        </p>
        <SafetyChanges days={now.days} />
        {now.plan_warnings.length > 0 && (
          <ul className="space-y-1" data-testid="trip-now-plan-warnings">
            {now.plan_warnings.map((w, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-[var(--warning)]">
                <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" aria-hidden />
                <span>{w}</span>
              </li>
            ))}
          </ul>
        )}
        <Seats days={now.days} />
        <Weather days={now.days} />
        {(now.safety_changed || seatsWarn) && (
          <p className="text-xs text-[var(--text-secondary)]" data-testid="trip-now-rebuild">
            План не меняется сам. Если он больше не подходит —{' '}
            <Link href={rebuildHref} className="text-[var(--ocean)] hover:underline">соберите его заново на те же даты</Link>.
          </p>
        )}
      </>
    );
  }
  return (
    <section className="ds-card p-5 space-y-3" data-testid="trip-now">
      <h2 className="text-sm font-semibold text-[var(--text-primary)]">Сейчас на ваши даты</h2>
      {body}
    </section>
  );
}

/**
 * Ответ двери похож на перепроверку. Чужая форма — «не получилось», а не
 * падение всей страницы поездки: блок вспомогательный, план под ним важнее.
 */
function isTripNow(v: unknown): v is TripNow {
  if (!v || typeof v !== 'object') return false;
  const s = (v as { state?: unknown }).state;
  if (s === 'no_dates') return true;
  if (s === 'past') return typeof (v as { last_day?: unknown }).last_day === 'string';
  if (s !== 'checked') return false;
  const c = v as { days?: unknown; plan_warnings?: unknown; checked_at?: unknown };
  return Array.isArray(c.days) && Array.isArray(c.plan_warnings) && typeof c.checked_at === 'string';
}

/** Блок со своим запросом: перепроверка идёт при открытии страницы поездки. */
export function TripNowCheck({ tripId, savedAt, rebuildHref }: { tripId: string; savedAt: string; rebuildHref: string }) {
  const [now, setNow] = useState<TripNow | 'loading' | 'failed'>('loading');
  useEffect(() => {
    let alive = true;
    fetch(`/api/trips/${tripId}/now`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: unknown }>)
      .then((d) => { if (alive) setNow(d.success && isTripNow(d.data) ? d.data : 'failed'); })
      .catch(() => { if (alive) setNow('failed'); });
    return () => { alive = false; };
  }, [tripId]);
  return <TripNowView now={now} savedAt={savedAt} rebuildHref={rebuildHref} />;
}
