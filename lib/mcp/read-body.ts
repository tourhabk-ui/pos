/**
 * Тело запроса MCP как текст, не длиннее предела (проверка MCP 29.09).
 *
 * Длины аргументов режет Zod, но уже ПОСЛЕ разбора, а многомегабайтный POST —
 * дешёвый способ занять память контейнера мимо лимита на вызовы. Чтение
 * обрывается на пределе. Один помощник на оба сервера: публичный
 * (`app/api/mcp`) и партнёрский (`app/api/mcp/partner`).
 */
import type { NextRequest } from 'next/server';

/**
 * Самая длинная осмысленная заявка — комментарий до 2000 символов (около 4 КБ
 * в UTF-8), пакет чтений ещё короче: предел с запасом больше чем вдесятеро.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/** Тело как текст, не длиннее предела; null — длиннее. */
export async function readBodyLimited(request: NextRequest, maxBytes: number = MAX_BODY_BYTES): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
