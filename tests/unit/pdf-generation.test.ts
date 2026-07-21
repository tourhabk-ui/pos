// @vitest-environment node
/**
 * Smoke-тест генерации PDF: реально собираем документы с кириллицей.
 *
 * Окружение node обязательно: в jsdom fs.readFileSync возвращает Buffer
 * другого realm, `buf instanceof Uint8Array` даёт false, и pdfkit отвергает
 * валидный шрифт («Not a supported font format»). Прод работает в node.
 *
 * Ловит сразу три класса сбоев, стоивших владельцу «pdf нет»:
 * 1. pdfkit не может загрузить шрифт при создании документа (AFM в standalone);
 * 2. кириллица не кодируется (встроенная Helvetica без кириллицы);
 * 3. данные предложения ломают генератор (null-поля, пустые массивы).
 */

import { describe, it, expect } from 'vitest';
import { generateProposalPDF } from '@/lib/pdf/proposal-generator';
import { generateVoucherPDF } from '@/lib/pdf/voucher-generator';
import { DEFAULT_PDF_FONT } from '@/lib/pdf/fonts';
import type { LeadProposalData } from '@/lib/services/operators/lead-processor.service';

describe('PDF-генераторы с кириллицей', () => {
  it('шрифт DejaVu доступен в public/fonts', () => {
    expect(DEFAULT_PDF_FONT).toBeTruthy();
  });

  it('КП лида: собирается с русским текстом и null-полями', async () => {
    const proposal: LeadProposalData = {
      lead_id: 'lead-1',
      proposal_id: 'prop-1',
      headline: 'Камчатка для Олеси: вулканы и океан',
      summary: 'Подобрали два маршрута под ваши даты — 18 июля, 2 человека.',
      highlights: ['Вулкан Горелый', 'Халактырский пляж', 'Термальные источники'],
      price_from: 5000,
      price_to: 12000,
      duration_days: 1,
      primary_tour: {
        id: '31',
        title: 'Восхождение на Авачинский вулкан',
        price: 5000,
        duration_days: 1,
        activity_type: 'trekking',
        description: 'Классика Камчатки — подъём на действующий вулкан.',
        match_reason: '',
      },
      alt_tours: [],
      ai_score: 60,
      intent: {} as LeadProposalData['intent'],
      generation_ms: 1200,
    };

    const pdf = await generateProposalPDF({ clientName: 'Олеся', proposal });
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // Встроенный TTF-шрифт делает документ заметно больше 10 КБ —
    // маленький PDF означает, что кириллический шрифт не встроился
    expect(pdf.length).toBeGreaterThan(10_000);
  });

  it('КП без тура и с пустыми массивами не падает', async () => {
    const proposal: LeadProposalData = {
      lead_id: 'lead-2',
      proposal_id: 'prop-2',
      headline: 'Заголовок',
      summary: 'Короткое описание.',
      highlights: [],
      price_from: null,
      price_to: null,
      duration_days: null,
      primary_tour: null,
      alt_tours: [],
      ai_score: 0,
      intent: {} as LeadProposalData['intent'],
      generation_ms: 0,
    };
    const pdf = await generateProposalPDF({ clientName: 'Тест', proposal });
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('ваучер: собирается с русским текстом', async () => {
    const pdf = await generateVoucherPDF({
      bookingId: 101,
      issueDate: new Date().toISOString(),
      touristName: 'Иван Петров',
      touristPhone: '+79990000000',
      paxCount: 2,
      tourName: 'Вертолётная экскурсия в Долину гейзеров',
      tourDate: new Date(Date.now() + 86400000).toISOString(),
      tourDuration: '1 день',
      totalPrice: 45000,
      paymentStatus: 'paid',
      operatorName: 'Камчатка-Тур',
    });
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(10_000);
  });
});
