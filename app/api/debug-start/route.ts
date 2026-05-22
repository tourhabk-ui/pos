import { NextResponse } from 'next/server';

// Diagnostic endpoint: verifies Next.js is actually running (not just the proxy).
// Access: https://vedarai.ru/api/debug-start
// Protected by HEALTH_SECRET env var (if set).
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const secret = process.env.HEALTH_SECRET;
  if (secret) {
    const auth = request.headers.get('x-health-secret');
    if (auth !== secret) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const info = {
    ok: true,
    nextjs: true,
    node: process.version,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    env: {
      NODE_ENV: process.env.NODE_ENV,
      PORT: process.env.PORT,
      HOSTNAME: process.env.HOSTNAME,
      DATABASE_URL: process.env.DATABASE_URL ? 'SET' : 'MISSING',
      JWT_SECRET: process.env.JWT_SECRET ? 'SET' : 'MISSING',
      NEXT_PUBLIC_BASE_URL: process.env.NEXT_PUBLIC_BASE_URL ?? '(not set)',
    },
    ts: new Date().toISOString(),
  };

  return NextResponse.json(info);
}
