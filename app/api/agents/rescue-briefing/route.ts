/**
 * GET /api/agents/rescue-briefing?type=sos|weather|protocols — брифинг для
 * блока «AI Спасатель — Начальник SAR» на админ-дашборде безопасности. Admin-only.
 *
 * Заземляем на РЕАЛЬНЫЕ активные алерты (external_alerts), AI лишь синтезирует
 * сводку. Если AI недоступен — отдаём сырые данные (safety-дашборд не должен
 * зависеть только от модели). Ответ: { success, response } либо { success:false, error }.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { callAIWaterfall } from '@/lib/ai/providers';
import type { ChatMessage } from '@/lib/ai/prompts';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type BriefingType = 'sos' | 'weather' | 'protocols';

interface AlertRow { title: string; severity: number; description: string | null }

const SYSTEM = `Ты — AI Спасатель, Начальник SAR Камчатки. Готовишь короткую оперативную сводку для координатора МЧС. Только на основе переданных данных — НЕ выдумывай инциденты, координаты, цифры. Если данных нет, так и скажи. Стиль штабной, нумерованные пункты, без воды. Русский язык.`;

const PROTOCOLS_STATIC = `Ключевые протоколы (справка):
1. Пропавшая группа: last-seen точка → радиус по времени и рельефу → приоритет спусков к воде/тропам → 3 сигнала = бедствие.
2. Переохлаждение: сухо, от ветра, тёплое сладкое питьё; тяжёлая стадия — горизонтально, не растирать, 112.
3. Кровотечение: прямое давление → жгут выше раны с отметкой времени.
4. Медведь: не бежать, быть заметным/громким, медленно отступать, при атаке защитить шею.
5. Вулканический выброс: уход перпендикулярно ветру, защита дыхания (влажная ткань/P100), в яму при пирокластике.
Экстренно: 112 · ПАСС 8 (4152) 41-03-03 · ЭКОСПАС 8 (4152) 42-40-27.`;

function fmtAlerts(rows: AlertRow[]): string {
  if (rows.length === 0) return 'Активных алертов в системе нет.';
  return rows.map((a) => `• [severity ${a.severity}] ${a.title}${a.description ? ` — ${a.description.slice(0, 200)}` : ''}`).join('\n');
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const type = (req.nextUrl.searchParams.get('type') ?? 'sos') as BriefingType;

  // Протоколы — без БД и без зависимости от AI: отдаём справку сразу.
  if (type === 'protocols') {
    return NextResponse.json({ success: true, response: PROTOCOLS_STATIC });
  }

  // Заземляющие данные — активные алерты.
  let alerts: AlertRow[] = [];
  try {
    const filter = type === 'weather'
      ? `AND (title ILIKE '%погод%' OR title ILIKE '%ветер%' OR title ILIKE '%шторм%' OR title ILIKE '%снег%' OR title ILIKE '%дожд%' OR title ILIKE '%метел%' OR description ILIKE '%погод%')`
      : '';
    const { rows } = await pool.query<AlertRow>(
      `SELECT title, severity, description FROM external_alerts
       WHERE (expires_at IS NULL OR expires_at > NOW()) ${filter}
       ORDER BY severity DESC NULLS LAST, created_at DESC
       LIMIT 15`,
    );
    alerts = rows;
  } catch {
    // если таблица/запрос упали — не роняем брифинг, идём с пустыми данными
    alerts = [];
  }

  const dataBlock = fmtAlerts(alerts);
  const task = type === 'weather'
    ? 'Составь сводку погодных рисков и их влияния на спасательные операции по данным ниже.'
    : 'Составь сводку текущих SOS/угроз и приоритетов по данным ниже.';

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `${task}\n\nДАННЫЕ (активные алерты):\n${dataBlock}` },
  ];

  try {
    const response = await callAIWaterfall(messages);
    if (response) return NextResponse.json({ success: true, response });
  } catch {
    // ниже — фолбэк на сырые данные
  }

  // AI недоступен — отдаём сырые данные, чтобы дашборд всё равно показал факты.
  return NextResponse.json({
    success: true,
    response: `Синтез AI недоступен — сырые данные.\n\n${dataBlock}`,
  });
}
