/**
 * PDF подписанного вейвера — согласие с рисками + медицинская декларация.
 * Турист может показать гиду/оператору при встрече; при ЧП МЧС видит
 * хронические болезни, аллергии и экстренный контакт. Переиспользует PDFKit +
 * кириллические шрифты (как lib/pdf/booking-voucher).
 */

import PDFDocument from 'pdfkit';
import { registerCyrillicFonts } from '@/lib/pdf/fonts';

export interface WaiverPdfInput {
  bookingId: string;
  tourName: string;
  reason: string | null;
  signerName: string;
  medicalConditions: string | null;
  allergies: string | null;
  emergencyContactName: string;
  emergencyContactPhone: string;
  signedAt: string | Date;
}

export async function generateWaiverPDF(w: WaiverPdfInput): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      registerCyrillicFonts(doc);
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      const left = 50;
      const width = doc.page.width - 100;
      const accent = '#D44A0C';

      doc.font('Helvetica-Bold').fontSize(22).fillColor(accent)
        .text('Согласие с рисками', left, 55);
      doc.font('Helvetica').fontSize(10).fillColor('#666666')
        .text('Ведар · KamchatourHub', left, 84);

      doc.moveTo(left, 110).lineTo(doc.page.width - 50, 110).strokeColor('#DDDDDD').stroke();

      doc.font('Helvetica-Bold').fontSize(16).fillColor('#1A1714')
        .text(w.tourName, left, 128, { width });
      if (w.reason) {
        doc.font('Helvetica').fontSize(10).fillColor('#D29922')
          .text(`Высокорисковый тур: ${w.reason}`, left, doc.y + 2, { width });
      }

      // Текст согласия
      doc.moveDown(0.8);
      doc.font('Helvetica').fontSize(10).fillColor('#1A1714').text(
        'Я осознаю, что участие в данном туре сопряжено с повышенным риском для ' +
        'жизни и здоровья (сложный рельеф, погодные условия, удалённость от ' +
        'медицинской помощи, природные опасности). Я подтверждаю, что физически ' +
        'пригоден(на) к участию, ознакомлен(а) с требованиями безопасности и ' +
        'обязуюсь выполнять указания гида. Данные ниже предоставлены добровольно ' +
        'для обеспечения моей безопасности при чрезвычайной ситуации.',
        left, doc.y, { width, align: 'left' },
      );

      // Поля декларации
      const rows: Array<[string, string]> = [
        ['Подписал(а)', w.signerName],
        ['Хронические заболевания', w.medicalConditions?.trim() || 'не указаны'],
        ['Аллергии', w.allergies?.trim() || 'не указаны'],
        ['Экстренный контакт', w.emergencyContactName],
        ['Телефон контакта', w.emergencyContactPhone],
        ['Дата подписания', new Date(w.signedAt).toLocaleString('ru-RU', {
          day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
        })],
      ];

      let y = doc.y + 18;
      for (const [k, val] of rows) {
        doc.font('Helvetica').fontSize(11).fillColor('#6B6560').text(k, left, y, { width: 180 });
        const valHeight = doc.font('Helvetica-Bold').fontSize(11).heightOfString(val, { width: width - 190 });
        doc.fillColor('#1A1714').text(val, left + 190, y, { width: width - 190 });
        y += Math.max(26, valHeight + 10);
      }

      y += 10;
      doc.font('Helvetica').fontSize(8).fillColor('#9A9590')
        .text(`Номер бронирования: ${w.bookingId}. Документ сформирован платформой Ведар (vedarai.ru) ` +
              'на основании электронного согласия туриста.', left, y, { width });

      doc.end();
    } catch (e) {
      reject(e as Error);
    }
  });
}
