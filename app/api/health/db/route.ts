import { NextResponse } from 'next/server'
import { pool } from '@/lib/db-pool'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/health/db — публичный, только «жива ли база».
 *
 * До этой правки роут сам парсил DATABASE_URL и на любой ошибке отдавал
 * длину/первые символы строки подключения и сырое сообщение драйвера pg —
 * анонимному запросу. Внешний security-аудит владельца 28.08 (P0) поймал
 * это как утечку структуры секрета. Никакой диагностики наружу больше не
 * идёт — только факт связи с БД. Причина отказа — в серверных логах, не в
 * ответе.
 */
export async function GET() {
  try {
    await pool.query('SELECT 1')
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[health/db] проверка связи с БД упала:', err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false }, { status: 503 })
  }
}
