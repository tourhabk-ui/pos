/**
 * Карточка тура называет продавца по закону (02.10).
 *
 * Платформа — владелец агрегатора (ЗоЗПП ст. 12 п. 2.1), исполнитель —
 * оператор. Турист обязан видеть, кто именно: наименование и регистрационные
 * данные. Строка собирается только из записанного; не записано — карточка так
 * и говорит (§4.0). Адрес не выводится: у ИП это может быть домашний адрес.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sellerRequisitesLine } from '@/lib/tours/seller-requisites';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('sellerRequisitesLine', () => {
  it('собирает только записанные поля', () => {
    expect(sellerRequisitesLine({ operator_legal_name: 'ИП Петров П. П.', operator_inn: '410100000000', operator_ogrn: '304410100000000' }))
      .toBe('ИП Петров П. П., ИНН 410100000000, ОГРН 304410100000000');
    expect(sellerRequisitesLine({ operator_legal_name: 'ООО «Вулкан»', operator_inn: null, operator_ogrn: '' }))
      .toBe('ООО «Вулкан»');
  });
  it('ничего не записано — null, а не выдумка', () => {
    expect(sellerRequisitesLine({})).toBeNull();
    expect(sellerRequisitesLine({ operator_legal_name: '  ', operator_inn: null, operator_ogrn: null })).toBeNull();
  });
});

describe('карточка тура и запрос', () => {
  const QUERY = read('lib/tours/tour-detail-query.ts');
  const CARD = read('app/catalog/tours/[id]/_TourDetailClient.tsx');
  it('запрос берёт наименование, ИНН и ОГРН партнёра, но не адрес', () => {
    expect(QUERY).toMatch(/NULLIF\(btrim\(p\.legal_info->>'companyName'\), ''\) AS operator_legal_name/);
    expect(QUERY).toMatch(/COALESCE\(NULLIF\(btrim\(p\.company_inn\), ''\), NULLIF\(btrim\(p\.legal_info->>'inn'\), ''\)\) AS operator_inn/);
    expect(QUERY).toMatch(/AS operator_ogrn/);
    expect(QUERY).not.toMatch(/legal_address|legalAddress/);
  });
  it('вывеска не выдаётся за юрлицо: company_name синхронизирован с name (триггер 052)', () => {
    expect(QUERY).not.toMatch(/p\.company_name AS operator_legal_name/);
  });
  it('карточка показывает исполнителя и честно говорит, когда реквизитов нет', () => {
    expect(CARD).toMatch(/Исполнитель: \{sellerRequisitesLine\(tour\) \?\? 'реквизиты оператора не записаны на платформе'\}/);
  });
});

describe('статус платформы в документах', () => {
  it('оферта не называет платформу платёжным агрегатором по 161-ФЗ', () => {
    const OFFER = read('app/legal/offer/page.tsx');
    expect(OFFER).not.toMatch(/платёжного агрегатора/);
    expect(OFFER).toMatch(/агента Партнёра по приёму платежей/);
  });
  it('условия называют платформу владельцем агрегатора по ЗоЗПП, а не по 132-ФЗ', () => {
    const TERMS = read('app/legal/terms/page.tsx');
    expect(TERMS).toMatch(/владельцем агрегатора информации об услугах/);
    expect(TERMS).toMatch(/ст\. 12 п\. 2\.1/);
  });
});
