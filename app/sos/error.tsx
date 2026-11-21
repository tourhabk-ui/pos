'use client';

/**
 * Граница ошибок экрана SOS (/sos и /sos/relay).
 *
 * 21.11 владелец открыл /sos на экране в машине, и страница упала:
 * общая граница показала «Произошла ошибка» с «Попробовать снова» и «На
 * главную» — без номера 112 и без пути к экрану, который работает. На экране
 * SOS это худший исход: человек пришёл звать помощь.
 *
 * Здесь первым идёт то, что работает при любой поломке страницы: звонок 112
 * и `/emergency` — экран SOS без React и без сети. Ниже — что случилось и
 * кнопка повтора (у не догрузившегося куска — одна автоперезагрузка, как у
 * всех границ: правило в lib/client-errors/chunk-load.ts).
 *
 * Сторожа: tests/unit/error-boundaries-chunk-load.test.tsx (каждая граница),
 * tests/unit/error-screens-emergency.test.tsx (112 и экран SOS).
 */
import { useBoundaryError } from '@/hooks/use-boundary-error';
import { ErrorEmergencyLinks } from '@/components/shared/ErrorEmergencyLinks';
import { CHUNK_TEXT, browserPage, chunkNoticeBody } from '@/lib/client-errors/chunk-load';
import { EMERGENCY_PRIMARY } from '@/lib/safety/emergency-numbers';

const SOS_ERROR_TEXT = {
  title: 'Экран SOS не открылся',
  failed: 'Страница SOS столкнулась с ошибкой.',
  retry: 'Попробовать снова',
} as const;

export default function SosError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { chunk, decision } = useBoundaryError(error);
  const reloading = chunk && decision === 'reload';
  return (
    <main className="min-h-screen bg-[var(--bg-primary)] px-4 py-8">
      <div className="mx-auto max-w-md flex flex-col gap-5">
        <div>
          <h1 className="font-playfair text-3xl font-bold text-[var(--text-primary)]">{SOS_ERROR_TEXT.title}</h1>
          {EMERGENCY_PRIMARY.hint && (
            <p className="mt-2 text-sm text-[var(--text-secondary)]">{EMERGENCY_PRIMARY.hint}</p>
          )}
        </div>

        <ErrorEmergencyLinks prominent />

        <div role="alert" className="text-center">
          {chunk && <p className="text-base font-bold text-[var(--text-primary)]">{CHUNK_TEXT.title}</p>}
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            {chunk ? chunkNoticeBody(decision) : SOS_ERROR_TEXT.failed}
          </p>
          {!reloading && (
            <button
              type="button"
              onClick={chunk ? () => browserPage.reload() : reset}
              className="ds-btn ds-btn-secondary mt-4"
            >
              {chunk ? CHUNK_TEXT.button : SOS_ERROR_TEXT.retry}
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
