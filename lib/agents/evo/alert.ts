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
  /** Ступени waterfall до выбранной модели (пакет D) — основа различения. */
  decision_provenance?: string[] | null;
  coverage?: {
    source?: string;
    files_listed?: number;
    files_reviewed?: number;
    mock_files_scanned?: number;
  };
  /** Перепись объективов прогона (E-3): кто отработал, кто упал, кого нет. */
  lenses?: Array<{ name: string; status: string; reason?: string }>;
}

/**
 * Объективы, чьё молчание ничего не значит.
 *
 * `failed` — упал, `not_implemented` — его нет вовсе. И то и другое даёт ноль
 * находок, неотличимый от чистого результата, — до этой правки такой ноль
 * уходил в алерт как «новых проблем: 0». Тот же приём, что «НЕ ПРОВЕРЕНО N из M»
 * в Watchdog (W-2).
 */
function muteLenses(s: ScanShape | null): Array<{ name: string; status: string; reason?: string }> {
  return (s?.lenses ?? []).filter((l) => l.status !== 'ok');
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
 * Решатель ходит Timeweb-шлюз → флагман (OpenRouter-релей) → Anthropic
 * напрямую → DeepSeek/Qwen. Строка модели приходит в четырёх видах:
 * 'timeweb:claude-…' (шлюз Timeweb, §8), 'anthropic/claude-…' (через
 * OpenRouter), 'anthropic:claude-…' (напрямую) и голое имя фоллбэка
 * ('deepseek-chat'). Флагманом считаем явно антропиковский путь и
 * Timeweb-шлюз (модель там — тоже флагман, просто другой сетевой путь до
 * неё) — всё прочее это съезд.
 */
export function isFlagshipDecision(model: string | null | undefined): boolean {
  if (!model) return false;
  return /^anthropic[/:]|^timeweb:/.test(model);
}

/**
 * Возвращает HTML-текст для Telegram или null, если отправлять нечего.
 */
/**
 * EVO_FLAGSHIP_DEFERRED — осознанное решение владельца «флагман отложен»
 * (08.08: «пока не буду пополнять баланс, ближе к продакшену переключим»).
 * С флагом настоящий съезд с флагмана печатается информационной строкой, а не
 * тревогой: напоминать 3×/день о принятом решении — тот же волк-крикун.
 * Перед переключением на Опуса флаг УДАЛИТЬ из env Timeweb — любой съезд
 * снова станет громким. Параметр opts — для тестов; в бою читается env.
 */
export function buildEvoAlert(
  result: EvoAlertInput,
  opts?: { flagshipDeferred?: boolean },
): string | null {
  const flagshipDeferred =
    opts?.flagshipDeferred ?? ['1', 'true', 'yes'].includes((process.env.EVO_FLAGSHIP_DEFERRED ?? '').toLowerCase());
  const s = result.scan as ScanShape | null;
  const e = result.evolution as EvolutionShape | null;
  const r = result.rescue as RescueShape | null;

  const issues = s?.issues ?? [];
  const newIssues = s?.new_issues ?? 0;
  const critical = issues.filter(i => i.severity === 'critical' || i.severity === 'high').length;
  const rescueAlerts = (r?.alerts ?? []).filter(a => a.severity === 'critical' || a.severity === 'warning').length;
  const processed = e?.processed ?? 0;

  const blind = coverageBlind(s);
  // «Не флагман» — это ДВА разных состояния, и до 08.08 алерт их не различал,
  // крича «ФОЛЛБЭК, проверьте ключ и релей» на ШТАТНОГО решателя DeepSeek
  // каждую ночь (политика владельца 04.08: «решатель дипсик либо опус»; релей
  // на опуса — опция, а не обязанность). Теперь по провенансу ступеней:
  //  - релей не настроен (все флагман-ступени «нет ключа») → DeepSeek штатен,
  //    тревога не нужна — строка информационная;
  //  - релей настроен, но флагман не ответил → настоящий съезд, тревога с
  //    ПРИЧИНОЙ из провенанса вместо гадания «ключ или релей».
  // Прогоны без провенанса (до пакета D) считаем понижением, как раньше.
  const prov = s?.decision_provenance ?? null;
  const flagshipSteps = (prov ?? []).filter((p) => /^(flagship|anthropic|timeweb):/.test(p));
  const relayNotConfigured =
    flagshipSteps.length > 0 &&
    flagshipSteps.every((p) => /ключа нет|нет ключа|нет ключа\/релея/.test(p));
  const downgraded =
    Boolean(s?.decision_model) &&
    !isFlagshipDecision(s?.decision_model) &&
    (prov === null || !relayNotConfigured) &&
    !flagshipDeferred;
  // Решатель МОЛЧИТ: файлы в ревью уходили, а модель ответа не записана —
  // значит ни один провайдер не ответил (или ответ не распарсился). Хуже
  // тихого понижения: «0 находок» неотличимо от «никто не смотрел». Найдено
  // 01.08 атрибуцией из #904: четыре прогона подряд decision_model:null, все
  // выглядели зелёными. Прогон, где ревью не ЗАПУСКАЛОСЬ (reviewed 0),
  // немотой не считаем — там нечего было отвечать.
  const mute = (s?.coverage?.files_reviewed ?? 0) > 0 && !s?.decision_model;
  const unchecked = muteLenses(s);
  const nothingNew = newIssues === 0 && rescueAlerts === 0 && result.errors.length === 0 && processed === 0;
  // Ослепший прочёс, съезд с флагмана и немой решатель — тоже поводы:
  // молчание тут = «не читает всё», «думает не тот» и «не думает никто».
  // Непроверенные объективы — тоже повод: без этой строки прогон, где половина
  // прочёса ослепла, уходил бы в тишину как «ничего нового».
  if (nothingNew && !blind && !downgraded && !mute && unchecked.length === 0) return null;

  const cov = s?.coverage;
  return `<b>Evo Scan</b> — новых проблем: ${newIssues} (найдено всего ${issues.length}, критичных ${critical})\n` +
    `Эволюция: обработано ${processed}, автофиксов: ${e?.auto_fixes ?? 0}\n` +
    (blind
      ? `<b>Прочёс ослеп</b>: прочитано 0 файлов (source=${cov?.source ?? '?'}, перечислено ${cov?.files_listed ?? 0}). Источник кода недостижим — sweep пуст.\n`
      : `Прочёс: source=${cov?.source ?? '?'}, отревьюено ${cov?.files_reviewed ?? 0}, мок-скан ${cov?.mock_files_scanned ?? 0}\n`) +
    (s?.decision_model
      ? (downgraded
        ? `<b>Аудит считал ФОЛЛБЭК: ${s.decision_model}</b> — флагман не ответил.\n${flagshipSteps.length ? `Причина: ${flagshipSteps.join(' | ').slice(0, 300)}\n` : 'Причина не записана — прогон до пакета D.\n'}`
        : `Модель аудита: ${s.decision_model}${
            relayNotConfigured
              ? ' — штатный решатель (флагман-релей не настроен)'
              : flagshipDeferred && !isFlagshipDecision(s.decision_model)
                ? ` — флагман отложен владельцем (EVO_FLAGSHIP_DEFERRED)${flagshipSteps.length ? `; флагман: ${flagshipSteps.join(' | ').slice(0, 200)}` : ''}`
                : ''
          }\n`)
      : (mute
        ? `<b>РЕШАТЕЛЬ МОЛЧИТ</b>: файлы ушли в ревью, но ответа нет — «0 находок» ничего не значит.\n${s?.decision_error ? `Причина: ${s.decision_error}\n` : 'Причина не записана — прогон до диагностики 01.08.\n'}`
        : '')) +
    (unchecked.length > 0
      ? `<b>НЕ ПРОВЕРЕНО: ${unchecked.length} из ${(s?.lenses ?? []).length} объективов</b> — их ноль находок не значит «чисто».\n` +
        unchecked
          .map((l) => `  · ${l.name}: ${l.status === 'not_implemented' ? 'объектива нет' : 'отказ'}${l.reason ? ` — ${l.reason.slice(0, 160)}` : ''}`)
          .join('\n') + '\n'
      : '') +
    (rescueAlerts > 0 ? `<b>Спасатель: ${rescueAlerts} алертов</b>\n` : '') +
    (result.errors.length > 0 ? `Ошибки: ${result.errors.join(', ')}\n` : '') +
    `Время: ${Math.round((s?.duration_ms ?? 0) / 1000)}с`;
}
