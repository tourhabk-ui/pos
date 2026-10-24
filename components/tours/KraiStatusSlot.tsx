import Link from 'next/link';

const FM = 'var(--font-jetbrains, ui-monospace, monospace)';

const BOX = 'inline-flex items-center gap-2 rounded-2xl px-3 py-2 text-xs font-semibold uppercase tracking-wider text-white backdrop-blur-md bg-black/40 border border-white/15';

/**
 * Чип «Обстановка в крае» на герое карточки тура.
 *
 * Место занято сразу, ещё до ответа `/api/public/safety-status`: иначе чип
 * появляется поверх заголовка и сдвигает первый экран (CLS, аудит 24.10).
 * Пока обстановки нет — та же плашка скрыта, но её высота уже 44px.
 * `hasAlert === null` — «ещё не знаем», не «спокойно».
 */
export function KraiStatusSlot({ hasAlert }: { hasAlert: boolean | null }) {
  return (
    <div
      data-testid="krai-status-slot"
      className="absolute left-4 right-4 z-[2] flex items-start"
      style={{ top: 'calc(env(safe-area-inset-top, 0px) + 72px)', minHeight: 44 }}
    >
      {hasAlert === null ? (
        <span aria-hidden="true" className={BOX} style={{ fontFamily: FM, minHeight: 44, visibility: 'hidden' }}>
          <span className="w-2 h-2 rounded-full shrink-0" />
          Обстановка в крае
        </span>
      ) : (
        <Link
          href="/safety"
          className={`${BOX} hover:text-white hover:no-underline transition-colors hover:bg-black/55`}
          style={{ fontFamily: FM, minHeight: 44 }}
        >
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ background: hasAlert ? 'var(--warning)' : 'var(--success)' }}
          />
          Обстановка в крае
        </Link>
      )}
    </div>
  );
}
