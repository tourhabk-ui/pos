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
  /** Кто считал прогон: флагман или фоллбэк waterfall. */
  decision_model?: string | null;
  decision_error?: string | null;
  coverage?: {
    source?: string;
    files_listed?: number;
    files_reviewed?: number;
    mock_files_scanned?: number;
  };
}

/**
 * Прочёс «ослеп»: скан не смог прочитать НИ ОДНОГО файла. На проде это значит,
 * что перечень/тела файлов не достались (GitHub недостижим из Timeweb/РФ), и
 * весь sweep коллапсировал в ноль. Прежде это молча рапортовало «0 проблем» —
 * теперь видимый алерт, а не тишина.
 */
function coverageBlind(s: ScanShape | null): boolean {
  const c = s?.coverage;
  if (!c) return false;
  return c.source === 'none' || (c.files_reviewed === 0 && c.mock_files_scanned === 0);
}

interface EvolutionShape {
  processed?: number;
  auto_fixes?: number;
}

interface RescueShape {
  alerts?: Array<{ severity: string; title: string }>;
}

/**
 * Флагманская ли модель считала аудит.
 *
 * Решатель ходит флагман → OpenRouter-релей → Anthropic напрямую → DeepSeek/Qwen.
 * Строка модели приходит в трёх видах: 'anthropic/claude-…' (через OpenRouter),
 * 'anthropic:claude-…' (напрямую) и голое имя фоллбэка ('deepseek-chat').
 * Флагманом считаем только явно антропиковский путь — всё прочее это съезд.
 */
export function isFlagshipDecision(model: string | null | undefined): boolean {
  if (!model) return false;
  return /^anthropic[/:]/.test(model);
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

  const blind = coverageBlind(s);
  // Аудит считал не флагман — повод сказать вслух. Waterfall съезжает на
  // DeepSeek/Qwen молча (нет ключа, лёг релей), и снаружи прогон выглядит
  // здоровым: зелёный, с находками. Раз владелец требует, чтобы аудит считала
  // самая сильная модель, тихое понижение обязано быть слышным.
  // Прогон, где ревью не запускалось (модели нет вовсе), понижением не считаем.
  const downgraded = Boolean(s?.decision_model) && !isFlagshipDecision(s?.decision_model);
  // Решатель МОЛЧИТ: файлы в ревью уходили, а модель ответа не записана —
  // значит ни один провайдер не ответил (или ответ не распарсился). Хуже
  // тихого понижения: «0 находок» неотличимо от «никто не смотрел». Найдено
  // 01.08 атрибуцией из #904: четыре прогона подряд decision_model:null, все
  // выглядели зелёными. Прогон, где ревью не ЗАПУСКАЛОСЬ (reviewed 0),
  // немотой не считаем — там нечего было отвечать.
  const mute = (s?.coverage?.files_reviewed ?? 0) > 0 && !s?.decision_model;
  const nothingNew = newIssues === 0 && rescueAlerts === 0 && result.errors.length === 0 && processed === 0;
  // Ослепший прочёс, съезд с флагмана и немой решатель — тоже поводы:
  // молчание тут = «не читает всё», «думает не тот» и «не думает никто».
  if (nothingNew && !blind && !downgraded && !mute) return null;

  const cov = s?.coverage;
  return `<b>Evo Scan</b> — новых проблем: ${newIssues} (найдено всего ${issues.length}, критичных ${critical})\n` +
    `Эволюция: обработано ${processed}, автофиксов: ${e?.auto_fixes ?? 0}\n` +
    (blind
      ? `<b>Прочёс ослеп</b>: прочитано 0 файлов (source=${cov?.source ?? '?'}, перечислено ${cov?.files_listed ?? 0}). Источник кода недостижим — sweep пуст.\n`
      : `Прочёс: source=${cov?.source ?? '?'}, отревьюено ${cov?.files_reviewed ?? 0}, мок-скан ${cov?.mock_files_scanned ?? 0}\n`) +
    (s?.decision_model
      ? (downgraded
        ? `<b>Аудит считал ФОЛЛБЭК: ${s.decision_model}</b> — не флагман. Проверьте ключ и релей.\n`
        : `Модель аудита: ${s.decision_model}\n`)
      : (mute
        ? `<b>РЕШАТЕЛЬ МОЛЧИТ</b>: файлы ушли в ревью, но ответа нет — «0 находок» ничего не значит.\n${s?.decision_error ? `Причина: ${s.decision_error}\n` : 'Причина не записана — прогон до диагностики 01.08.\n'}`
        : '')) +
    (rescueAlerts > 0 ? `<b>Спасатель: ${rescueAlerts} алертов</b>\n` : '') +
    (result.errors.length > 0 ? `Ошибки: ${result.errors.join(', ')}\n` : '') +
    `Время: ${Math.round((s?.duration_ms ?? 0) / 1000)}с`;
}
