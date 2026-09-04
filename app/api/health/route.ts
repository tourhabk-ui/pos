/**
 * Health Check Endpoint для Timeweb Apps
 * Простая проверка что приложение работает
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// AUTH: Public — infra/utility endpoint for load balancer health checks
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'kamchatour-hub',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '0.1.0',
    // Время СБОРКИ образа (next.config.js). uptime говорит, давно ли
    // перезапускались, а этот штамп — тот ли код сейчас на проде: 04.09 два
    // замера ушли впустую, потому что шаг ожидания деплоя ловил рестарт от
    // ПРЕДЫДУЩЕГО мержа. null — сборка старше этой правки.
    build_time: process.env.BUILD_TIME ?? null,
  });
}
