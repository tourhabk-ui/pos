/**
 * PDF-ваучер бронирования туриста — кнопка «Ваучер». Показать гиду/оператору;
 * QR ведёт на бронь в кабинете. Переиспользует PDFKit + кириллические шрифты
 * (как lib/pdf/proposal-generator).
 */

import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { registerCyrillicFonts } from '@/lib/pdf/fonts';

export interface VoucherInput {
  id: string;
  tourName: string;
  operatorName?: string | null;
  date: string | Date;
  participants?: number | null;
  totalPrice?: number | null;
  status?: string | null;
  paymentStatus?: string | null;
}

const STATUS_RU: Record<string, string> = {
  pending: 'Ожидает подтверждения', confirmed: 'Подтверждено',
  completed: 'Завершено', cancelled: 'Отменено',
};
const PAY_RU: Record<string, string> = {
  pending: 'Не оплачено', paid: 'Оплачено', refunded: 'Возвращено', partial: 'Частично',
};

function rub(v: number): string {
  return `${new Intl.NumberFormat('ru-RU').format(Math.round(v))} ₽`;
}

export async function generateBookingVoucherPDF(v: VoucherInput): Promise<Buffer> {
  // QR на бронь в ЛК — оператор/гид может сверить. Ошибка QR не должна ронять ваучер.
  let qr: Buffer | null = null;
  try {
    qr = await QRCode.toBuffer(`https://vedarai.ru/hub/tourist/bookings?b=${v.id}`, { margin: 1, width: 240 });
  } catch { qr = null; }

  return await new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      registerCyrillicFonts(doc);
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      const left = 50;
      const accent = '#D44A0C';

      doc.font('Helvetica-Bold').fontSize(22).fillColor(accent).text('Ваучер бронирования', left, 55);
      doc.font('Helvetica').fontSize(10).fillColor('#666666').text('Ведар · KamchatourHub', left, 84);

      if (qr) doc.image(qr, doc.page.width - 50 - 110, 50, { width: 110 });

      doc.moveTo(left, 110).lineTo(doc.page.width - 50, 110).strokeColor('#DDDDDD').stroke();

      doc.font('Helvetica-Bold').fontSize(16).fillColor('#1A1714').text(v.tourName, left, 128, { width: doc.page.width - 100 - 120 });

      const rows: Array<[string, string]> = [
        ['Оператор', v.operatorName || '—'],
        ['Дата', new Date(v.date).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })],
        ['Участников', v.participants != null ? String(v.participants) : '—'],
        ['Статус брони', v.status ? (STATUS_RU[v.status] ?? v.status) : '—'],
        ['Оплата', v.paymentStatus ? (PAY_RU[v.paymentStatus] ?? v.paymentStatus) : '—'],
        ['Сумма', v.totalPrice != null ? rub(v.totalPrice) : '—'],
      ];

      let y = 168;
      for (const [k, val] of rows) {
        doc.font('Helvetica').fontSize(11).fillColor('#6B6560').text(k, left, y, { width: 140 });
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#1A1714').text(val, left + 150, y, { width: 260 });
        y += 26;
      }

      y += 14;
      doc.font('Helvetica').fontSize(9).fillColor('#9A9590')
        .text(`Номер бронирования: ${v.id}`, left, y, { width: doc.page.width - 100 });
      doc.moveDown(0.5)
        .text('Покажите этот ваучер гиду или оператору при встрече. Детали и статус — в личном кабинете на vedarai.ru.', { width: doc.page.width - 100 });

      doc.end();
    } catch (e) {
      reject(e as Error);
    }
  });
}
