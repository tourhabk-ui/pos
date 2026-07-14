/**
 * Ваучер брони + ЛИСТ БЕЗОПАСНОСТИ (PDF).
 *
 * Дифференциатор Ведар: в документ оператора автоматически вшивается лист
 * безопасности маршрута — опасности, контакты МЧС, снаряжение, 112. Ни одна
 * generic-CRM так не может, потому что не знает маршрут. PDFKit + кириллица
 * через registerCyrillicFonts (Helvetica → DejaVu).
 */

import PDFDocument from 'pdfkit';
import { registerCyrillicFonts } from '@/lib/pdf/fonts';

export interface BookingDocData {
  bookingId: string;
  operatorName: string;
  operatorPhone?: string | null;
  tourTitle: string;
  locationName?: string | null;
  routeTitle?: string | null;
  bookingDate: string;       // YYYY-MM-DD
  participants: number;
  totalPrice: number;
  touristName: string;
  touristPhone?: string | null;
  touristEmail?: string | null;
  specialRequests?: string | null;
  status?: string | null;
  // Safety (из kamchatka_routes через operator_tours.route_id) — может отсутствовать
  hazards?: string[] | null;
  equipment?: string[] | null;
  mchsPhone?: string | null;
  mchsRegistrationRequired?: boolean | null;
  parkName?: string | null;
}

export interface SafetyBlock {
  hazards: string[];
  equipment: string[];
  mchsPhone: string;              // всегда есть значение (маршрутный или дефолт МЧС Камчатки)
  registrationNote: string | null;
  parkNote: string | null;
  emergencyPhone: string;         // 112 — всегда
}

const DEFAULT_MCHS_KAMCHATKA = '+7 (4152) 30-10-81'; // ЦУКС ГУ МЧС по Камчатскому краю (регистрация групп)

/** Собирает лист безопасности из данных маршрута. Чистая функция — под тесты. */
export function buildSafetyBlock(data: BookingDocData): SafetyBlock {
  const hazards = (data.hazards ?? []).filter((h): h is string => typeof h === 'string' && h.trim() !== '');
  const equipment = (data.equipment ?? []).filter((e): e is string => typeof e === 'string' && e.trim() !== '');
  const mchsPhone = (data.mchsPhone && data.mchsPhone.trim()) ? data.mchsPhone.trim() : DEFAULT_MCHS_KAMCHATKA;

  return {
    hazards,
    equipment,
    mchsPhone,
    registrationNote: data.mchsRegistrationRequired
      ? 'Маршрут требует регистрации группы в МЧС до выхода. Зарегистрируйтесь заранее.'
      : null,
    parkNote: data.parkName ? `Природный парк: ${data.parkName}. Уточните необходимость пропуска у дирекции парка.` : null,
    emergencyPhone: '112',
  };
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return d && m && y ? `${d}.${m}.${y}` : iso;
}

const ACCENT = '#D44A0C';
const INK = '#1A1714';
const MUTED = '#6B6560';
const DANGER = '#C0392B';

/** Генерирует PDF ваучера с листом безопасности. */
export async function generateBookingVoucherPDF(data: BookingDocData): Promise<Buffer> {
  const safety = buildSafetyBlock(data);

  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      registerCyrillicFonts(doc);

      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const left = doc.page.margins.left;
      const width = doc.page.width - left - doc.page.margins.right;

      // ── Шапка оператора ──
      doc.fontSize(18).font('Helvetica-Bold').fillColor(INK).text(data.operatorName, { align: 'left' });
      if (data.operatorPhone) doc.fontSize(10).font('Helvetica').fillColor(MUTED).text(`тел.: ${data.operatorPhone}`);
      doc.moveDown(0.3);
      doc.fontSize(9).font('Helvetica').fillColor(MUTED).text('Оформлено на платформе Ведар (vedarai.ru)');

      // ── Заголовок ──
      doc.moveDown(1);
      doc.fontSize(20).font('Helvetica-Bold').fillColor(ACCENT).text('ВАУЧЕР НА ТУР');
      doc.fontSize(10).font('Helvetica').fillColor(MUTED).text(`№ ${data.bookingId}   ·   от ${fmtDate(new Date().toISOString().slice(0, 10))}`);

      // ── Тур ──
      doc.moveDown(1);
      doc.fontSize(14).font('Helvetica-Bold').fillColor(INK).text(data.tourTitle);
      if (data.locationName) doc.fontSize(10).font('Helvetica').fillColor(MUTED).text(data.locationName);

      const row = (label: string, value: string) => {
        doc.moveDown(0.4);
        doc.fontSize(10).font('Helvetica').fillColor(MUTED).text(label, { continued: true });
        doc.font('Helvetica-Bold').fillColor(INK).text(`   ${value}`);
      };
      doc.moveDown(0.6);
      row('Дата:', fmtDate(data.bookingDate));
      row('Участников:', String(data.participants));
      row('Стоимость:', `${data.totalPrice.toLocaleString('ru-RU')} ₽`);
      row('Турист:', data.touristName);
      if (data.touristPhone) row('Телефон:', data.touristPhone);
      if (data.touristEmail) row('Email:', data.touristEmail);
      if (data.specialRequests) row('Пожелания:', data.specialRequests);

      // ── ЛИСТ БЕЗОПАСНОСТИ ──
      doc.moveDown(1.2);
      doc.rect(left, doc.y, width, 26).fill(DANGER);
      doc.fillColor('#FFFFFF').fontSize(13).font('Helvetica-Bold').text('ЛИСТ БЕЗОПАСНОСТИ', left + 10, doc.y - 20);
      doc.moveDown(1);
      doc.fillColor(INK);

      if (data.routeTitle) {
        doc.fontSize(10).font('Helvetica').fillColor(MUTED).text(`Маршрут: ${data.routeTitle}`);
        doc.moveDown(0.3);
      }

      // Опасности
      doc.fontSize(11).font('Helvetica-Bold').fillColor(DANGER).text('Опасности маршрута:');
      doc.fontSize(10).font('Helvetica').fillColor(INK);
      if (safety.hazards.length > 0) {
        safety.hazards.forEach((h) => doc.text(`•  ${h}`, { indent: 6 }));
      } else {
        doc.fillColor(MUTED).text('Данные по опасностям уточняются у оператора и в дирекции парка.', { indent: 6 });
      }

      // Снаряжение
      doc.moveDown(0.6);
      doc.fontSize(11).font('Helvetica-Bold').fillColor(INK).text('Что взять с собой:');
      doc.fontSize(10).font('Helvetica').fillColor(INK);
      if (safety.equipment.length > 0) {
        doc.text(safety.equipment.join(', '), { indent: 6 });
      } else {
        doc.fillColor(MUTED).text('Список снаряжения уточните у оператора перед выходом.', { indent: 6 });
      }

      // Регистрация / парк
      if (safety.registrationNote || safety.parkNote) {
        doc.moveDown(0.6);
        doc.fontSize(11).font('Helvetica-Bold').fillColor(INK).text('Подготовка:');
        doc.fontSize(10).font('Helvetica').fillColor(INK);
        if (safety.registrationNote) doc.text(`•  ${safety.registrationNote}`, { indent: 6 });
        if (safety.parkNote) doc.text(`•  ${safety.parkNote}`, { indent: 6 });
      }

      // Экстренные контакты
      doc.moveDown(0.6);
      doc.fontSize(11).font('Helvetica-Bold').fillColor(DANGER).text('Экстренные контакты:');
      doc.fontSize(10).font('Helvetica').fillColor(INK);
      doc.text(`•  Единый номер вызова экстренных служб: ${safety.emergencyPhone}`, { indent: 6 });
      doc.text(`•  МЧС (регистрация/консультация по маршруту): ${safety.mchsPhone}`, { indent: 6 });

      // ── Подвал ──
      doc.moveDown(1.5);
      doc.fontSize(8).font('Helvetica').fillColor(MUTED).text(
        'Документ сформирован автоматически на платформе Ведар. Лист безопасности носит информационный характер; окончательные требования по маршруту уточняйте у оператора, в МЧС и дирекции природного парка.',
        { align: 'left' },
      );

      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error('PDF generation failed'));
    }
  });
}
