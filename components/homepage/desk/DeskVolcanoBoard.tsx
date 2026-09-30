import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import type { Svodka } from '@/lib/svodka/svodka';

/**
 * Табло вулканов — тёмная панель рядом с лентой (доска «Десктоп — сводка
 * дня», 30.09). Два кода рядом, потому что они про разное: пепел — KVERT
 * (авиационный код), сейсмика — КФ ЕГС. Строки — `elevatedVolcanoes` через
 * сводку: тот же отбор и порядок, что у Кузьмича и MCP.
 *
 * Нет кода — пустой кружок и «нет», а не зелёный: «не знаем» и «спокоен»
 * разные состояния (§4.0).
 */

const DOT: Record<string, { color: string; word: string }> = {
  green: { color: 'var(--success)', word: 'зелёный' },
  yellow: { color: 'var(--warning)', word: 'жёлтый' },
  orange: { color: 'var(--accent)', word: 'оранж.' },
  red: { color: 'var(--danger)', word: 'красный' },
};

function Code({ code }: { code: string | null }) {
  const d = code ? DOT[code] : undefined;
  if (!d) {
    return (
      <span className="fx-dark-muted flex items-center gap-1.5 text-[13px]">
        <span className="h-2.5 w-2.5 rounded-full border-[1.5px] border-current" aria-hidden />
        нет
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-[13px]">
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: d.color }} aria-hidden />
      {d.word}
    </span>
  );
}

const ROW = 'grid grid-cols-[minmax(0,1fr)_88px_88px] items-center gap-2';
const LINE = { borderColor: 'rgba(255,255,255,0.08)' };

export function DeskVolcanoBoard({ volcanoes }: { volcanoes: Svodka['volcanoes'] }) {
  return (
    <div className="fx-dark-panel flex flex-col rounded-2xl p-7">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="font-playfair text-[28px] font-bold">Табло вулканов</h2>
        <span className="fx-dark-muted text-xs">KVERT · КФ ЕГС</span>
      </div>

      {volcanoes === null ? (
        <p className="fx-dark-muted py-4 text-sm leading-relaxed">
          Сводку вулканов сейчас получить не удалось. Это не значит, что активности нет.
        </p>
      ) : volcanoes.items.length === 0 ? (
        <p className="py-4 text-[15px] leading-relaxed">
          {volcanoes.complete
            ? 'Повышенной активности нет ни у одного вулкана.'
            : 'По доступным данным повышенной активности нет, но проверены не все источники.'}
        </p>
      ) : (
        <div role="table" aria-label="Вулканы выше фона">
          <div role="row" className={`${ROW} fx-dark-muted border-b pb-2 text-xs uppercase tracking-[0.1em]`} style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
            <span role="columnheader">Вулкан</span>
            <span role="columnheader">Пепел</span>
            <span role="columnheader">Сейсмика</span>
          </div>
          {volcanoes.items.slice(0, 5).map((v, i, arr) => (
            <div role="row" key={v.name} className={`${ROW} py-3 ${i < arr.length - 1 ? 'border-b' : ''}`} style={LINE}>
              <span role="cell" className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-playfair text-lg font-semibold">{v.name}</span>
                {v.ashKm != null && <span className="fx-dark-muted text-xs">пепел до {v.ashKm} км</span>}
              </span>
              <span role="cell"><Code code={v.ashCode} /></span>
              <span role="cell"><Code code={v.tremorCode} /></span>
            </div>
          ))}
          {volcanoes.items.length + volcanoes.more > 5 && (
            <p className="fx-dark-muted border-t pt-3 text-xs" style={LINE}>
              и ещё {volcanoes.items.length + volcanoes.more - 5} выше фона
            </p>
          )}
        </div>
      )}

      <p className="fx-dark-muted mt-4 text-xs leading-relaxed">
        Код — об активности вулкана, а не разрешение на выход. {volcanoes?.sources ?? ''}
      </p>
      <Link href="/safety#radar" className="fx-dark-ocean group mt-4 inline-flex items-center gap-1.5 text-sm font-semibold no-underline hover:no-underline">
        Радар угроз
        <ArrowRight size={16} className="transition-transform duration-200 group-hover:translate-x-1" aria-hidden />
      </Link>
    </div>
  );
}
