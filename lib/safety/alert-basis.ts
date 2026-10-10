/**
 * Основание пункта ленты безопасности для экрана и агента (10.10) — без
 * импортов: читают главная, /safety, сводка, Кузьмич и MCP, а модуль поиска
 * основания (lib/safety/road-basis) тянет зрение, которому на этих путях
 * делать нечего.
 */

export type BasisOrigin = 'manual' | 'image_ocr';

export interface AlertBasis {
  title: string;
  url: string | null;
  /** Прочитано моделью со снимка, человек не проверял. */
  recognized: boolean;
}

/** Строка ленты → основание; без заголовка основания нет. Ссылка — только https. */
export function basisOf(row: { basis_title?: string | null; basis_url?: string | null; basis_origin?: string | null }): AlertBasis | null {
  const title = row.basis_title?.trim();
  if (!title) return null;
  const url = row.basis_url && /^https:\/\/[^\s"<>]+$/.test(row.basis_url) ? row.basis_url : null;
  return { title, url, recognized: row.basis_origin === 'image_ocr' };
}

/** Основание одной строкой для агента (Кузьмич, MCP): что за документ и насколько ему верить. */
export function basisLine(basis: AlertBasis | null): string {
  if (!basis) return '';
  const trust = basis.recognized ? 'распознано со снимка, номер сверять по ссылке' : 'внесено вручную';
  return `основание: ${basis.title} (${trust}${basis.url ? `: ${basis.url}` : ''})`;
}
