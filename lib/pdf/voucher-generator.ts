/**
 * Генератор PDF: Маршрутная квитанция / Туристический ваучер.
 * Составлен AI-юристом платформы (апрель 2026), бренд — Ведар.
 */

import PDFDocument from 'pdfkit';
import { registerCyrillicFonts, FONT_BODY, FONT_BOLD } from '@/lib/pdf/fonts';
import { getPublicBaseUrl } from '@/lib/config';

export interface VoucherData {
  bookingId: number;
  /**
   * Ключ брони для ссылки внизу ваучера. Без него адрес
   * /booking-success/<номер> отвечает 404 всем, включая владельца ваучера
   * (миграция 943): номер брони перестал быть пропуском.
   */
  accessToken?: string;
  issueDate: string;
  touristName: string;
  touristPhone: string;
  touristEmail?: string;
  paxCount: number;
  tourName: string;
  tourDate: string;
  tourDuration: string;
  meetingPoint?: string;
  meetingDescription?: string;
  whatToBring?: string;
  totalPrice: number;
  paymentStatus: string;
  /** 'new' — оператор ещё не подтвердил: платить пока нечего (решение 24.09). */
  bookingStatus?: string;
  paymentDate?: string;
  operatorName: string;
  operatorPhone?: string;
  operatorTelegram?: string;
  operatorEmail?: string;
}

export async function generateVoucherPDF(data: VoucherData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 45, bottom: 45, left: 50, right: 50 },
      info: {
        Title: `Ваучер №${data.bookingId}`,
        Author: 'Ведар — Камчатка',
        Subject: `Тур: ${data.tourName}`,
        CreationDate: new Date(),
      },
    });
    registerCyrillicFonts(doc);

    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W      = doc.page.width - 100;
    const ACCENT = '#D44A0C';
    const OCEAN  = '#2568B0';
    const DARK   = '#1A1714';
    const MUTED  = '#6B6560';
    const LINE   = '#E8E3DE';
    const GREEN  = '#3FB950';

    // Без «г.» — как на странице брони: хвост «г.» отрывался переносом.
    const fmt = (iso: string) =>
      new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
        .replace(/\s*г\.$/, '');
    const money = (n: number) => n.toLocaleString('ru-RU') + ' ₽';

    // ── Шапка ─────────────────────────────────────────────────────────────────
    doc.rect(50, 40, W, 52).fill('#F5F0EB');
    doc.fontSize(18).font(FONT_BOLD).fillColor(ACCENT)
       .text('Ведар', 65, 52, { continued: true })
       .fontSize(9).font(FONT_BODY).fillColor(MUTED)
       .text('  Туристическая платформа Камчатки · vedarai.ru');
    doc.fontSize(9).font(FONT_BODY).fillColor(MUTED)
       .text('МАРШРУТНАЯ КВИТАНЦИЯ / ТУРИСТИЧЕСКИЙ ВАУЧЕР', 65, 74);
    doc.y = 100;
    doc.moveDown(0.6);

    // ── Номер и даты ──────────────────────────────────────────────────────────
    doc.fontSize(22).font(FONT_BOLD).fillColor(DARK)
       .text(`Бронь №${data.bookingId}`, { align: 'center' });
    doc.moveDown(0.2);
    doc.fontSize(9).font(FONT_BODY).fillColor(MUTED)
       .text(`Выдан: ${fmt(data.issueDate)}   ·   Действителен до: ${fmt(data.tourDate)}`, { align: 'center' });
    doc.moveDown(0.8);

    // ── Статус оплаты ─────────────────────────────────────────────────────────
    const paid = data.paymentStatus === 'paid';
    const statusColor = paid ? GREEN : '#D29922';
    const statusText  = paid
      ? `ОПЛАЧЕНО · ${money(data.totalPrice)}`
      : data.bookingStatus === 'new'
        ? `ЖДЁТ ПОДТВЕРЖДЕНИЯ ОПЕРАТОРА · ${money(data.totalPrice)}`
        : `К ОПЛАТЕ · ${money(data.totalPrice)}`;
    // Подложка — цвет с прозрачностью через fillOpacity: восьмизначный hex
    // ('#D2992215') PDFKit не понимает и заливал плашку почти чёрным (П3).
    doc.save().rect(50, doc.y, W, 28).fillOpacity(0.12).fill(statusColor).restore();
    doc.fontSize(11).font(FONT_BOLD).fillColor(statusColor)
       .text(statusText, 50, doc.y + 8, { align: 'center', width: W });
    doc.y += 36;
    doc.moveDown(0.8);

    // ── Турист ────────────────────────────────────────────────────────────────
    divider(doc, LINE, W);
    blockTitle(doc, 'ДАННЫЕ ТУРИСТА', OCEAN);
    twoCol(doc, DARK, MUTED, W, [
      ['ФИО',         data.touristName],
      ['Телефон',     data.touristPhone],
      ['E-mail',      data.touristEmail ?? '—'],
      ['Участников',  `${data.paxCount} чел.`],
    ]);
    doc.moveDown(0.8);

    // ── Тур ──────────────────────────────────────────────────────────────────
    divider(doc, LINE, W);
    blockTitle(doc, 'ТУР', OCEAN);
    twoCol(doc, DARK, MUTED, W, [
      ['Название',         data.tourName],
      ['Дата',             fmt(data.tourDate)],
      ['Продолжительность',data.tourDuration],
      ['Место сбора',      data.meetingPoint ?? 'уточняйте у оператора'],
    ]);
    if (data.meetingDescription) {
      doc.moveDown(0.3);
      doc.fontSize(9).font(FONT_BODY).fillColor(MUTED)
         .text(data.meetingDescription, { width: W, indent: 10 });
    }
    doc.moveDown(0.8);

    // ── Оператор ──────────────────────────────────────────────────────────────
    divider(doc, LINE, W);
    blockTitle(doc, 'ОПЕРАТОР ТУРА', OCEAN);
    twoCol(doc, DARK, MUTED, W, [
      ['Компания',  data.operatorName],
      ['Телефон',   data.operatorPhone ?? '—'],
      ['Telegram',  data.operatorTelegram ?? '—'],
      ['E-mail',    data.operatorEmail ?? '—'],
    ]);
    doc.moveDown(0.8);

    // ── Инструкции ────────────────────────────────────────────────────────────
    divider(doc, LINE, W);
    blockTitle(doc, 'ВАЖНЫЕ ИНСТРУКЦИИ', OCEAN);

    doc.fontSize(9).font(FONT_BOLD).fillColor(DARK).text('Что взять с собой:');
    doc.font(FONT_BODY).fillColor(MUTED).fontSize(9).text(
      data.whatToBring ??
      'Треккинговая обувь, тёплые слои одежды, дождевик, личные документы, ' +
      'вода (1–2 л), солнцезащитный крем, полный заряд телефона.',
      { width: W, indent: 10 }
    );
    doc.moveDown(0.5);

    doc.fontSize(9).font(FONT_BOLD).fillColor(DARK).text('Как нас найти:');
    doc.font(FONT_BODY).fillColor(MUTED).text(
      'Покажите этот ваучер гиду на месте сбора. При себе иметь документ, удостоверяющий личность.',
      { width: W, indent: 10 }
    );
    doc.moveDown(0.5);

    // Экстренные контакты
    // Та же поломка, что у плашки оплаты: '#DC262608' давал тёмный блок, на
    // котором серые 112 и телефон оператора не читались. Координаты — от
    // верха блока, а не от сдвинутого заголовком doc.y (текст вылезал за край).
    const sosTop = doc.y;
    doc.save().rect(50, sosTop, W, 44).fillOpacity(0.08).fill('#DC2626').restore();
    doc.fontSize(9).font(FONT_BOLD).fillColor('#DC2626')
       .text('ЭКСТРЕННЫЕ КОНТАКТЫ', 65, sosTop + 8);
    doc.font(FONT_BODY).fillColor(DARK).fontSize(9)
       .text(
         `Единый номер спасения: 112 (работает без баланса и SIM)   ·   Оператор: ${data.operatorPhone ?? '—'}`,
         65, sosTop + 24, { width: W - 20 }
       );
    doc.y = Math.max(doc.y, sosTop + 44) + 8;
    doc.moveDown(0.8);

    // ── Ссылка ────────────────────────────────────────────────────────────────
    divider(doc, LINE, W);
    doc.moveDown(0.4);
    doc.fontSize(9).font(FONT_BODY).fillColor(MUTED).text(
      data.accessToken
        ? `Детали бронирования: ${getPublicBaseUrl().replace(/^https?:\/\//, '')}/booking-success/${data.bookingId}?t=${data.accessToken}`
        // Ключа не передали — печатать мёртвую ссылку хуже, чем не печатать:
        // человек по ней придёт и увидит «не найдено».
        : `Бронь №${data.bookingId} · ссылку на детали ищите в письме или чате`,
      { align: 'center', width: W }
    );
    doc.moveDown(0.3);

    // ── Подвал ─────────────────────────────────────────────────────────────────
    doc.fontSize(8).fillColor(MUTED).text(
      `Ваучер №${data.bookingId} · Ведар (vedarai.ru) · info@vedarai.ru · ${fmt(data.issueDate)}`,
      { align: 'center', width: W }
    );

    doc.end();
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function divider(doc: PDFKit.PDFDocument, color: string, w: number) {
  doc.moveTo(50, doc.y).lineTo(50 + w, doc.y).strokeColor(color).lineWidth(0.5).stroke();
  doc.moveDown(0.5);
}

function blockTitle(doc: PDFKit.PDFDocument, title: string, color: string) {
  doc.fontSize(10).font(FONT_BOLD).fillColor(color).text(title);
  doc.moveDown(0.3);
}

function twoCol(
  doc: PDFKit.PDFDocument, dark: string, muted: string, w: number,
  rows: [string, string][],
) {
  for (const [label, value] of rows) {
    // Подпись без узкой колонки: с width у continued-сегмента PDFKit
    // переносит и ЗНАЧЕНИЕ в ту же узкую колонку («Сплав по / реке…»).
    // Пробел после двоеточия — иначе «ФИО:Аудит Тест».
    doc.fontSize(9).font(FONT_BOLD).fillColor(dark)
       .text(label + ': ', 50, doc.y, { continued: true, width: w })
       .font(FONT_BODY).fillColor(muted).text(value, { width: w });
    doc.moveDown(0.2);
  }
}
