/**
 * Кто продавец по закону — строка для карточки тура (02.10).
 *
 * Платформа — владелец агрегатора (ЗоЗПП ст. 12 п. 2.1), исполнитель — оператор.
 * Агрегатор обязан показать потребителю наименование и регистрационные данные
 * исполнителя и отвечает за их недостоверность. Поэтому строка собирается
 * ТОЛЬКО из записанного в `partners` (legal_info.companyName, ИНН, ОГРН):
 * нет ни одного поля — null, и карточка говорит «не записаны», а не молчит
 * и не подставляет название витрины (§4.0).
 *
 * Адреса здесь нет намеренно: у ИП это может быть домашний адрес человека,
 * а закон от ИП его не требует.
 */
export interface SellerRequisites {
  operator_legal_name?: string | null;
  operator_inn?: string | null;
  operator_ogrn?: string | null;
}

export function sellerRequisitesLine(t: SellerRequisites): string | null {
  const parts: string[] = [];
  const name = t.operator_legal_name?.trim();
  const inn = t.operator_inn?.trim();
  const ogrn = t.operator_ogrn?.trim();
  if (name) parts.push(name);
  if (inn) parts.push(`ИНН ${inn}`);
  if (ogrn) parts.push(`ОГРН ${ogrn}`);
  return parts.length > 0 ? parts.join(', ') : null;
}
