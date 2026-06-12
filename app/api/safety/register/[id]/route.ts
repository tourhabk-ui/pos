import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import PDFDocument from 'pdfkit';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

function generatePDF(reg: Record<string, unknown>): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 60, font: 'Helvetica' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const field = (label: string, value: string) => {
      doc.fontSize(10).font('Helvetica-Bold').text(label, { continued: true });
      doc.font('Helvetica').text(`  ${value || '—'}`);
    };

    doc.fontSize(16).font('Helvetica-Bold').text('ЗАЯВЛЕНИЕ', { align: 'center' });
    doc.fontSize(12).text('о регистрации туристической группы', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).text('в Главное управление МЧС России по Камчатскому краю', { align: 'center' });
    doc.moveDown(1);
    doc.moveTo(60, doc.y).lineTo(535, doc.y).stroke();
    doc.moveDown(0.5);

    field('Маршрут:', String(reg.route_name ?? ''));
    if (reg.route_description) {
      doc.fontSize(10).font('Helvetica-Bold').text('Описание:', { continued: true });
      doc.font('Helvetica').text(`  ${reg.route_description}`);
    }
    field('Регион:', String(reg.region ?? 'Камчатский край'));
    field('Дата начала:', new Date(String(reg.start_date)).toLocaleDateString('ru-RU'));
    field('Дата окончания:', new Date(String(reg.end_date)).toLocaleDateString('ru-RU'));

    doc.moveDown(0.3);
    doc.moveTo(60, doc.y).lineTo(535, doc.y).stroke();
    doc.moveDown(0.5);

    field('Руководитель:', String(reg.leader_name ?? ''));
    field('Телефон руководителя:', String(reg.leader_phone ?? ''));
    if (reg.leader_email) field('Email:', String(reg.leader_email));
    field('Количество участников:', String(reg.group_size ?? ''));

    if (reg.group_members) {
      const members = typeof reg.group_members === 'string'
        ? JSON.parse(reg.group_members)
        : reg.group_members;
      if (Array.isArray(members) && members.length > 0) {
        doc.moveDown(0.3);
        doc.moveTo(60, doc.y).lineTo(535, doc.y).stroke();
        doc.moveDown(0.3);
        doc.fontSize(10).font('Helvetica-Bold').text('Состав группы:');
        members.forEach((m: { name: string; birth_year?: number; phone?: string }, i: number) => {
          const info = [m.birth_year ? `${m.birth_year} г.р.` : '', m.phone ?? ''].filter(Boolean).join(', ');
          doc.fontSize(10).text(`  ${i + 1}. ${m.name}${info ? ` (${info})` : ''}`);
        });
      }
    }

    doc.moveDown(0.3);
    doc.moveTo(60, doc.y).lineTo(535, doc.y).stroke();
    doc.moveDown(0.5);

    field('Экстренный контакт:', String(reg.emergency_contact_name ?? ''));
    field('Телефон:', String(reg.emergency_contact_phone ?? ''));
    if (reg.emergency_contact_relation) field('Кем приходится:', String(reg.emergency_contact_relation));

    doc.moveDown(0.3);
    doc.fontSize(10).text(`ID регистрации: ${reg.id}`, { align: 'right' });

    doc.moveDown(1.5);
    doc.moveTo(60, doc.y).lineTo(535, doc.y).stroke();
    doc.moveDown(0.5);
    doc.fontSize(8).text(
      'Заявление сформировано автоматически через TourHab (tourhab.ru). ' +
      'Данная заявка не является подтверждением регистрации в МЧС. ' +
      'Для официальной регистрации подайте заявление через портал Госуслуг или лично в ГУ МЧС по Камчатскому краю.',
      { align: 'center' }
    );
    doc.fontSize(8).text(`Сформировано: ${new Date().toLocaleString('ru-RU')}`, { align: 'center' });
    doc.end();
  });
}

export async function GET(request: NextRequest, { params }: Params) {
  const { id } = await params;

  const result = await query(
    `SELECT id, route_name, route_description, start_date, end_date, region,
            group_size, group_members, leader_name, leader_phone, leader_email,
            emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
            completed_at, mchs_status, created_at
     FROM route_registrations WHERE id = $1`,
    [id],
  );

  if (result.rows.length === 0) {
    return NextResponse.json({ success: false, error: 'Регистрация не найдена' }, { status: 404 });
  }

  const reg = result.rows[0];
  const wantPdf = request.nextUrl.searchParams.has('pdf');

  if (wantPdf) {
    const pdfBuffer = await generatePDF(reg);
    return new NextResponse(pdfBuffer, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="mchs-registration-${String(reg.id).slice(0, 8)}.pdf"`,
      },
    });
  }

  return NextResponse.json({ success: true, registration: reg });
}
