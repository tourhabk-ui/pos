import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { PhoneCall, WifiOff, Mountain, LifeBuoy, Map as MapIcon, ChevronDown } from 'lucide-react';
import { FEDERAL_EMERGENCY, VERIFIED_REGIONAL, telHref, type EmergencyNumber } from '@/lib/safety/emergency-numbers';

export const metadata: Metadata = {
  title: 'Связи нет',
  robots: 'noindex, nofollow',
};

// Единый номер (112) — акцентная кнопка. Остальные федеральные короткие —
// в «ещё службы». Первый проверенный региональный МЧС — одной строкой сразу.
const PRIMARY = FEDERAL_EMERGENCY[0];                 // 112
const OTHER_FEDERAL = FEDERAL_EMERGENCY.slice(1);     // 101 / 102 / 103
const REGIONAL_LEAD = VERIFIED_REGIONAL[0] ?? null;   // МЧС Камчатки — СОД
const REGIONAL_REST = VERIFIED_REGIONAL.slice(1);     // резерв СОД, НДС

/**
 * Экран, который service worker отдаёт офлайн вне кэша (caches.match('/offline')).
 * Это худшая минута туриста: связи нет, он в тайге. Приоритет — не «на главную»,
 * а помощь под большим пальцем: звонок работает без интернета, 112 — без баланса
 * и SIM. Ноль сети, ноль JS, ноль БД: только tel:-ссылки и статические номера из
 * единого источника (lib/safety/emergency-numbers). Иконки инлайновые (lucide),
 * а не растровое фото — чтобы сама офлайн-страница не зависела от кэша картинки.
 */
export default function OfflinePage() {
  return (
    <main className="min-h-[100dvh] bg-[var(--bg-primary)] text-[var(--text-primary)] flex flex-col items-center px-5 py-10">
      <div className="w-full max-w-md flex-1 flex flex-col justify-center gap-7">

        {/* Статус — спокойно, без тревоги */}
        <div className="flex items-center gap-2.5 text-[var(--text-secondary)]">
          <span className="relative flex h-2.5 w-2.5" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full rounded-full bg-[var(--warning)] opacity-40 animate-ping" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--warning)]" />
          </span>
          <WifiOff className="w-4 h-4" aria-hidden="true" />
          <span className="text-sm font-medium tracking-wide">Связи нет</span>
        </div>

        {/* Заголовок — обещание, а не извинение */}
        <div>
          <h1
            className="font-playfair text-4xl sm:text-5xl font-bold leading-[1.05]"
            style={{ letterSpacing: '-0.02em', textWrap: 'balance' }}
          >
            Связи нет.<br />Но ты не один.
          </h1>
          <p className="mt-4 text-[var(--text-secondary)] leading-relaxed">
            Звонок в экстренные службы работает <span className="text-[var(--text-primary)] font-medium">без интернета</span>.
            {' '}{PRIMARY.hint}
          </p>
        </div>

        {/* 112 — главное действие, под большим пальцем */}
        <a
          href={telHref(PRIMARY.phone)}
          aria-label={`Позвонить ${PRIMARY.phone} — ${PRIMARY.name}`}
          className="group flex items-center gap-4 rounded-2xl px-6 py-5 text-white shadow-sm transition-transform active:scale-[0.99]"
          style={{ background: 'var(--danger)' }}
        >
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-white/15">
            <PhoneCall className="h-7 w-7" aria-hidden="true" />
          </span>
          <span className="flex flex-col leading-none">
            <span className="font-playfair text-5xl font-bold tabular-nums">{PRIMARY.phone}</span>
            <span className="mt-1.5 text-sm text-white/85">{PRIMARY.name}</span>
          </span>
          <PhoneCall className="ml-auto h-5 w-5 text-white/60 transition-transform group-active:translate-x-0.5 sm:block hidden" aria-hidden="true" />
        </a>

        {/* Спасатели Камчатки — один проверенный номер сразу под 112 */}
        {REGIONAL_LEAD && (
          <TelRow
            entry={REGIONAL_LEAD}
            icon={<LifeBuoy className="h-5 w-5 text-[var(--ocean)]" aria-hidden="true" />}
          />
        )}

        {/* Остальные службы — нативный details, работает офлайн без JS */}
        <details className="group -mt-2">
          <summary className="flex cursor-pointer list-none items-center justify-between rounded-lg px-1 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]">
            <span>Ещё экстренные службы</span>
            <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            {REGIONAL_REST.map((n) => (
              <TelRow key={n.phone} entry={n} icon={<LifeBuoy className="h-5 w-5 text-[var(--ocean)]" aria-hidden="true" />} />
            ))}
            <div className="grid grid-cols-3 gap-2">
              {OTHER_FEDERAL.map((n) => (
                <a
                  key={n.phone}
                  href={telHref(n.phone)}
                  aria-label={`Позвонить ${n.phone} — ${n.name}`}
                  className="flex flex-col items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-2 py-3 text-center transition-colors hover:bg-[var(--bg-hover)]"
                >
                  <span className="font-playfair text-2xl font-bold tabular-nums text-[var(--text-primary)]">{n.phone}</span>
                  <span className="text-[11px] leading-tight text-[var(--text-secondary)]">{n.type}</span>
                </a>
              ))}
            </div>
          </div>
        </details>

        {/* Что доступно без сети — тихая опора: приложение не умерло */}
        <div className="border-t border-[var(--border)] pt-6">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Доступно без сети
          </p>
          <div className="flex flex-col gap-2">
            <OfflineLink href="/safety/offline" icon={<LifeBuoy className="h-5 w-5" aria-hidden="true" />} label="Инструкции выживания" accent />
            <OfflineLink href="/map" icon={<MapIcon className="h-5 w-5" aria-hidden="true" />} label="Скачанная карта и маршруты" />
            <OfflineLink href="/" icon={<Mountain className="h-5 w-5" aria-hidden="true" />} label="На главную" />
          </div>
        </div>
      </div>

      <p className="mt-8 flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
        <Mountain className="h-3.5 w-3.5" aria-hidden="true" />
        Ведар — Камчатка в кармане
      </p>
    </main>
  );
}

/** Строка с телефоном — крупная зона нажатия, tap-to-call. */
function TelRow({ entry, icon }: { entry: EmergencyNumber; icon: ReactNode }) {
  return (
    <a
      href={telHref(entry.phone)}
      aria-label={`Позвонить ${entry.phone} — ${entry.name}`}
      className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3 transition-colors hover:bg-[var(--bg-hover)]"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--bg-hover)]">
        {icon}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-[var(--text-primary)]">{entry.name}</span>
        <span className="text-lg font-semibold tabular-nums text-[var(--text-primary)]">{entry.phone}</span>
      </span>
      <PhoneCall className="ml-auto h-5 w-5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
    </a>
  );
}

/** Ссылка на офлайн-доступный раздел. */
function OfflineLink({ href, icon, label, accent }: { href: string; icon: ReactNode; label: string; accent?: boolean }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-[var(--bg-hover)]"
      style={accent ? { color: 'var(--danger)' } : { color: 'var(--text-primary)' }}
    >
      {icon}
      <span className={`text-sm ${accent ? 'font-semibold' : 'font-medium'}`}>{label}</span>
    </Link>
  );
}
