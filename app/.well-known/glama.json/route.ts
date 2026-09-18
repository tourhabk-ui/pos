/**
 * GET /.well-known/glama.json — HTTP challenge Glama: доказательство, что
 * коннектор `ru.vedarai/mcp` принадлежит владельцу домена. Строка и
 * объяснение — lib/mcp/catalogs.ts; здесь только отдача JSON в той форме,
 * которую Glama показал на странице claim (18.09): `$schema` и `claim`.
 *
 * Роут постоянный: Glama перепроверяет файл, чтобы владение оставалось
 * подтверждённым. Убрать его — потерять Admin коннектора.
 */

import { NextResponse } from 'next/server';
import { GLAMA_CLAIM, GLAMA_CONNECTOR_SCHEMA } from '@/lib/mcp/catalogs';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(
    { $schema: GLAMA_CONNECTOR_SCHEMA, claim: GLAMA_CLAIM },
    {
      headers: {
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
}
