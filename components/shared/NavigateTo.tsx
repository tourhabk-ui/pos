'use client';

/**
 * components/shared/NavigateTo.tsx
 *
 * «Проложить маршрут» — передача цели в настоящий навигатор.
 *
 * Слово владельца 11.08: «смысл людям пользоваться нашей кривой, если есть
 * другие». Дорогу до начала тропы строят Organic Maps, Яндекс и 2ГИС, и
 * строят её лучше. Наше дело начинается там, где их маршрут кончается.
 *
 * Два состояния, и они НАЗВАНЫ РАЗНЫМИ СЛОВАМИ:
 *   старт известен → «Маршрут в …», ссылка ведёт маршрут;
 *   старта нет     → «Показать в …», ссылка ставит булавку.
 * Одинаковая подпись на разном поведении — обман в один тап: человек ждёт
 * маршрут, получает точку и узнаёт об этом уже в чужом приложении.
 *
 * Кнопки — марки приложений, как иконки на экране телефона (владелец 06.09:
 * «уменьшить внешние карты, просто логотипом на кнопке»). Слово состояния
 * при этом не пропало: оно стоит ОДНО перед рядом марок и в aria-label
 * каждой кнопки — четыре одинаковых подписи сжались в одну, а не в ноль.
 *
 * `compact` — для карточки точки и листа «На маршруте»: без сноски и без
 * кнопки «Строить маршрут от меня» (экран сам ведёт положение, второй запрос
 * геолокации там лишний). `tone: 'glass'` — подпись белым поверх стекла.
 */

import { useCallback, useEffect, useState } from 'react';
import { Crosshair } from 'lucide-react';
import { navLinks, type NavMode, type NavPoint } from '@/lib/navigation/handoff';

interface Props {
  /** Куда. */
  to: NavPoint;
  /** Откуда, если экран уже ведёт положение — тогда геолокацию не спрашиваем. */
  from?: NavPoint | null;
  mode?: NavMode;
  /** Заголовок блока; null — без заголовка (для узких мест вроде панели). */
  title?: string | null;
  /** Только ряд марок с подписью состояния: без сноски и без запроса геолокации. */
  compact?: boolean;
  /** На каком фоне стоит блок: подпись состояния красится под него. */
  tone?: 'surface' | 'glass';
  className?: string;
}

export default function NavigateTo({
  to, from, mode = 'car', title = 'Проложить маршрут', compact = false, tone = 'surface', className,
}: Props) {
  const [fix, setFix] = useState<NavPoint | null>(from ?? null);
  const [asking, setAsking] = useState(false);
  /** Разрешение уже выдано — можно взять фикс молча, без всплывашки. */
  const [preGranted, setPreGranted] = useState(false);

  useEffect(() => { if (from) setFix(from); }, [from]);

  useEffect(() => {
    if (from || typeof navigator === 'undefined' || !navigator.permissions) return;
    let alive = true;
    navigator.permissions.query({ name: 'geolocation' as PermissionName })
      .then((p) => { if (alive && p.state === 'granted') setPreGranted(true); })
      .catch(() => { /* Safari без Permissions API — просто покажем кнопку */ });
    return () => { alive = false; };
  }, [from]);

  const locate = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    setAsking(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setFix({ lat: pos.coords.latitude, lng: pos.coords.longitude, name: 'Я' });
        setAsking(false);
      },
      // Отказ или таймаут — остаёмся на ссылках-точках, они рабочие
      () => setAsking(false),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
    );
  }, []);

  // Разрешение уже есть — берём фикс сразу, спрашивать нечего
  useEffect(() => { if (preGranted && !fix) locate(); }, [preGranted, fix, locate]);

  const links = navLinks(fix, to, mode);
  if (links.length === 0) return null;

  const routing = links[0].isRoute;
  const verb = routing ? 'Маршрут в' : 'Показать в';
  const captionClass = tone === 'glass' ? 'text-[11px] text-white/70' : 'text-xs text-[var(--text-secondary)]';

  return (
    <section className={className}>
      {title !== null && (
        <h2 className="ds-h2 mb-3">{title}</h2>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`${captionClass} mr-1`}>{verb}</span>
        {links.map((l) => (
          <a
            key={l.app}
            href={l.url}
            /* om:// — схема приложения, а не веб-адрес: с target="_blank"
               остаётся пустая вкладка вместо открытого навигатора. */
            {...(l.url.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            aria-label={`${verb} ${l.label}`}
            title={`${verb} ${l.label}`}
            className="inline-flex items-center justify-center rounded-lg transition-all duration-200 hover:opacity-90 active:opacity-70"
            style={{ width: 44, height: 44 }}
          >
            {/* Марка — файл в public, не next/image: SVG без оптимизации, как и route-48 в BottomNav. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={l.icon} alt="" width={36} height={36} decoding="async" className="rounded-lg" style={{ width: 36, height: 36 }} />
          </a>
        ))}
      </div>

      {compact ? null : (<>
      {!routing && (
        <button
          type="button"
          onClick={locate}
          disabled={asking}
          className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-[var(--ocean)] transition-opacity hover:opacity-80 disabled:opacity-50"
        >
          <Crosshair className="h-4 w-4" aria-hidden />
          {asking ? 'Определяю, где вы…' : 'Строить маршрут от меня'}
        </button>
      )}

      <p className="mt-2 text-xs text-[var(--text-secondary)]">
        {routing
          ? 'Маршрут строит навигатор. Organic Maps работает без сети — на Камчатке связь кончается раньше дороги.'
          : 'Пока не знаем, где вы, — ссылки открывают точку на карте.'}
      </p>
      </>)}
    </section>
  );
}
