'use client';

/**
 * WebMCP: инструменты Ведара на странице (lib/webmcp/page-tools.ts).
 *
 * Нет API в браузере — ничего не происходит: ни запроса, ни ошибки. На чужой
 * поверхности (виджет в iframe, сайт партнёра на его домене) — тоже ничего:
 * там витрина партнёра (§0), а инструменты Ведара показали бы туры всех
 * компаний. Уход со страницы снимает инструменты отменой сигнала.
 */
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { isForeignSurface } from '@/lib/embed/widget-frame';
import { getModelContext, registerVedarPageTools } from '@/lib/webmcp/page-tools';

export function WebMcpTools() {
  const pathname = usePathname();
  const foreign = isForeignSurface(pathname);
  useEffect(() => {
    if (foreign) return;
    const ctx = getModelContext();
    if (!ctx) return;
    const controller = new AbortController();
    void registerVedarPageTools({ ctx, fetchFn: (input, init) => fetch(input, init), signal: controller.signal })
      .then((outcome) => {
        if (outcome.kind === 'failed') console.error('[webmcp] инструменты страницы не зарегистрированы:', outcome.reason);
      });
    return () => controller.abort();
  }, [foreign]);
  return null;
}
