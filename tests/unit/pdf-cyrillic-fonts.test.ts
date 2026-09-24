// @vitest-environment node
/**
 * PDF для туриста — читаемая кириллица, бренд «Ведар», договор без
 * выдуманной сетки отмены (аудит П3, #22/#23, 24.09).
 *
 * ── Что было ──────────────────────────────────────────────────────────────
 *
 * DejaVu регистрировался под именем 'Helvetica', а конструктор PDFKit уже
 * положил стандартную Helvetica в кэш `_fontFamilies` — регистрация обычного
 * начертания не действовала никогда. Во всех PDF со страницы успеха ФИО, тур,
 * дата и пункты договора выходили кракозябрами; кириллицей читались только
 * жирные подписи. Smoke-тест pdf-generation этого не видел: он проверял, что
 * документ собрался и весит больше 10 КБ (жирный DejaVu встраивался и давал
 * вес). Здесь проверяется то, что видит глаз: какие шрифты реально лежат в
 * документе.
 *
 * Признак поломки — `/BaseFont /Helvetica` в теле PDF: это стандартный
 * WinAnsi-шрифт без кириллицы. Словари шрифтов в PDFKit не сжимаются, поэтому
 * строка видна в сыром буфере.
 *
 * Договор: раздел 5 — дословно `operator_tours.cancellation_policy`, способ
 * оплаты — из записанного и настроенного (решение владельца 24.09,
 * развилка 3). Сетку «30/14 дней, 100/50%» генератор больше не пишет, и
 * вернуть её литералом не даёт статическая проверка ниже.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateContractPDF, contractPaymentMethod, contractCancellationText, type ContractData,
} from '@/lib/pdf/contract-generator';
import { generateVoucherPDF } from '@/lib/pdf/voucher-generator';
import { generateProposalPDF } from '@/lib/pdf/proposal-generator';
import { generateBookingVoucherPDF } from '@/lib/pdf/booking-voucher';
import type { LeadProposalData } from '@/lib/services/operators/lead-processor.service';

const PDF_DIR = join(process.cwd(), 'lib/pdf');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ').replace(/\s\/\/.*$/gm, ' ');

function baseFonts(pdf: Buffer): string[] {
  return [...new Set(pdf.toString('latin1').match(/\/BaseFont \/[A-Za-z0-9+\-]+/g) ?? [])];
}

function expectCyrillicOnly(pdf: Buffer) {
  const fonts = baseFonts(pdf);
  expect(fonts, 'в PDF встроена стандартная Helvetica без кириллицы').not.toContain('/BaseFont /Helvetica');
  expect(fonts.join(' '), 'в PDF нет Helvetica ни в каком начертании').not.toMatch(/\/Helvetica/);
  // Обычное начертание — именно DejaVuSans (не только -Bold): им пишется весь
  // текст ваучера и договора, и именно оно ломалось.
  expect(fonts.some((f) => /\+DejaVuSans$/.test(f)), `обычный DejaVu не встроен: ${fonts.join(' ')}`).toBe(true);
}

const CONTRACT: ContractData = {
  bookingId: 1,
  issueDate: '2026-09-24T00:00:00Z',
  touristName: 'Аудит Тест',
  touristPhone: '+79990000000',
  tourName: 'Сплав по реке Быстрая',
  tourDate: '2026-09-28',
  tourDuration: '1 дн.',
  paxCount: 2,
  totalPrice: 26000,
  paymentStatus: 'pending',
  operatorName: 'Оператор',
  cancellationPolicy: 'Бесплатная отмена за 3 дня до тура, позже удерживается 50%',
  paymentMethod: 'по согласованию с оператором',
};

describe('PDF: кириллица обычным начертанием, без стандартной Helvetica', () => {
  it('договор', async () => {
    expectCyrillicOnly(await generateContractPDF(CONTRACT));
  });

  it('ваучер со страницы успеха', async () => {
    expectCyrillicOnly(await generateVoucherPDF({
      bookingId: 1, accessToken: 'k', issueDate: '2026-09-24T00:00:00Z',
      touristName: 'Аудит Тест', touristPhone: '+79990000000', paxCount: 2,
      tourName: 'Сплав по реке Быстрая', tourDate: '2026-09-28', tourDuration: '1 дн.',
      totalPrice: 26000, paymentStatus: 'pending', operatorName: 'Оператор',
    }));
  });

  it('ваучер туриста (/api/bookings/[id]/voucher)', async () => {
    const pdf = await generateBookingVoucherPDF({
      id: '1', tourName: 'Сплав по реке Быстрая', operatorName: 'Оператор', date: '2026-09-28',
      participants: 2, totalPrice: 26000, status: 'confirmed', paymentStatus: 'pending',
    });
    expectCyrillicOnly(pdf);
  });

  it('КП лиду', async () => {
    const proposal: LeadProposalData = {
      lead_id: 'l', proposal_id: 'p', headline: 'Камчатка для Олеси', summary: 'Два маршрута.',
      highlights: ['Вулкан Горелый'], price_from: 5000, price_to: 12000, duration_days: 1,
      primary_tour: null, alt_tours: [], ai_score: 60,
      intent: {} as LeadProposalData['intent'], generation_ms: 0,
    };
    expectCyrillicOnly(await generateProposalPDF({ clientName: 'Олеся', proposal }));
  });

  it('ни один генератор не зовёт шрифт по имени встроенной Helvetica', () => {
    // Имя 'Helvetica' попадает в кэш конструктора PDFKit — регистрация под
    // ним не действует. Только FONT_BODY / FONT_BOLD из lib/pdf/fonts.
    const offenders = readdirSync(PDF_DIR)
      .filter((f) => f.endsWith('.ts') && f !== 'fonts.ts')
      .filter((f) => /font\(\s*['"]Helvetica/.test(stripComments(readFileSync(join(PDF_DIR, f), 'utf-8'))));
    expect(offenders).toEqual([]);
  });

  it('бренд в PDF — «Ведар», не «TourHab» (в любом регистре, включая адреса)', () => {
    // Регистронезависимо и по всему коду, не только в литералах: первая
    // редакция искала /TourHab/ с учётом регистра и пропустила шапку
    // «TOURHAB · КАМЧАТКА» карточки места и адрес support@tourhab.ru в
    // подвале каждого ваучера (доработка П3, 24.09).
    const offenders = readdirSync(PDF_DIR)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /tourhab/i.test(stripComments(readFileSync(join(PDF_DIR, f), 'utf-8'))));
    expect(offenders).toEqual([]);
  });

  it('ваучер: строка «подпись: значение» не зажата в узкую колонку', () => {
    // С width:120 у continued-подписи PDFKit переносил и значение в ту же
    // колонку: «Сплав по / реке Быстрая», «Телефон:» отдельной строкой,
    // правые две трети листа пустые; пробела после двоеточия не было
    // («ФИО:Аудит Тест»).
    const src = stripComments(readFileSync(join(PDF_DIR, 'voucher-generator.ts'), 'utf-8'));
    const twoCol = src.slice(src.indexOf('function twoCol'));
    expect(twoCol).toMatch(/label \+ ': '/);
    expect(twoCol).not.toMatch(/continued:\s*true,\s*width:\s*\d+\s*\}/);
  });
});

describe('договор: раздел 5 и способ оплаты — из данных, не литералами', () => {
  const SRC = stripComments(readFileSync(join(PDF_DIR, 'contract-generator.ts'), 'utf-8'));
  const strings = (SRC.match(/'[^'\n]*'|`[^`]*`/g) ?? []).join('\n');

  it('в строках генератора нет процентов', () => {
    expect(strings).not.toMatch(/\d+\s*%/);
  });

  it('в строках генератора нет сроков в днях', () => {
    expect(strings).not.toMatch(/\d+\s*(дн|дня|дней|р\.\s*д|рабоч|календ|час)/);
  });

  it('способ оплаты не литерал «CloudPayments»', () => {
    expect(strings).not.toMatch(/CloudPayments/);
    expect(SRC).toMatch(/\['Способ',\s*data\.paymentMethod\]/);
  });

  it('раздел 5 пишется из поля тура', () => {
    expect(SRC).toMatch(/contractCancellationText\(data\.cancellationPolicy\)/);
    expect(contractCancellationText('Бесплатная отмена за 3 дня до тура, позже удерживается 50%'))
      .toBe('Бесплатная отмена за 3 дня до тура, позже удерживается 50%');
    expect(contractCancellationText(null)).toMatch(/уточняются у оператора/);
    expect(contractCancellationText('   ')).toMatch(/уточняются у оператора/);
  });

  it('роут PDF отдаёт в договор cancellation_policy тура и способ из paymentAvailability', () => {
    const route = readFileSync(join(process.cwd(), 'app/api/hub/bookings/[id]/pdf/route.ts'), 'utf-8');
    expect(route).toMatch(/t\.cancellation_policy/);
    expect(route).toMatch(/cancellationPolicy:\s*r\.cancellation_policy/);
    expect(route).toMatch(/availability:\s*paymentAvailability\(\)/);
  });

  it('способ оплаты: три исхода — записан, не записан, не оплачено', () => {
    const none = { cardPublicId: null, sbp: false };
    expect(contractPaymentMethod({ paid: true, recordedMethod: 'cloudpayments', availability: none }))
      .toBe('банковская карта');
    expect(contractPaymentMethod({ paid: true, recordedMethod: null, availability: none }))
      .toBe('способ оплаты не записан');
    expect(contractPaymentMethod({ paid: false, recordedMethod: null, availability: none }))
      .toBe('по согласованию с оператором');
    expect(contractPaymentMethod({ paid: false, recordedMethod: null, availability: { cardPublicId: 'pk', sbp: true } }))
      .toMatch(/^банковская карта или СБП/);
  });
});
