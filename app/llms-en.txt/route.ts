import { NextResponse } from 'next/server';
import { llmsEnFile } from '@/lib/mcp/en-layer';
import { recordAgentEntryHit } from '@/lib/analytics/agent-entry-hits';

const BASE = 'https://vedarai.ru';

/** English llms file: canonical identity for English-language agents/RAG. */
export async function GET(request?: Request) {
  recordAgentEntryHit('/llms-en.txt', request?.headers.get('user-agent') ?? null);
  return new NextResponse(llmsEnFile(BASE), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Language': 'en',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
