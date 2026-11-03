/**
 * GET /api/hub/crm/report?period=this_week|last_week|this_month|last_month
 * Отчёт туроператора за период (K.ai A1/A2) — кабинетный двойник crm_report:
 * та же функция loadPeriodReport. Деньги — только владельцу кабинета.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requirePartner } from '@/lib/crm/partner-context';
import { loadPeriodReport, REPORT_PERIODS, type ReportPeriod } from '@/lib/crm/report-period';
import { ownerOnlyDenied } from '@/lib/operators/team-access';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requirePartner(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.seat !== 'owner') return ownerOnlyDenied();
  if (ctx.category !== 'operator') {
    return NextResponse.json({ success: false, error: 'Отчёт по броням есть только у туроператора' }, { status: 403 });
  }
  const period = req.nextUrl.searchParams.get('period') ?? 'last_week';
  if (!(REPORT_PERIODS as readonly string[]).includes(period)) {
    return NextResponse.json({ success: false, error: 'Период: this_week, last_week, this_month или last_month' }, { status: 400 });
  }
  const r = await loadPeriodReport(ctx.partnerId, period as ReportPeriod, Date.now());
  if (!r) return NextResponse.json({ success: false, error: 'Брони не прочитались' }, { status: 503 });
  return NextResponse.json({ success: true, data: r });
}
