/**
 * Генератор PDF: Договор об оказании туристических услуг.
 * Составлен AI-юристом платформы (апрель 2026), бренд — Ведар.
 * Основание: ФЗ №132-ФЗ, ГК РФ, ФЗ №152-ФЗ, ЗоЗПП.
 */

import PDFDocument from 'pdfkit';
import { registerCyrillicFonts, FONT_BODY, FONT_BOLD } from '@/lib/pdf/fonts';

export interface ContractData {
  bookingId: number;
  issueDate: string;           // ISO date
  touristName: string;
  touristPhone: string;
  touristEmail?: string;
  tourName: string;
  tourDate: string;            // ISO date
  tourDuration: string;        // e.g. "3 дня"
  meetingPoint?: string;
  paxCount: number;
  totalPrice: number;
  paymentDate?: string;
  paymentStatus: string;
  /** 'new' — оператор ещё не подтвердил: платить пока нечего (решение 24.09). */
  bookingStatus?: string;
  operatorName: string;
  operatorPhone?: string;
  operatorEmail?: string;
  operatorInn?: string;
  /**
   * Условия отмены ЭТОГО тура — `operator_tours.cancellation_policy`, дословно.
   * null/пусто — «условия уточняются у оператора». Сетку сроков и процентов
   * генератор не сочиняет (решение владельца 24.09, развилка 3; сторож
   * pdf-cyrillic-fonts / contract-no-literal-terms).
   */
  cancellationPolicy: string | null;
  /** Строка «Способ» раздела 2 — из `contractPaymentMethod()`, не литерал. */
  paymentMethod: string;
}

/** Что записано в `operator_bookings.payment_method` → слова для договора. */
const RECORDED_METHOD: Record<string, string> = {
  cloudpayments: 'банковская карта',
  card: 'банковская карта',
  sbp: 'СБП (QR-код)',
  tochka: 'СБП (QR-код)',
  bank_transfer: 'банковский перевод',
  cash: 'наличные оператору',
};

/**
 * Строка «Способ оплаты» договора. До 24.09 там стоял литерал
 * «CloudPayments (банковская карта)» — даже когда страница брони в ту же
 * минуту писала «Онлайн-оплата недоступна» (#23).
 *
 * Оплачено — называем записанный способ; не записан — так и говорим.
 * Не оплачено — перечисляем способы, которые реально настроены
 * (`paymentAvailability()`); ни одного — «по согласованию с оператором».
 */
export function contractPaymentMethod(input: {
  paid: boolean;
  recordedMethod: string | null;
  availability: { cardPublicId: string | null; sbp: boolean };
}): string {
  if (input.paid) {
    const key = input.recordedMethod?.trim().toLowerCase() ?? '';
    return RECORDED_METHOD[key] ?? 'способ оплаты не записан';
  }
  const ways: string[] = [];
  if (input.availability.cardPublicId) ways.push('банковская карта');
  if (input.availability.sbp) ways.push('СБП (QR-код)');
  if (ways.length === 0) return 'по согласованию с оператором';
  return `${ways.join(' или ')} на странице брони после подтверждения оператором`;
}

/** Текст раздела 5: поле тура дословно либо честное «уточняется». */
export function contractCancellationText(policy: string | null | undefined): string {
  const t = policy?.trim();
  return t ? t : 'Условия отмены и возврата уточняются у оператора.';
}

export async function generateContractPDF(data: ContractData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 50, bottom: 50, left: 55, right: 55 },
      info: {
        Title: `Договор №${data.bookingId}`,
        Author: 'Ведар — Камчатка',
        Subject: `Туристические услуги: ${data.tourName}`,
        CreationDate: new Date(),
      },
    });
    registerCyrillicFonts(doc);

    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W      = doc.page.width - 110;
    const ACCENT = '#D44A0C';
    const DARK   = '#1A1714';
    const MUTED  = '#6B6560';
    const LINE   = '#E8E3DE';

    const fmt = (iso: string) =>
      new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    const money = (n: number) => n.toLocaleString('ru-RU') + ' ₽';

    // ── Шапка ──────────────────────────────────────────────────────────────────
    const headTop = doc.y;
    doc.fontSize(20).font(FONT_BOLD).fillColor(ACCENT)
       .text('Ведар', { continued: true })
       .font(FONT_BODY).fillColor(MUTED).fontSize(10)
       .text('  vedarai.ru', { align: 'left' });

    // Строка знака смешанного кегля: y после неё считается по мелкому
    // «vedarai.ru», и черта ложилась поперёк крупного «Ведар».
    doc.y = Math.max(doc.y, headTop + 28);
    doc.moveTo(55, doc.y).lineTo(55 + W, doc.y).strokeColor(LINE).lineWidth(1).stroke();
    doc.moveDown(0.8);

    // ── Заголовок ──────────────────────────────────────────────────────────────
    doc.fontSize(14).font(FONT_BOLD).fillColor(DARK)
       .text('ДОГОВОР ОБ ОКАЗАНИИ ТУРИСТИЧЕСКИХ УСЛУГ', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).font(FONT_BODY).fillColor(MUTED)
       .text(`№ ${data.bookingId}  от  ${fmt(data.issueDate)}`, { align: 'center' });
    doc.moveDown(1);

    // ── Стороны ────────────────────────────────────────────────────────────────
    section(doc, 'СТОРОНЫ', ACCENT);

    doc.fontSize(10).font(FONT_BOLD).fillColor(DARK).text('Исполнитель: ', { continued: true })
       .font(FONT_BODY).text(`${data.operatorName}, платформа Ведар (vedarai.ru)`);
    doc.moveDown(0.4);
    doc.font(FONT_BOLD).text('Заказчик: ', { continued: true })
       .font(FONT_BODY).text(`${data.touristName}, тел. ${data.touristPhone}${data.touristEmail ? ', ' + data.touristEmail : ''}`);
    doc.moveDown(1);

    // ── 1. Предмет ─────────────────────────────────────────────────────────────
    section(doc, '1. ПРЕДМЕТ ДОГОВОРА', ACCENT);
    rows(doc, DARK, MUTED, [
      ['Тур',             data.tourName],
      ['Дата проведения', fmt(data.tourDate)],
      ['Продолжительность', data.tourDuration],
      ['Место сбора',     data.meetingPoint ?? 'уточняется у оператора'],
      ['Участников',      String(data.paxCount) + ' чел.'],
    ]);
    doc.moveDown(1);

    // ── 2. Стоимость ───────────────────────────────────────────────────────────
    section(doc, '2. СТОИМОСТЬ И ПОРЯДОК ОПЛАТЫ', ACCENT);
    rows(doc, DARK, MUTED, [
      ['Стоимость',    money(data.totalPrice)],
      ['Статус',       data.paymentStatus === 'paid' ? 'Оплачено'
        : data.bookingStatus === 'new' ? 'Ждёт подтверждения оператора' : 'Ожидает оплаты'],
      ['Дата оплаты',  data.paymentDate ? fmt(data.paymentDate) : '—'],
      ['Способ',       data.paymentMethod],
    ]);
    doc.moveDown(0.6);
    doc.fontSize(9).font(FONT_BODY).fillColor(MUTED)
       .text('Договор вступает в силу с момента получения подтверждения оплаты.', { width: W });
    doc.moveDown(1);

    // ── 3. Права и обязанности ─────────────────────────────────────────────────
    section(doc, '3. ПРАВА И ОБЯЗАННОСТИ СТОРОН', ACCENT);
    doc.fontSize(10).font(FONT_BOLD).fillColor(DARK).text('Исполнитель обязан:');
    bullets(doc, MUTED, W, [
      'провести тур согласно программе;',
      'обеспечить безопасность участников в рамках своей ответственности;',
      'предоставить снаряжение согласно описанию тура;',
      'заблаговременно уведомить о существенных изменениях.',
    ]);
    doc.moveDown(0.5);
    doc.font(FONT_BOLD).fillColor(DARK).text('Заказчик обязан:');
    bullets(doc, MUTED, W, [
      'прибыть на место сбора в назначенное время;',
      'выполнять инструкции гида и правила безопасности;',
      'сообщить оператору об ограничениях здоровья, влияющих на участие.',
    ]);
    doc.moveDown(1);

    // ── 4. Ответственность ─────────────────────────────────────────────────────
    section(doc, '4. ОТВЕТСТВЕННОСТЬ СТОРОН', ACCENT);
    doc.fontSize(9).font(FONT_BODY).fillColor(MUTED).text(
      'Исполнитель несёт ответственность за качество услуг согласно ГК РФ, ФЗ №132-ФЗ и ЗоЗПП. ' +
      'Исполнитель не отвечает за природные явления и форс-мажор. ' +
      'Заказчик самостоятельно отвечает за своё здоровье и страхование. ' +
      'Рекомендуется оформить туристическую страховку до начала тура.',
      { width: W }
    );
    doc.moveDown(1);

    // ── 5. Отмена и возврат ────────────────────────────────────────────────────
    section(doc, '5. УСЛОВИЯ ОТМЕНЫ И ВОЗВРАТА', ACCENT);
    // Дословно из operator_tours.cancellation_policy — тот же текст, что на
    // карточке тура. До 24.09 здесь была своя сетка 30/14 дней, строже
    // обещанного на карточке (#23).
    doc.fontSize(9).font(FONT_BODY).fillColor(MUTED)
       .text(contractCancellationText(data.cancellationPolicy), { width: W });
    doc.moveDown(1);

    // ── 6. Персональные данные ─────────────────────────────────────────────────
    section(doc, '6. ПЕРСОНАЛЬНЫЕ ДАННЫЕ', ACCENT);
    doc.fontSize(9).font(FONT_BODY).fillColor(MUTED).text(
      'Заказчик даёт согласие на обработку персональных данных в целях исполнения Договора ' +
      '(ФЗ №152-ФЗ). Данные не передаются третьим лицам, кроме случаев, необходимых для ' +
      'проведения тура (транспорт, страхование, МЧС).',
      { width: W }
    );
    doc.moveDown(1);

    // ── 7. Прочие условия ─────────────────────────────────────────────────────
    section(doc, '7. ПРОЧИЕ УСЛОВИЯ', ACCENT);
    doc.fontSize(9).font(FONT_BODY).fillColor(MUTED).text(
      'Договор регулируется законодательством РФ. Споры — в претензионном порядке, ' +
      'при недостижении согласия — в суде по месту Исполнителя. ' +
      'Договор акцептован Заказчиком в электронной форме на платформе Ведар (vedarai.ru) в момент ' +
      'подтверждения бронирования (ГК РФ, ст. 438).',
      { width: W }
    );
    doc.moveDown(1);

    // ── Реквизиты ─────────────────────────────────────────────────────────────
    section(doc, 'РЕКВИЗИТЫ ИСПОЛНИТЕЛЯ', ACCENT);
    rows(doc, DARK, MUTED, [
      ['Наименование', data.operatorName],
      ['ИНН / ОГРНИП', data.operatorInn ?? 'уточняйте у оператора'],
      ['Телефон',      data.operatorPhone ?? '—'],
      ['E-mail',       data.operatorEmail ?? '—'],
    ]);
    doc.moveDown(1);

    // ── Подвал ─────────────────────────────────────────────────────────────────
    doc.moveTo(55, doc.y).lineTo(55 + W, doc.y).strokeColor(LINE).lineWidth(0.5).stroke();
    doc.moveDown(0.5);
    doc.fontSize(8).font(FONT_BODY).fillColor(MUTED)
       .text(`Договор №${data.bookingId} сформирован автоматически платформой Ведар (vedarai.ru) · ${fmt(data.issueDate)}`, { align: 'center', width: W });

    doc.end();
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function section(doc: PDFKit.PDFDocument, title: string, color: string) {
  doc.fontSize(11).font(FONT_BOLD).fillColor(color).text(title);
  doc.moveDown(0.4);
}

function rows(doc: PDFKit.PDFDocument, dark: string, muted: string, data: [string, string][]) {
  for (const [label, value] of data) {
    doc.fontSize(10).font(FONT_BOLD).fillColor(dark)
       .text(label + ': ', { continued: true })
       .font(FONT_BODY).fillColor(muted).text(value);
    doc.moveDown(0.2);
  }
}

function bullets(doc: PDFKit.PDFDocument, color: string, width: number, items: string[]) {
  for (const item of items) {
    doc.fontSize(9).font(FONT_BODY).fillColor(color)
       .text(`• ${item}`, { width, indent: 10 });
    doc.moveDown(0.15);
  }
}
