/**
 * GET /.well-known/oauth-authorization-server — метаданные сервера
 * авторизации (RFC 8414). Сервер авторизации у Ведара один и служит только
 * MCP партнёра: вход в CRM своим агентом кнопкой «Подключить» в Claude.
 *
 * Регистрации клиентов (DCR) нет намеренно: Claude представляется документом
 * CIMD, и доверяем мы только client_id на claude.ai
 * (lib/crm/partner-oauth-public.ts). Каждая регистрация была бы строкой в
 * базе от любого, кто постучит, — а пускать мы всё равно никого другого не
 * собираемся.
 */
import { NextResponse } from 'next/server';
import { authorizationServerMetadata } from '@/lib/crm/partner-oauth-metadata';

export function GET() {
  return NextResponse.json(authorizationServerMetadata(), {
    headers: { 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' },
  });
}
