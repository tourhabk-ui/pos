import { NextResponse } from 'next/server';
import { llmsZhFile } from '@/lib/mcp/zh-layer';
import { recordAgentEntryHit } from '@/lib/analytics/agent-entry-hits';

const BASE = 'https://vedarai.ru';

/** Китайский llms-файл (17.10): текст целиком из lib/mcp/zh-layer, БД не читается. */
export async function GET(request?: Request) {
  // Перепись краулеров по семействам: новая дверь без счётчика отвечала бы на
  // вопрос «ходят ли китайские агенты» молчанием, неотличимым от «не ходят»
  // (та же причина, по которой 15.10 в счёт взяли /zh и sitemap).
  recordAgentEntryHit('/llms-zh.txt', request?.headers.get('user-agent') ?? null);
  return new NextResponse(llmsZhFile(BASE), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Language': 'zh-CN',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
