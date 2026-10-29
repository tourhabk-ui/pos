/**
 * «Погода в аэропорту» на табло /flights — сводка METAR аэродрома Елизово
 * словами (lib/flights/metar).
 *
 * Табло причину задержки не называет; погода у полосы её чаще всего и
 * объясняет. Блок говорит, ЧЬЁ это наблюдение и откуда пришло, и что это не
 * данные для полётов. Сводки нет — так и сказано; старая сводка помечена
 * старой, а не выдана за «сейчас» (§4.0).
 */
import { CloudSun } from 'lucide-react';
import { kamchatkaClock } from '@/lib/flights/pkc-board';
import { metarLines, METAR_STALE_MIN, type MetarRead } from '@/lib/flights/metar';

export const METAR_ATTRIBUTION =
  'Наблюдение метеостанции аэропорта Елизово (Росгидромет), получено через NOAA Aviation Weather Center. Не для планирования полётов.';

export function AirportWeather({ read }: { read: MetarRead }) {
  return (
    <section className="ds-card p-4" aria-label="Погода в аэропорту">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)]">
        <CloudSun size={18} className="text-[var(--ocean)]" aria-hidden />
        Погода в аэропорту
      </h2>
      {read.kind === 'ok' ? (
        <>
          <p className={`mt-1 text-xs ${read.stale ? 'text-[var(--warning)]' : 'text-[var(--text-muted)]'}`}>
            {(() => {
              const at = kamchatkaClock(read.metar.observedAt as string);
              return read.stale
                ? `Сводка за ${at.time} ${at.date} по Камчатке — старше ${METAR_STALE_MIN} минут, новой нет.`
                : `Сводка за ${at.time} по Камчатке.`;
            })()}
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-sm text-[var(--text-primary)]">
            {metarLines(read.metar).map((line) => <li key={line} className="first-letter:uppercase">{line}</li>)}
          </ul>
          <details className="mt-2 text-xs text-[var(--text-muted)]">
            <summary className="cursor-pointer">Сводка как есть</summary>
            <code className="mt-1 block break-words font-mono">{read.metar.raw}</code>
          </details>
        </>
      ) : (
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          {read.kind === 'none'
            ? 'За три часа сводок погоды аэродрома нет.'
            : `Сводка погоды аэропорта не загрузилась: ${read.reason}.`}
        </p>
      )}
      <p className="mt-2 text-xs text-[var(--text-muted)]">{METAR_ATTRIBUTION}</p>
    </section>
  );
}
