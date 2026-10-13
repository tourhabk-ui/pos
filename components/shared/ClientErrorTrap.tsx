'use client';

import { useEffect } from 'react';
import { reportClientError, flushQueue } from '@/lib/client-errors/report';

/**
 * Ловушка ошибок браузера (решение владельца 13.10: «ловушку»).
 *
 * Слушает окно: необработанные исключения и отклонённые промисы уходят на
 * POST /api/client-errors через lib/client-errors/report (фильтр шума,
 * дедупликация, потолок на загрузку, офлайн-очередь). При появлении сети и
 * при монтировании досылает очередь. Ошибки рендера, пойманные границами
 * React, докладывают сами границы (app/error.tsx, app/global-error.tsx).
 *
 * Сторож: tests/unit/client-error-trap.test.tsx.
 */
export default function ClientErrorTrap() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => { reportClientError('error', e.error ?? e.message); };
    const onRejection = (e: PromiseRejectionEvent) => { reportClientError('unhandledrejection', e.reason); };
    const onOnline = () => { flushQueue(); };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('online', onOnline);
    flushQueue();
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('online', onOnline);
    };
  }, []);
  return null;
}
