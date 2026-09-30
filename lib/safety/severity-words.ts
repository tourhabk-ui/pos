/**
 * Шкала тяжести external_alerts словами — 0..3, как её пишут производители
 * (seismic-parser: 0=info, 1=warning, 2=critical, 3=emergency; форма админа —
 * max(3)). До 29.09 и агент, и экран планирования читали «тяжесть N из 5»:
 * предупреждение о цунами (3 — чрезвычайная) выглядело серединой шкалы.
 *
 * Отдельным модулем без зависимостей: его зовут и сервер (safety_status), и
 * клиентский экран планирования.
 */
export const ALERT_SEVERITY_WORDS: readonly string[] = ['справочное', 'предупреждение', 'опасно', 'чрезвычайная ситуация'];

export function alertSeverityWord(severity: number): string {
  const i = Math.max(0, Math.min(ALERT_SEVERITY_WORDS.length - 1, Math.round(severity)));
  return ALERT_SEVERITY_WORDS[i]!;
}
