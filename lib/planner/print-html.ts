/**
 * lib/planner/print-html.ts — документ «Скачать PDF» планера (/planner).
 *
 * Документ пишется в новое окно через `document.write` — окно того же
 * источника, что сайт. До разбора 06.11 название и описание тура, строки
 * предупреждений дня и плана вставлялись в разметку как есть, а название и
 * описание тура пишет оператор — роль с самостоятельной регистрацией. Тур с
 * `<img onerror=…>` в названии выполнял бы чужой скрипт у туриста при нажатии
 * «Скачать PDF», с его сессией.
 *
 * Поэтому сборка вынесена из компонента в чистую функцию, и КАЖДОЕ значение
 * проходит `escapeHtml` здесь, а не у вызывающего: забытый вызов у одного из
 * полей и был дырой. Класс строки предупреждения — только из закрытого
 * списка. Сторож — исполнение: tests/unit/planner-print-html.test.tsx.
 */
import { escapeHtml } from '@/lib/text/escape-html';

export interface PrintPlanDay {
  /** Номер карточки в списке (1, 2, 3 …), а не ключ дня. */
  num: number;
  confirmed: boolean;
  title: string;
  /** Подпись рода дня («Прилёт», «Тур оператора») или null. */
  badge: string | null;
  priceLine: string;
  description: string;
  /** Зона и сложность одной строкой. */
  meta: string;
  warnings: readonly string[];
}

export interface PrintPlanEstimate {
  people: number;
  lines: ReadonlyArray<{ label: string; basis: string; source: string; total: readonly [number, number] | null }>;
  total: readonly [number, number];
  perPerson: readonly [number, number];
  assumptions: readonly string[];
}

export interface PrintPlanInput {
  dateRange: string;
  adults: number;
  childAges: readonly number[];
  days: readonly PrintPlanDay[];
  estimate: PrintPlanEstimate | null;
  warnings: ReadonlyArray<{ severity: string; message: string }>;
  fmt: (n: number) => string;
}

const WARNING_CLASSES = new Set(['critical', 'important', 'info']);

const STYLE = `
  body { font-family: 'Segoe UI', system-ui, sans-serif; margin: 40px; color: #1a1714; line-height: 1.5; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .subtitle { color: #6b6560; font-size: 13px; margin-bottom: 24px; }
  .day { border: 1px solid #e5e5e5; border-radius: 8px; padding: 14px 16px; margin-bottom: 10px; page-break-inside: avoid; }
  .day-header { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .day-num { width: 26px; height: 26px; border-radius: 50%; background: var(--accent); color: white; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0; }
  .day-title { font-weight: 600; font-size: 14px; flex: 1; }
  .day-badge { font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 4px; background: #f0f0f0; }
  .day-price { font-size: 12px; color: var(--accent); font-weight: 600; white-space: nowrap; }
  .day-desc { font-size: 12px; color: #6b6560; margin-top: 4px; }
  .day-meta { font-size: 11px; color: #9a9590; margin-top: 4px; }
  .day-warn { font-size: 11px; color: #d29922; margin-top: 4px; padding: 4px 8px; background: #fef9ec; border-radius: 4px; }
  .confirmed { border-color: var(--success); border-width: 2px; }
  .footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid #e5e5e5; font-size: 12px; color: #6b6560; }
  .price-row { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px; }
  .price-total { display: flex; justify-content: space-between; font-size: 14px; font-weight: 600; margin-top: 8px; padding-top: 8px; border-top: 1px solid #e5e5e5; color: var(--accent); }
  .warnings { margin-top: 16px; }
  .warning { padding: 6px 10px; border-radius: 6px; font-size: 12px; margin-bottom: 6px; }
  .warning-critical { background: #fde8e8; color: #dc2626; }
  .warning-important { background: #fef9ec; color: #d29922; }
  .warning-info { background: #eef6ff; color: #2568b0; }
  @media print { body { margin: 20px; } }
`;

export function buildPlanPrintHtml(input: PrintPlanInput): string {
  const e = escapeHtml;
  const { fmt } = input;
  // Вилка, у которой нижняя граница равна верхней, — одна сумма, а не «X — X».
  const rubRange = ([a, b]: readonly [number, number]) => (a === b ? `${fmt(a)} ₽` : `${fmt(a)} — ${fmt(b)} ₽`);
  const range = input.dateRange ? e(input.dateRange) : '';
  const kids = input.childAges.length > 0 ? ` + дети: ${input.childAges.map((a) => e(a)).join(', ')} лет` : '';
  const daysHtml = input.days.map((d) => `<div class="day${d.confirmed ? ' confirmed' : ''}">
  <div class="day-header">
    <div class="day-num">${e(d.num)}</div>
    <div class="day-title">${e(d.title)}</div>
    ${d.badge ? `<span class="day-badge">${e(d.badge)}</span>` : ''}
    <span class="day-price">${e(d.priceLine)}</span>
  </div>
  ${d.description ? `<div class="day-desc">${e(d.description)}</div>` : ''}
  <div class="day-meta">${e(d.meta)}</div>
  ${d.warnings.map((w) => `<div class="day-warn">${e(w)}</div>`).join('')}
</div>`).join('\n');

  const est = input.estimate;
  const estimateHtml = est ? `<div class="footer">
  <div style="font-size:11px;font-weight:600;margin-bottom:6px">Смета на группу · ${e(est.people)} чел. — цены туров от операторов и выбранных предложений, остальное ориентир по средним ценам</div>
  ${est.lines.map((l) => `<div class="price-row"><span>${e(l.label)} · ${e(l.basis)}${l.source === 'estimate' ? ' · ориентир' : l.source === 'offer' ? ' · выбрано' : ''}</span><span>${l.total ? e(rubRange(l.total)) : 'цена не указана'}</span></div>`).join('')}
  <div class="price-total"><span>Итого на группу</span><span>${e(rubRange(est.total))}</span></div>
  <div class="price-row"><span>На человека</span><span>${e(rubRange(est.perPerson))}</span></div>
  ${est.assumptions.map((a) => `<div style="font-size:11px;color:#9a9590;margin-top:4px">${e(a)}</div>`).join('')}
  <div style="font-size:11px;color:#9a9590;margin-top:6px">Без авиабилетов Москва — Камчатка</div>
</div>` : '';

  const warningsHtml = input.warnings.length > 0 ? `<div class="warnings">
  ${input.warnings.map((w) => `<div class="warning warning-${WARNING_CLASSES.has(w.severity) ? w.severity : 'info'}">${e(w.message)}</div>`).join('')}
</div>` : '';

  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"/>
<title>Маршрут по Камчатке${range ? ` | ${range}` : ''}</title>
<style>${STYLE}</style></head><body>
<h1>Маршрут по Камчатке</h1>
<div class="subtitle">${range ? `${range} | ` : ''}${e(input.days.length)} дней | ${e(input.adults)} взрослых${kids}</div>
${daysHtml}
${estimateHtml}
${warningsHtml}
<div style="margin-top:24px;font-size:11px;color:#9a9590;text-align:center">vedarai.ru — Камчатка с заботой</div>
</body></html>`;
}
