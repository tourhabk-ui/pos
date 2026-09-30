import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight, CalendarDays, Compass, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { clip } from '@/lib/safety/alert-clip';
import { ShareButton } from '@/components/shared/ShareButton';
import { HOME_CONTAINER } from '@/lib/home/desktop-layout';
import { plural } from '@/lib/home/data-freshness';
import { alertSeverityWord } from '@/lib/safety/severity-words';
import { EMERGENCY_PRIMARY } from '@/lib/safety/emergency-numbers';
import type { DeskBrief } from '@/lib/home/desk-brief';

/**
 * Первый экран десктопной главной — «сводка дня поверх фото» (доска
 * «Десктоп — сводка дня», 30.09).
 *
 * Слева — ответ новому человеку: H1 и один главный шаг (/planner). Заголовок —
 * решение владельца 14.08, и «новость дня» его не подменяет: новость живёт
 * справа, в стеклянной карточке, и завтра станет другой, а H1 — нет.
 *
 * Справа — сама сводка: главное предупреждение и три прибора. У каждого три
 * исхода (§4.0): число, «нет» и «не знаем». Прочерк с подписью «нет данных» —
 * честнее нуля: ноль вулканов выше фона и упавший источник выглядели бы
 * одинаково.
 *
 * Стекло — поверх фото (§2), тёмное; текст на нём — --glass-fg.
 *
 * Фото — снимок владельца (Три Брата и вулканы, выбор 30.09). Исходник
 * 600 px по ширине: на широком экране он мягкий, резкость вернёт только
 * оригинал в полном размере.
 */

function signed(n: number): string {
  const r = Math.round(n);
  return `${r < 0 ? '−' : ''}${Math.abs(r)}°`;
}

interface Tile { label: string; value: string; hint: string; href: string; aria: string }

function tiles(brief: DeskBrief): Tile[] {
  const s = brief.svodka;

  const v = s?.volcanoes ?? null;
  // Ноль при непроверенных источниках — не «все на фоне», а «не знаем»:
  // пустой список у упавших KVERT и КФ ЕГС выглядел бы спокойствием.
  const vRaw = v ? v.items.length + v.more : null;
  const vCount = vRaw === 0 && !v!.complete ? null : vRaw;
  const volcano: Tile = {
    label: 'Вулканы',
    value: vCount == null ? '—' : String(vCount),
    hint: vCount == null ? (v ? 'проверены не все' : 'нет данных') : vCount > 0 ? 'выше фона' : 'все на фоне',
    href: '/safety#radar',
    aria: vCount == null ? 'Вулканы: сводку получить не удалось' : `Вулканов выше фона: ${vCount}`,
  };

  const w = s?.weather.find((x) => x.name === 'Авачинский') ?? null;
  const day = w?.days?.[0] ?? null;
  const t = day?.tempMax ?? day?.tempMin ?? null;
  const wHint = day
    ? [day.description?.toLowerCase(), day.precipMm != null && day.precipMm >= 1 ? `${Math.round(day.precipMm)} мм` : null]
        .filter(Boolean).join(', ') || 'прогноз есть'
    : 'прогноза нет';
  const weather: Tile = {
    label: 'Авачинский',
    value: t == null ? '—' : signed(t),
    hint: wHint,
    href: '/svodka',
    aria: t == null ? 'Погода на Авачинском: прогноз не получили' : `Авачинский сегодня ${signed(t)}, ${wHint}`,
  };

  // Пустая лента при молчащем кроне — не «ноль», а «не знаем».
  const feedRaw = s?.safety?.feedCount ?? null;
  const feed = feedRaw === 0 && !brief.safetyTrusted ? null : feedRaw;
  const active = s?.safety?.activeCount ?? null;
  const plan: Tile = {
    label: 'Меняют план',
    value: feed == null ? '—' : String(feed),
    hint: feed == null ? 'нет данных' : active != null && active > 0 ? `из ${active} ${plural(active, 'активного', 'активных', 'активных')}` : 'предупреждений',
    href: '/safety/incidents',
    aria: feed == null ? 'Предупреждения: ленту получить не удалось' : `Меняют план: ${feed}`,
  };

  return [volcano, weather, plan];
}

function AlertCard({ brief }: { brief: DeskBrief }) {
  const safety = brief.svodka?.safety ?? null;
  const hasTop = !!safety && safety.hasAlert && !!safety.topTitle;

  // Не прочитали — или прочитали пустоту у ленты, которая молчит больше
  // INGEST_STALE_MS: в обоих случаях «предупреждений нет» было бы выдумкой.
  if (!safety || (!hasTop && !brief.safetyTrusted)) {
    return (
      <Link href="/safety" className="fx-glass-dense group block rounded-2xl px-5 py-4 transition-all duration-200 hover:bg-black/75" style={{ color: 'var(--glass-fg)' }}>
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--glass-fg-muted)' }}>
          <ShieldQuestion size={14} aria-hidden /> Обстановка неизвестна
        </span>
        <span className="mt-2 block text-[17px] font-semibold leading-snug">
          {safety
            ? 'Лента предупреждений давно не обновлялась. Это не значит, что всё спокойно.'
            : 'Источник предупреждений сейчас не ответил. Это не значит, что всё спокойно.'}
        </span>
        <span className="mt-2 block text-xs" style={{ color: 'var(--glass-fg-muted)' }}>
          Перед выходом уточните обстановку: {EMERGENCY_PRIMARY.phone} — {EMERGENCY_PRIMARY.name}
        </span>
      </Link>
    );
  }

  if (!hasTop || !safety.topTitle) {
    return (
      <Link href="/safety" className="fx-glass-dense group block rounded-2xl px-5 py-4 transition-all duration-200 hover:bg-black/75" style={{ color: 'var(--glass-fg)' }}>
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--success)' }}>
          <ShieldCheck size={14} aria-hidden /> Сводка дня
        </span>
        <span className="mt-2 block text-[17px] font-semibold leading-snug">Действующих предупреждений нет</span>
        <span className="mt-2 block text-xs" style={{ color: 'var(--glass-fg-muted)' }}>{clip(safety.source, 120)}</span>
      </Link>
    );
  }

  return (
    <Link
      href="/safety"
      className="fx-glass-dense group block rounded-2xl border-l-[3px] px-5 py-4 transition-all duration-200 hover:bg-black/75"
      style={{ color: 'var(--glass-fg)', borderLeftColor: 'var(--warning)' }}
    >
      <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--warning)' }}>
        <ShieldAlert size={14} aria-hidden /> Главное сегодня · {alertSeverityWord(safety.maxSeverity)}
      </span>
      {/* Обрезка — общий clip(): та же, что у ленты /safety, чтобы две
          поверхности об одном предупреждении говорили одинаково. */}
      <span className="mt-2 block text-[17px] font-semibold leading-snug">{clip(safety.topTitle, 140)}</span>
      <span className="mt-2 flex items-center justify-between gap-3 text-xs" style={{ color: 'var(--glass-fg-muted)' }}>
        <span className="min-w-0 truncate">{safety.source}</span>
        <span className="flex flex-shrink-0 items-center gap-1 transition-transform duration-200 group-hover:translate-x-0.5" style={{ color: 'var(--glass-fg)' }}>
          Подробнее <ArrowRight size={13} aria-hidden />
        </span>
      </span>
    </Link>
  );
}

export function DeskHero({ brief }: { brief: DeskBrief }) {
  return (
    <section className="relative isolate overflow-hidden" aria-label="Сводка дня">
      <Image
        src="/images/hero/IMG_20260316_133142.jpg"
        alt="Скалы Три Брата в Авачинской бухте, на горизонте вулканы"
        fill
        priority
        sizes="100vw"
        className="-z-20 object-cover object-[50%_30%]"
      />
      {/* Слева плотнее — там текст; справа фото дышит. Снизу — переход к странице. */}
      <div className="absolute inset-0 -z-10 bg-gradient-to-r from-black/90 via-black/65 to-black/25" aria-hidden />
      <div className="absolute inset-x-0 top-0 -z-10 h-40 bg-gradient-to-b from-black/60 to-transparent" aria-hidden />

      <div className={`${HOME_CONTAINER} grid min-h-[640px] grid-cols-1 items-end gap-10 pb-14 pt-[120px] lg:grid-cols-12 lg:gap-14 xl:min-h-[680px]`}>
        <div className="flex flex-col gap-5 lg:col-span-7">
          <span className="text-[13px] font-semibold uppercase tracking-[0.18em] text-white/75">
            {brief.weekdayLabel} · Сводка дня
          </span>
          {/* Единственный h1 десктопного дерева (#45/#126), формулировка —
              решение владельца 14.08. */}
          <h1 className="font-playfair text-5xl font-bold leading-[1.02] tracking-[-0.02em] text-white [text-wrap:balance] xl:text-[68px]">
            Соберите безопасную поездку на Камчатку
          </h1>
          <p className="max-w-[520px] text-lg leading-relaxed text-white/80">
            Подберём варианты по сезону, нагрузке и реальным условиям маршрутов. Всё, что меняет планы
            сегодня, — справа и ниже, с источником у каждой строки.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Link
              href="/planner"
              className="inline-flex h-12 items-center gap-2 rounded-full px-6 text-[15px] font-semibold text-white shadow-lg shadow-black/30 transition-all duration-200 hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white active:scale-[0.98]"
              style={{ background: 'var(--accent)' }}
            >
              <CalendarDays size={18} aria-hidden />
              Собрать план
            </Link>
            <Link
              href="/catalog"
              className="fx-glass inline-flex h-12 items-center gap-2 rounded-full px-6 text-[15px] font-semibold transition-all duration-200 hover:bg-black/55 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white active:scale-[0.98]"
              style={{ color: 'var(--glass-fg)' }}
            >
              <Compass size={18} aria-hidden />
              Смотреть туры
            </Link>
            {/* Реферальная ссылка — тот же вход, что был в прежнем герое. */}
            <ShareButton
              referral
              size={17}
              className="fx-glass grid h-12 w-12 place-items-center rounded-full text-white/90 transition-all duration-200 hover:bg-black/55"
              title="Ведар — Камчатка"
              text="Маршруты, безопасность и проверенные туры по Камчатке"
              referralText="Приглашаю в Ведар: маршруты и проверенные туры по Камчатке. По моей ссылке — бонус на первую поездку"
            />
          </div>
        </div>

        <div className="flex flex-col gap-2.5 lg:col-span-5">
          <AlertCard brief={brief} />
          <div className="grid grid-cols-3 gap-2.5">
            {tiles(brief).map((t) => (
              <Link
                key={t.label}
                href={t.href}
                aria-label={t.aria}
                className="fx-glass group flex flex-col gap-1 rounded-2xl p-3.5 transition-all duration-200 hover:-translate-y-0.5 hover:bg-black/55 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                style={{ color: 'var(--glass-fg)' }}
              >
                <span className="text-xs uppercase tracking-[0.08em]" style={{ color: 'var(--glass-fg-muted)' }}>{t.label}</span>
                <span className="font-playfair text-[32px] font-bold leading-none tabular-nums lining-nums">{t.value}</span>
                <span className="line-clamp-2 text-[13px] leading-snug" style={{ color: 'var(--glass-fg-muted)' }}>{t.hint}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
