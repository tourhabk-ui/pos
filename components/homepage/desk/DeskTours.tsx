import Link from 'next/link';
import { ArrowRight, BedDouble, CalendarCheck, CalendarX, MessageSquareText, RotateCcw, Truck } from 'lucide-react';
import type { Plate } from '@/app/_home/data';
import { plateFacts } from '@/lib/home/plate-facts';
import { activityLabel } from '@/lib/tours/labels';
import { photoSrc } from '@/lib/images/variant';
import { AVAILABILITY_LABEL } from '@/lib/tours/catalog-availability';
import { tourPath } from '@/lib/tours/tour-url';
import { withTransferPlate, isTransferPlate, type TransferPlate } from '@/lib/home/transfer-plate';
import { withStayPlate, isStayPlate, type StayPlate } from '@/lib/home/stay-plate';

/**
 * «Можно поехать» — туры витрины крупной карточкой и строками (доска
 * «Десктоп — сводка дня», 30.09).
 *
 * Источник один с телефоном — fetchPlates: порядок (операторы по очереди, у каждого сначала туры с датами),
 * фильтр живого тура и правило сезона общие на оба дерева. Факты карточки —
 * plateFacts, как у каталога. Чего в данных нет, того нет и здесь: вместо
 * выдуманных «12 мест» и «сегодня» — исход по датам словами
 * (AVAILABILITY_LABEL), вместо сочинённой заметки о погоде — дословные
 * условия отмены оператора, если он их записал.
 *
 * Последняя строка — заявка (/request): тур не подошёл — у человека остаётся
 * следующий шаг (#33).
 *
 * Между турами — строка трансфера (решение владельца 09.10), на том же месте,
 * что в ленте телефона: после второго тура. Цена — за машину, не за место.
 * Последней строкой туров — жильё (владелец 10.10), как пятая карточка ленты
 * телефона: цена «от» нижней за сутки.
 */

function Availability({ p, glass = false }: { p: Plate; glass?: boolean }) {
  const Icon = p.availability === 'season_over' ? CalendarX : CalendarCheck;
  const text = AVAILABILITY_LABEL[p.availability];
  if (glass) {
    return (
      <span className="fx-glass inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-semibold" style={{ color: 'var(--glass-fg)' }}>
        <Icon size={14} aria-hidden /> {text}
      </span>
    );
  }
  return <>{text}</>;
}

function Featured({ p }: { p: Plate }) {
  const f = plateFacts(p);
  const activity = p.category && p.category !== 'tour' ? activityLabel(p.category) : null;
  const meta = [activity, f.duration, f.operator].filter(Boolean).join(' · ');
  return (
    <Link
      href={tourPath(p)}
      className="group grid h-[400px] grid-cols-2 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] no-underline shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:no-underline hover:shadow-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ocean)]"
    >
      <div className="relative overflow-hidden bg-[var(--bg-hover)]">
        {p.imageUrl && (
          <div
            className="absolute inset-0 bg-cover bg-top transition-transform duration-500 group-hover:scale-[1.04]"
            style={{ backgroundImage: `url('${photoSrc(p.imageUrl, 1280)}')` }}
            aria-hidden
          />
        )}
        <span className="absolute left-3.5 top-3.5"><Availability p={p} glass /></span>
      </div>
      <div className="flex min-w-0 flex-col gap-2.5 p-6">
        {meta && <span className="text-xs uppercase tracking-[0.08em] text-[var(--text-secondary)] line-clamp-1">{meta}</span>}
        <h3 className="font-playfair text-[26px] font-bold leading-[1.15] text-[var(--text-primary)] line-clamp-3 transition-colors duration-200 group-hover:text-[var(--accent)]">
          {p.title}
        </h3>
        {p.description && <p className="text-sm leading-relaxed text-[var(--text-secondary)] line-clamp-3">{p.description}</p>}
        {p.cancellationPolicy && (
          <p className="flex items-start gap-2 rounded-lg bg-[var(--bg-primary)] px-3 py-2.5 text-[13px] leading-snug text-[var(--text-primary)]">
            <RotateCcw size={15} className="mt-0.5 flex-shrink-0 text-[var(--ocean)]" aria-hidden />
            <span className="line-clamp-2">{p.cancellationPolicy}</span>
          </p>
        )}
        <div className="mt-auto flex items-center justify-between gap-3 pt-2">
          {f.price
            ? <span className="whitespace-nowrap text-xl font-bold tabular-nums lining-nums text-[var(--text-primary)]">{f.price}</span>
            : <span className="text-base text-[var(--text-secondary)]">Цена по запросу</span>}
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--accent)]">
            Подробнее
            <ArrowRight size={16} className="transition-transform duration-200 group-hover:translate-x-1" aria-hidden />
          </span>
        </div>
      </div>
    </Link>
  );
}

function Row({ p }: { p: Plate }) {
  const f = plateFacts(p);
  return (
    <Link
      href={tourPath(p)}
      className="group grid grid-cols-[96px_minmax(0,1fr)] items-center gap-4 border-t border-[var(--border)] py-4 no-underline hover:no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ocean)]"
    >
      <span className="relative h-24 w-24 overflow-hidden rounded-lg bg-[var(--bg-hover)]">
        {p.imageUrl && (
          <span
            className="absolute inset-0 bg-cover bg-top transition-transform duration-300 group-hover:scale-[1.06]"
            style={{ backgroundImage: `url('${photoSrc(p.imageUrl, 640)}')` }}
            aria-hidden
          />
        )}
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="line-clamp-1 text-[13px] text-[var(--text-secondary)]">
          {[AVAILABILITY_LABEL[p.availability], f.operator].filter(Boolean).join(' · ')}
        </span>
        <span className="line-clamp-2 text-[17px] font-semibold leading-snug text-[var(--text-primary)] transition-colors duration-200 group-hover:text-[var(--accent)]">
          {p.title}
        </span>
        {f.price
          ? <span className="text-[15px] tabular-nums lining-nums text-[var(--text-primary)]">{f.price}</span>
          : <span className="text-[15px] text-[var(--text-secondary)]">Цена по запросу</span>}
      </span>
    </Link>
  );
}

function TransferRow({ t }: { t: TransferPlate }) {
  return (
    <Link
      href={t.href}
      className="group grid grid-cols-[96px_minmax(0,1fr)] items-center gap-4 border-t border-[var(--border)] py-4 no-underline hover:no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ocean)]"
    >
      <span className="relative grid h-24 w-24 place-items-center overflow-hidden rounded-lg bg-[var(--bg-hover)] text-[var(--ocean)]">
        {t.imageUrl ? (
          <span
            className="absolute inset-0 bg-cover bg-top transition-transform duration-300 group-hover:scale-[1.06]"
            style={{ backgroundImage: `url('${photoSrc(t.imageUrl, 640)}')` }}
            aria-hidden
          />
        ) : <Truck size={28} aria-hidden />}
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="line-clamp-1 text-[13px] text-[var(--text-secondary)]">
          {['Трансфер под заказ', t.fleet].filter(Boolean).join(' · ')}
        </span>
        <span className="line-clamp-2 text-[17px] font-semibold leading-snug text-[var(--text-primary)] transition-colors duration-200 group-hover:text-[var(--accent)]">
          {t.title}{t.destinations.length > 0 ? `: ${t.destinations.join(', ')}` : ''}
        </span>
        {t.price
          ? <span className="text-[15px] tabular-nums lining-nums text-[var(--text-primary)]">{t.price}</span>
          : <span className="text-[15px] text-[var(--text-secondary)]">Цена по запросу</span>}
      </span>
    </Link>
  );
}

function StayRow({ t }: { t: StayPlate }) {
  return (
    <Link
      href={t.href}
      className="group grid grid-cols-[96px_minmax(0,1fr)] items-center gap-4 border-t border-[var(--border)] py-4 no-underline hover:no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ocean)]"
    >
      <span className="relative h-24 w-24 overflow-hidden rounded-lg bg-[var(--bg-hover)]">
        <span
          className="absolute inset-0 bg-cover bg-top transition-transform duration-300 group-hover:scale-[1.06]"
          style={{ backgroundImage: `url('${photoSrc(t.imageUrl, 640)}')` }}
          aria-hidden
        />
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="inline-flex min-w-0 items-center gap-1.5 truncate text-[13px] text-[var(--text-secondary)]">
          <BedDouble size={13} aria-hidden /> {['Жильё', t.place].filter(Boolean).join(' · ')}
        </span>
        <span className="line-clamp-2 text-[17px] font-semibold leading-snug text-[var(--text-primary)] transition-colors duration-200 group-hover:text-[var(--accent)]">
          {t.title}{t.caption ? `: ${t.caption}` : ''}
        </span>
        <span className="text-[15px] tabular-nums lining-nums text-[var(--text-primary)]">{t.price}</span>
      </span>
    </Link>
  );
}

export function DeskTours({ plates, transfer = null, stay = null, total }: { plates: readonly Plate[]; transfer?: TransferPlate | null; stay?: StayPlate | null; total: number | null }) {
  const first = plates[0];
  // Трансфер встаёт между турами по общему правилу ленты (после второго тура);
  // первый тур — крупная карточка, строки — всё, что после него.
  const rows = withStayPlate(withTransferPlate(plates.slice(0, 4), transfer), stay, plates.length > 0).slice(1);
  return (
    <section className="flex flex-col gap-6" aria-labelledby="desk-tours-title">
      <div className="flex items-end justify-between gap-6">
        <div className="flex flex-col gap-1.5">
          <h2 id="desk-tours-title" className="font-playfair text-4xl font-bold tracking-[-0.01em] text-[var(--text-primary)]">Можно поехать</h2>
          <p className="text-[15px] text-[var(--text-secondary)]">Туры операторов: цена, даты и условия отмены — до звонка</p>
        </div>
        <div className="flex items-center gap-6">
          {/* Трансфер (владелец 09.10: «доп кнопка на главной») — тот же адрес, что у плитки телефона. */}
          <Link href="/transfers" className="group inline-flex min-h-[44px] items-center gap-1.5 text-base font-semibold text-[var(--ocean)] no-underline hover:no-underline">
            Трансфер
            <ArrowRight size={18} className="transition-transform duration-200 group-hover:translate-x-1" aria-hidden />
          </Link>
          {/* Жильё (владелец 10.10: «кнопку на главную жильё») — тот же адрес, что у плитки телефона. */}
          <Link href="/accommodations" className="group inline-flex min-h-[44px] items-center gap-1.5 text-base font-semibold text-[var(--ocean)] no-underline hover:no-underline">
            Жильё
            <ArrowRight size={18} className="transition-transform duration-200 group-hover:translate-x-1" aria-hidden />
          </Link>
          <Link href="/catalog" className="group inline-flex min-h-[44px] items-center gap-1.5 text-base font-semibold text-[var(--ocean)] no-underline hover:no-underline">
            {total != null && total > 0 ? `Все туры (${total})` : 'Все туры'}
            <ArrowRight size={18} className="transition-transform duration-200 group-hover:translate-x-1" aria-hidden />
          </Link>
        </div>
      </div>

      {first ? (
        <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-12 lg:gap-14">
          <div className="lg:col-span-7"><Featured p={first} /></div>
          <div className="flex flex-col lg:col-span-5">
            {rows.map((p) => (isStayPlate(p) ? <StayRow key={p.id} t={p} /> : isTransferPlate(p) ? <TransferRow key={p.id} t={p} /> : <Row key={p.id} p={p} />))}
            <Link
              href="/request"
              className="group flex items-center gap-4 border-y border-[var(--border)] py-4 no-underline hover:no-underline"
            >
              <span className="grid h-12 w-12 flex-shrink-0 place-items-center rounded-full bg-[var(--bg-hover)] text-[var(--accent)]">
                <MessageSquareText size={20} aria-hidden />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-[17px] font-semibold text-[var(--text-primary)]">Не нашли свой тур?</span>
                <span className="text-sm text-[var(--text-secondary)]">Опишите даты и группу — подберём варианты под заявку</span>
              </span>
              <ArrowRight size={18} className="ml-auto flex-shrink-0 text-[var(--accent)] transition-transform duration-200 group-hover:translate-x-1" aria-hidden />
            </Link>
          </div>
        </div>
      ) : (
        <p className="border-t border-[var(--border)] py-5 text-[15px] text-[var(--text-secondary)]">
          Витрину туров сейчас загрузить не удалось — полный список в <Link href="/catalog" className="text-[var(--ocean)]">каталоге</Link>.
        </p>
      )}
    </section>
  );
}
