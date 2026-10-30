/**
 * Табло аэропорта Елизово на Ведаре (/flights) — данные lib/flights/pkc-board.
 *
 * Наверху — то, ради чего сюда приходят: задержанные и отменённые рейсы.
 * Ниже — весь прочитанный вылет и прилёт. Время — камчатское, как на табло;
 * «позже на …» считается из расписания и ожидаемого времени табло.
 *
 * Табло не прочиталось — так и сказано, со ссылкой на табло аэропорта и
 * телефоном справочной: «задержек нет» по непрочитанному табло — враньё.
 * Причину задержки табло не называет, и страница её не придумывает.
 *
 * Серверный компонент без состояния: проверяется рендером
 * (tests/unit/flight-board.test.tsx).
 */
import type { ReactNode } from 'react';
import { PlaneTakeoff, PlaneLanding, AlertTriangle, Phone, ExternalLink } from 'lucide-react';
import {
  kamchatkaClock, lateWords, isDisrupted,
  PKC_BOARD_URL, PKC_INFO_PHONE,
  type BoardFlight, type BoardRead, type PkcBoard,
} from '@/lib/flights/pkc-board';
import type { MetarRead } from '@/lib/flights/metar';
import { AirportWeather } from '@/components/flights/AirportWeather';

function StatusChip({ f }: { f: BoardFlight }) {
  if (!f.status) return <span className="text-xs text-[var(--text-muted)]">статус не указан</span>;
  const tone = f.statusKind === 'other'
    ? 'border-[var(--border)] text-[var(--text-secondary)]'
    : 'border-[var(--warning)] text-[var(--warning)] font-semibold';
  return <span className={`inline-block rounded-lg border px-2 py-0.5 text-xs ${tone}`}>{f.status}</span>;
}

function FlightRow({ f }: { f: BoardFlight }) {
  const sched = kamchatkaClock(f.scheduledAt);
  const exp = f.expectedAt ? kamchatkaClock(f.expectedAt) : null;
  const late = f.lateMinutes !== null && f.lateMinutes >= 15 ? f.lateMinutes : null;
  return (
    <li className="flex items-start gap-3 py-3 border-b border-[var(--border)] last:border-b-0" data-flight={f.flight}>
      <div className="w-14 shrink-0 tabular-nums">
        <div className={late !== null || f.statusKind === 'cancelled' ? 'text-sm text-[var(--text-muted)] line-through' : 'text-base font-semibold text-[var(--text-primary)]'}>
          {sched.time}
        </div>
        <div className="text-xs text-[var(--text-muted)]">{sched.date}</div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold text-[var(--text-primary)]">{f.city}</span>
          {f.cityCode && <span className="text-xs text-[var(--text-muted)]">{f.cityCode}</span>}
        </div>
        <div className="text-xs text-[var(--text-secondary)]">
          {f.flight}{f.airline ? ` · ${f.airline}` : ''}
        </div>
        {f.note && <div className="text-xs text-[var(--text-muted)]">{f.note}</div>}
      </div>
      <div className="shrink-0 text-right">
        <StatusChip f={f} />
        {exp && f.statusKind !== 'cancelled' && (
          <div className="mt-1 text-sm font-semibold tabular-nums text-[var(--text-primary)]">
            {exp.time}{exp.date !== sched.date ? <span className="text-xs font-normal text-[var(--text-muted)]"> {exp.date}</span> : null}
          </div>
        )}
        {late !== null && f.statusKind !== 'cancelled' && (
          <div className="text-xs text-[var(--warning)]">позже на {lateWords(late)}</div>
        )}
      </div>
    </li>
  );
}

function Side({ title, icon, read }: { title: string; icon: ReactNode; read: BoardRead }) {
  return (
    <section className="ds-card p-4" aria-label={title}>
      <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)]">
        {icon}{title}
      </h2>
      {read.kind === 'failed' ? (
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          Табло не загрузилось: {read.reason}. Это не значит, что задержек нет.
        </p>
      ) : read.flights.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--text-secondary)]">На табло сейчас нет рейсов.</p>
      ) : (
        <ul className="mt-1">{read.flights.map((f) => <FlightRow key={`${f.direction}-${f.flight}-${f.scheduledAt}`} f={f} />)}</ul>
      )}
    </section>
  );
}

export function FlightBoardView({ board, metar }: { board: PkcBoard; metar?: MetarRead }) {
  const fetched = kamchatkaClock(board.fetchedAt);
  const loaded = [board.departures, board.arrivals].filter((r): r is Extract<BoardRead, { kind: 'ok' }> => r.kind === 'ok');
  const disrupted = loaded.flatMap((r) => r.flights).filter(isDisrupted);
  const allFailed = loaded.length === 0;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <header>
        <p className="text-xs uppercase tracking-widest text-[var(--text-muted)]">Аэропорт Елизово · PKC</p>
        <h1 className="ds-h1" style={{ fontFamily: 'var(--font-playfair)' }}>Табло аэропорта Елизово</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          {allFailed
            ? `Табло аэропорта спрошено в ${fetched.time} по Камчатке и не прочиталось.`
            : `По табло аэропорта, снято в ${fetched.time} по Камчатке. Время на табло — камчатское.`}
        </p>
      </header>

      {allFailed ? (
        <section className="ds-card p-4 border-l-4 border-l-[var(--warning)]" role="status">
          <p className="font-semibold text-[var(--text-primary)]">Табло аэропорта сейчас не загрузилось</p>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Это не значит, что задержек нет. Проверьте на сайте аэропорта или в справочной.
          </p>
        </section>
      ) : (
        <section className="ds-card p-4" aria-label="Задержки и отмены">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)]">
            <AlertTriangle size={18} className="text-[var(--warning)]" aria-hidden />
            Задержки и отмены
          </h2>
          {disrupted.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--text-secondary)]">
              На прочитанном табло задержек и отмен нет.
            </p>
          ) : (
            <ul className="mt-1">{disrupted.map((f) => <FlightRow key={`d-${f.direction}-${f.flight}-${f.scheduledAt}`} f={f} />)}</ul>
          )}
          <p className="mt-2 text-xs text-[var(--text-muted)]">
            Причину задержки табло не называет. Точное время — у авиакомпании.
          </p>
        </section>
      )}

      {metar && <AirportWeather read={metar} />}

      <Side title="Вылет" icon={<PlaneTakeoff size={18} className="text-[var(--ocean)]" aria-hidden />} read={board.departures} />
      <Side title="Прилёт" icon={<PlaneLanding size={18} className="text-[var(--ocean)]" aria-hidden />} read={board.arrivals} />

      <section className="ds-card p-4 text-sm text-[var(--text-secondary)]">
        <p>
          Уже вылетевшие рейсы аэропорт на табло скрывает. Источник —{' '}
          <a href={PKC_BOARD_URL} className="text-[var(--ocean)] underline" rel="noopener" target="_blank">
            табло на сайте аэропорта <ExternalLink size={12} className="inline" aria-hidden />
          </a>.
        </p>
        <p className="mt-2 flex items-center gap-2">
          <Phone size={14} className="text-[var(--ocean)]" aria-hidden />
          Справочная аэропорта:{' '}
          <a href={`tel:${PKC_INFO_PHONE.replace(/[^\d+]/g, '')}`} className="text-[var(--ocean)] underline">{PKC_INFO_PHONE}</a>
        </p>
      </section>
    </div>
  );
}
