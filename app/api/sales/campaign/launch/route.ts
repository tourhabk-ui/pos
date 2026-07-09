/**
 * POST /api/sales/campaign/launch
 * CEO Action: Launch operator acquisition campaign
 */

import { NextRequest, NextResponse } from 'next/server';
import { launchSalesCampaign } from '@/lib/sales/bot-ceo';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const LaunchSchema = z.object({
  batch_size: z.number().int().positive().max(50).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const secret = req.headers.get('X-CEO-Secret');
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret || secret !== cronSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const parsed = LaunchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'batch_size — целое число 1..50' }, { status: 400 });
    }
    const batchSize = parsed.data.batch_size ?? 10;

    const result = await launchSalesCampaign(batchSize);

    return NextResponse.json({
      success: result.success,
      campaign_status: 'active',
      sent: result.sent,
      failed: result.failed,
      timestamp: new Date().toISOString()
    });
  } catch (err) {

    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Campaign launch failed' },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    message: 'CEO Sales Campaign API',
    usage: 'POST with X-CEO-Secret header',
    payload: { batch_size: 10 }
  });
}
