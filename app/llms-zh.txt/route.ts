import { NextResponse } from 'next/server';
import { llmsZhFile } from '@/lib/mcp/zh-layer';

const BASE = 'https://vedarai.ru';

/** Китайский llms-файл (17.10): текст целиком из lib/mcp/zh-layer, БД не читается. */
export async function GET() {
  return new NextResponse(llmsZhFile(BASE), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Language': 'zh-CN',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
