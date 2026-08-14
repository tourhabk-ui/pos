'use client';

import { useState, useEffect, useRef } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { AlertTriangle, Info, ArrowRight, Search, Sunrise, CalendarDays } from 'lucide-react';
import { ShareButton } from '@/components/shared/ShareButton';
import { clip } from '@/components/safety/LiveStatus';

export interface SafetyStatusData {
  hasAlert: boolean;
  maxSeverity: number;
  activeCount: number;
  topTitle: string | null;
  topType: string | null;
  dataUpdatedAt: string | null;
  source: string;
}

interface HeroStatusProps {
  safety: SafetyStatusData | null;
  fetchedAt: string;
}

const STALE_MS = 48 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 минуты

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Kamchatka',
    });
  } catch {
    return '';
  }
}

function kamchatkaRise(date: Date): string {
  const doy = Math.floor(
    (date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / 86_400_000,
  );
  const decl = 23.45 * Math.sin((360 / 365) * (doy - 81) * (Math.PI / 180));
  const cosH = -Math.tan(53.01 * (Math.PI / 180)) * Math.tan(decl * (Math.PI / 180));
  if (cosH <= -1) return '00:00';
  if (cosH >= 1)  return '--:--';
  const riseLocal = ((12 - (Math.acos(cosH) * 180) / Math.PI / 15 - 158.65 / 15) + 12) % 24;
  const h = Math.floor(riseLocal);
  const m = Math.round((riseLocal - h) * 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function HeroStatus({ safety: initialSafety }: HeroStatusProps) {
  const [safety, setSafety] = useState<SafetyStatusData | null>(initialSafety);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    async function poll() {
      try {
        const res = await fetch('/api/public/safety-status', { cache: 'no-store' });
        if (!res.ok) return;
        const json = await res.json() as { success: boolean; data: SafetyStatusData };
        if (json.success && json.data) setSafety(json.data);
      } catch {
        // не обновляем при ошибке — оставляем последние данные
      }
    }

    timerRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const updatedAt = safety?.dataUpdatedAt ? new Date(safety.dataUpdatedAt) : null;
  const cronNeverRan = safety !== null && safety.dataUpdatedAt === null;
  const isStale = cronNeverRan || (!updatedAt ? true : Date.now() - updatedAt.getTime() > STALE_MS);

  const severity = !isStale ? (safety?.maxSeverity ?? 0) : 0;
  const hasAlert = !isStale && (safety?.hasAlert ?? false);

  let badgeLabel: string;
  let badgeColor: string;
  let BadgeIcon: React.ElementType;

  if (cronNeverRan || safety === null) {
    badgeLabel = `Рассвет в ${kamchatkaRise(new Date())}`;
    badgeColor = 'var(--ocean)';
    BadgeIcon = Sunrise;
  } else if (severity >= 3) {
    badgeLabel = 'Высокая опасность';
    badgeColor = 'var(--danger)';
    BadgeIcon = AlertTriangle;
  } else if (severity >= 1) {
    badgeLabel = 'Внимание';
    badgeColor = 'var(--warning)';
    BadgeIcon = Info;
  } else {
    badgeLabel = `Рассвет в ${kamchatkaRise(new Date())}`;
    badgeColor = 'var(--ocean)';
    BadgeIcon = Sunrise;
  }

  // Статус дня больше не заголовок первого экрана, а строка-доказательство
  // под ним. Заголовком у нового человека должен быть ответ на «с чего мне
  // начать планировать Камчатку», а не необрезанная простыня из ленты МЧС
  // (стратегия 14.08; сама простыня — она и красовалась здесь заголовком).
  // Обрезка — общий clip(): две поверхности об одном предупреждении обязаны
  // говорить одинаково (тот же резак, что в ленте /safety).
  const alertLine = hasAlert && safety?.topTitle ? clip(safety.topTitle, 90) : null;

  const sourceLabel =
    !isStale && !cronNeverRan && updatedAt
      ? `${safety?.source ?? 'КБГС РАН'} · ${formatTime(updatedAt.toISOString())}`
      : null;

  return (
    <div className="relative mx-4 mt-4 mb-0 rounded-lg overflow-hidden h-[320px] md:h-[380px]">
      <Image
        src="/images/hero/hero-light.jpeg"
        alt="Камчатка"
        fill
        className="object-cover"
        priority
      />
      <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/30 to-black/75" />

      <div className="absolute inset-0 flex flex-col justify-between p-5 md:p-6">
        {/* Top row: status badge + source chip */}
        <div className="flex items-start justify-between gap-3">
          <div
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold text-white"
            style={{ background: 'rgba(0,0,0,0.55)' }}
          >
            <BadgeIcon size={11} style={{ color: badgeColor, flexShrink: 0 }} />
            <span>{badgeLabel}</span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {sourceLabel && (
              <span
                className="text-white/65 text-xs px-2.5 py-1 rounded-full whitespace-nowrap"
                style={{ background: 'rgba(0,0,0,0.40)' }}
              >
                {sourceLabel}
              </span>
            )}
            {/* Стекло поверх фото — разрешённый случай по §2. */}
            <ShareButton
              referral
              size={15}
              className="w-9 h-9 rounded-full grid place-items-center text-white/90 backdrop-blur-md bg-black/40 border border-white/15 transition-colors hover:bg-black/60"
              title="Ведар — Камчатка"
              text="Маршруты, безопасность и проверенные туры по Камчатке"
              referralText="Приглашаю в Ведар: маршруты и проверенные туры по Камчатке. По моей ссылке — бонус на первую поездку"
            />
          </div>
        </div>

        {/* Bottom: конверсионный посыл + один главный шаг + статус строкой.
            Первый экран отвечает новому человеку на «с чего мне начать», а не
            расшифровывает сервис (стратегия 14.08). Планировщик — та же дверь,
            что на мобильной v8 («Планировщик поездки» → /planner). */}
        <div>
          <h2 className="font-playfair text-2xl md:text-4xl text-white font-bold leading-tight mb-1.5 max-w-md">
            Соберите безопасную поездку на Камчатку
          </h2>
          <p className="text-white/75 text-sm md:text-base mb-4 max-w-md">
            Подберём варианты по сезону, нагрузке и реальным условиям маршрутов.
          </p>

          <div className="flex flex-wrap items-center gap-2 mb-3">
            <Link
              href="/planner"
              className="inline-flex items-center gap-2 text-sm font-semibold text-white rounded-full px-5 py-2.5 transition-transform hover:scale-105 active:scale-95"
              style={{ background: 'var(--accent)' }}
            >
              <CalendarDays size={16} />
              Собрать план
            </Link>

            {/* «Я уже знаю маршрут» — прежний поиск, второй ролью, не конкурентом */}
            <form action="/routes" method="get" className="flex items-center gap-2 flex-1 min-w-[220px]">
              <div
                className="flex-1 flex items-center gap-2 px-4 py-2.5 rounded-full"
                style={{
                  background: 'rgba(255,255,255,0.14)',
                  border: '1px solid rgba(255,255,255,0.22)',
                }}
              >
                <Search size={14} className="text-white/55 flex-shrink-0" />
                <input
                  name="q"
                  type="text"
                  placeholder="Я уже знаю маршрут…"
                  className="bg-transparent outline-none flex-1 text-white placeholder:text-white/50 text-sm min-w-0"
                />
              </div>
              <button
                type="submit"
                aria-label="Найти маршрут"
                className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 transition-transform hover:scale-105 active:scale-95"
                style={{ background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.25)' }}
              >
                <ArrowRight size={16} className="text-white" />
              </button>
            </form>
          </div>

          {/* Статус дня — доказательство компетентности, строкой, не заголовком.
              Блока нет, когда предупреждений нет: пустое «всё спокойно» — это
              обещание, которого мы дать не можем (тот же принцип, что на v8). */}
          {alertLine && (
            <Link
              href="/safety"
              className="flex items-center gap-2 text-xs text-white/80 hover:text-white transition-colors"
            >
              <BadgeIcon size={12} style={{ color: badgeColor, flexShrink: 0 }} />
              <span className="min-w-0 truncate">{alertLine}</span>
              <span className="flex-shrink-0 text-white/55">Подробнее →</span>
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
