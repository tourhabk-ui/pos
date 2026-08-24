/**
 * GET /api/leads/[id]/proposal/pdf
 *
 * Генерирует PDF-предложение для клиента на лету с помощью PDFKit.
 * Возвращает бинарный поток с Content-Type: application/pdf.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { leadProcessor } from '@/lib/services/operators/lead-processor.service';
import { generateProposalPDF } from '@/lib/pdf/proposal-generator';
import { leadOwnershipCond } from '@/lib/leads/ownership';
import type { JWTPayload } from '@/lib/auth/jwt';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireOperator(req);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult as JWTPayload;

  const { id } = await params;

  // Владение: PDF с именем/контактами туриста не должен скачиваться по
  // чужому UUID лида (аудит кабинета оператора) — 404, не 403, чтобы не
  // подтверждать существование чужого лида.
  const scope = await leadOwnershipCond(user, 2);
  const { rows } = await pool.query<{ proposal_id: string | null; name: string }>(
    `SELECT proposal_id, name FROM leads WHERE id = $1${scope.cond}`,
    [id, ...scope.vals]
  );

  if (!rows[0]) {
    return NextResponse.json({ error: 'Лид не найден' }, { status: 404 });
  }

  if (!rows[0].proposal_id) {
    return NextResponse.json({ error: 'Предложение не сформировано' }, { status: 404 });
  }

  const proposal = await leadProcessor.getProposal(rows[0].proposal_id);
  if (!proposal) {
    return NextResponse.json({ error: 'Предложение не найдено' }, { status: 404 });
  }

  let pdfBytes: Buffer;
  try {
    pdfBytes = await generateProposalPDF({
      clientName: rows[0].name,
      proposal,
    });
  } catch (err) {
    // Голый 500 без текста уже стоил нескольких итераций диагностики — отдаём причину
    return NextResponse.json(
      {
        error: 'Не удалось сгенерировать PDF',
        details: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      },
      { status: 500 },
    );
  }

  const safeName = rows[0].name.replace(/[^\w\u0400-\u04FF -]/g, '').replace(/\s+/g, '-').slice(0, 50);
  const filename = `proposal-${safeName}-${Date.now()}.pdf`;

  // Uint8Array: с TS 5.9 Buffer не проходит в BodyInit без каста.
  return new NextResponse(new Uint8Array(pdfBytes), {
    status: 200,
    headers: {
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length':      String(pdfBytes.length),
    },
  });
}
