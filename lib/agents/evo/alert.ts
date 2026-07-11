/**
 * Построение Telegram-алерта по итогам Evo-цикла.
 *
 * Принцип: алерт — только когда есть что-то НОВОЕ или сломанное.
 * Раньше уведомление уходило на каждый скан с общим числом найденных
 * проблем («18 проблем, обработано 0»), хотя все они — повторные
 * детекции уже известных issues в статусе suggested. Владелец получал
 * шум каждый цикл. Теперь: новые проблемы, алерты Спасателя или ошибки
 * оркестратора — иначе null (не отправлять).
 */

export interface EvoAlertInput {
  scan: unknown;
  evolution: unknown;
  rescue: unknown;
  errors: string[];
}

interface ScanShape {
  issues?: Array<{ severity: string; title: string }>;
  new_issues?: number;
  duration_ms?: number;
}

interface EvolutionShape {
  processed?: number;
  auto_fixes?: number;
}

interface RescueShape {
  alerts?: Array<{ severity: string; title: string }>;
}

/**
 * Возвращает HTML-текст для Telegram или null, если отправлять нечего.
 */
export function buildEvoAlert(result: EvoAlertInput): string | null {
  const s = result.scan as ScanShape | null;
  const e = result.evolution as EvolutionShape | null;
  const r = result.rescue as RescueShape | null;

  const issues = s?.issues ?? [];
  const newIssues = s?.new_issues ?? 0;
  const critical = issues.filter(i => i.severity === 'critical' || i.severity === 'high').length;
  const rescueAlerts = (r?.alerts ?? []).filter(a => a.severity === 'critical' || a.severity === 'warning').length;
  const processed = e?.processed ?? 0;

  const nothingNew = newIssues === 0 && rescueAlerts === 0 && result.errors.length === 0 && processed === 0;
  if (nothingNew) return null;

  return `<b>Evo Scan</b> — новых проблем: ${newIssues} (найдено всего ${issues.length}, критичных ${critical})\n` +
    `Эволюция: обработано ${processed}, автофиксов: ${e?.auto_fixes ?? 0}\n` +
    (rescueAlerts > 0 ? `<b>Спасатель: ${rescueAlerts} алертов</b>\n` : '') +
    (result.errors.length > 0 ? `Ошибки: ${result.errors.join(', ')}\n` : '') +
    `Время: ${Math.round((s?.duration_ms ?? 0) / 1000)}с`;
}
