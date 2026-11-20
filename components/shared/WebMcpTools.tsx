'use client';

import { useEffect } from 'react';
import { getModelContext, registerVedarPageTools } from '@/lib/webmcp/page-tools';

/**
 * Инструменты Ведара для агента в браузере (WebMCP, lib/webmcp/page-tools).
 *
 * Стоит в корневом layout один раз: при переходах внутри сайта он не
 * пересоздаётся, и инструменты не регистрируются заново. Нет API — нет ни
 * запроса, ни ошибки. Ничего не рисует.
 */
export function WebMcpTools() {
  useEffect(() => {
    const ctx = getModelContext();
    if (!ctx) return;
    const controller = new AbortController();
    void registerVedarPageTools({
      ctx,
      fetchFn: (input, init) => fetch(input, init),
      signal: controller.signal,
    }).then((outcome) => {
      if (outcome.kind === 'failed') console.error('[webmcp] инструменты страницы не зарегистрированы:', outcome.reason);
    });
    return () => controller.abort();
  }, []);
  return null;
}
