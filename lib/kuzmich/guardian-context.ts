import { pool } from '@/lib/db-pool';
import { ACC_META, type AccColor } from '@/lib/services/safety/kvert-vona';

interface GuardianPlaceRow {
  name: string;
  description: string | null;
  location_type: string | null;
  lat: number | null;
  lng: number | null;
  hazard_types: string[] | null;
  difficulty_level: number | null;
  altitude_m: number | null;
  nearest_medical_km: number | null;
  sat_communicator_required: boolean | null;
  capacity_per_day: number | null;
  open_from_date: string | null;
  open_to_date: string | null;
  is_open: boolean | null;
  current_crowds: number | null;
  active_alerts: string[] | null;
  recommender_status: string | null;
  alert_message: string | null;
  alert_severity: number | null;
  tourists_today: number | null;
  volcano_acc: string | null;
  volcano_ash_height_m: number | null;
  volcano_observed_at: string | null;
}

/** Наблюдённый ACC вулкана (unassigned/отсутствие → null — без ложного «спокоен»). */
function accOf(p: GuardianPlaceRow): AccColor | null {
  const c = p.volcano_acc;
  return c === 'green' || c === 'yellow' || c === 'orange' || c === 'red' ? c : null;
}

function accLine(color: AccColor, p: GuardianPlaceRow): string {
  const meta = ACC_META[color];
  const ash = p.volcano_ash_height_m ? ` Пепел до ${(p.volcano_ash_height_m / 1000).toFixed(1)} км.` : '';
  const seen = p.volcano_observed_at
    ? ` (наблюдение ${new Date(p.volcano_observed_at).toLocaleDateString('ru-RU')})`
    : '';
  return `Авиационный цветовой код KVERT: ${meta.short.toUpperCase()} — ${meta.label.toLowerCase()}.${ash}${seen}`;
}

interface AlertRow {
  title: string;
  severity: number;
  description: string | null;
  source_url: string | null;
}

interface KnowledgeRow {
  title: string;
  compiled_truth: string;
  type: string;
}

const STATUS_LABEL: Record<string, string> = {
  green: 'ЗЕЛЁНЫЙ',
  yellow: 'ЖЁЛТЫЙ',
  red: 'КРАСНЫЙ',
};

const HAZARD_LABELS: Record<string, string> = {
  avalanche: 'лавины',
  rockfall: 'камнепад',
  thermal: 'термальные поля',
  altitude: 'высотная болезнь',
  wildlife: 'дикие животные',
  water: 'горные реки',
  rapids: 'пороги',
  chemical: 'химические выбросы',
  weather: 'резкая смена погоды',
};

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^а-яёa-z0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim();
}

// Паттерны попыток перехвата инструкций модели (issue #328). Пользовательский
// ввод (напр. название места) эхом уходит в контекст для callAIFast/
// callAIWaterfall — маркеры ролей и «забудь инструкции» надо обезвредить ДО
// формирования промпта. Держим RU и EN формы.
const INJECTION_PATTERN_SOURCES: string[] = [
  'ignore\\s+(all\\s+)?(previous|prior|above)\\s+instructions?',
  'disregard\\s+(the\\s+)?(above|previous|prior)',
  'you\\s+are\\s+now\\b',
  'act\\s+as\\s+(an?\\s+)?(system|admin|developer)',
  '</?(system|assistant|user|developer)>',
  '(^|\\s)(system|assistant|developer)\\s*:',
  'забудь\\s+(все\\s+)?(предыдущие|прошлые|прежние)\\s+(инструкции|указания|команды)',
  'игнорируй\\s+(все\\s+)?(предыдущие|прошлые|выше)',
  'ты\\s+теперь\\b',
  'веди\\s+себя\\s+как\\s+(система|админ|разработчик)',
];

const MAX_PROMPT_INPUT_LEN = 200;

/**
 * Обезвреживает пользовательский ввод перед подстановкой в промпт модели:
 * вырезает маркеры ролей и попытки «забудь инструкции», схлопывает пробелы и
 * обрезает по длине. Возвращает очищенный текст и флаг injectionSuspected для
 * логирования. НЕ трогает обычные туристические запросы (в них паттернов нет).
 */
export function sanitizePromptInput(raw: string): { text: string; injectionSuspected: boolean } {
  let text = (typeof raw === 'string' ? raw : '').slice(0, MAX_PROMPT_INPUT_LEN * 4);
  let injectionSuspected = false;

  for (const src of INJECTION_PATTERN_SOURCES) {
    if (new RegExp(src, 'i').test(text)) {
      injectionSuspected = true;
      text = text.replace(new RegExp(src, 'gi'), ' ');
    }
  }

  text = text.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT_INPUT_LEN);
  return { text, injectionSuspected };
}

/**
 * CRAG-lite relevance grading (Roitman §16.5.5): ILIKE '%query%' can bind the
 * wrong place — "ORDER BY char_length ASC" prefers the shortest name
 * containing the substring, which for a query like "Толбачик" can surface an
 * unrelated short-named place before the actual volcano. For a safety tool,
 * a confident-looking wrong match is worse than no match: grade the name
 * match before trusting it, so a weak match degrades to an explicit
 * uncertainty note instead of asserting someone else's safety facts.
 */
const MIN_PREFIX_LEN = 3; // короче — тоже "префикс" почти чего угодно (напр. "г." → "гора"/"гейзер")

export function gradeNameMatch(query: string, candidate: string): 'high' | 'low' {
  const q = normalizeForMatch(query);
  const c = normalizeForMatch(candidate);
  if (!q || !c) return 'low';
  if (c === q) return 'high';
  const qWords = q.split(' ').filter(Boolean);
  const cWords = c.split(' ').filter(Boolean);
  const wordMatch = (w: string, t: string) =>
    t === w || (w.length >= MIN_PREFIX_LEN && t.length >= MIN_PREFIX_LEN && (t.startsWith(w) || w.startsWith(t)));
  const covers = (from: string[], to: string[]) =>
    from.every(w => to.some(t => wordMatch(w, t)));
  return (covers(qWords, cWords) || covers(cWords, qWords)) ? 'high' : 'low';
}

export async function getGuardianContext(placeNameRaw: string): Promise<string> {
  // Обезвреживаем ввод до подстановки в промпт (issue #328). Название места
  // и так уходит эхом в hedge-строки контекста для callAIFast/callAIWaterfall.
  // Флаг injectionSuspected доступен через sanitizePromptInput для логирования
  // на уровне вызывающего кода; здесь просто не пропускаем маркеры в промпт.
  const { text: placeName } = sanitizePromptInput(placeNameRaw);
  if (!placeName.trim()) return '';

  const [placesRes, alertsRes, knowledgeRes] = await Promise.all([
    pool.query<GuardianPlaceRow>(
      `SELECT
         p.name, p.description, p.location_type, p.lat, p.lng,
         lsp.hazard_types, lsp.difficulty_level, lsp.altitude_m,
         lsp.nearest_medical_km, lsp.sat_communicator_required,
         lsp.capacity_per_day, lsp.open_from_date, lsp.open_to_date,
         lrs.is_open, lrs.current_crowds, lrs.active_alerts,
         lrs.recommender_status, lrs.alert_message, lrs.alert_severity,
         lrs.tourists_today,
         vs.aviation_color_code AS volcano_acc,
         vs.ash_height_m        AS volcano_ash_height_m,
         vs.observed_at         AS volcano_observed_at
       FROM places p
       LEFT JOIN location_safety_profile lsp ON lsp.agent_route_id = p.ark_id
       LEFT JOIN location_real_time_status lrs ON lrs.agent_route_id = p.ark_id
       LEFT JOIN volcano_status vs ON vs.place_ark_id = p.ark_id
       WHERE p.merged_into_id IS NULL AND p.name ILIKE $1
       ORDER BY char_length(p.name) ASC
       LIMIT 3`,
      [`%${placeName}%`],
    ),
    pool.query<AlertRow>(
      `SELECT title, severity, description, source_url
       FROM external_alerts
       WHERE (expires_at IS NULL OR expires_at > NOW())
         AND (title ILIKE $1 OR description ILIKE $1)
       ORDER BY severity DESC
       LIMIT 3`,
      [`%${placeName}%`],
    ),
    pool.query<KnowledgeRow>(
      `SELECT title, compiled_truth, type
       FROM agent_knowledge
       WHERE agent_id = 'kuzmich'
         AND (title ILIKE $1 OR compiled_truth ILIKE $1)
       ORDER BY
         CASE WHEN type = 'indigenous' THEN 1
              WHEN type = 'auto_gap' THEN 2
              ELSE 3 END,
         updated_at DESC
       LIMIT 5`,
      [`%${placeName}%`],
    ),
  ]);

  if (placesRes.rows.length === 0 && alertsRes.rows.length === 0 && knowledgeRes.rows.length === 0) {
    return '';
  }

  const parts: string[] = [];

  for (const p of placesRes.rows) {
    const status = p.recommender_status ? STATUS_LABEL[p.recommender_status] ?? p.recommender_status : null;
    const header = status
      ? `${p.name} [${status}${p.is_open === false ? ' — ЗАКРЫТО' : ''}]`
      : p.name;
    parts.push(header);

    if (gradeNameMatch(placeName, p.name) === 'low') {
      // Слабое совпадение по названию (в т.ч. из-за русской морфологии —
      // "Авачинский" vs "Авачинская сопка" рвёт префиксное сравнение) — не
      // факт что это то же место, которое спросил пользователь. Высоту,
      // расстояние до медпомощи и т.п. этого места не прикладываем — они
      // могут быть про другой объект. Но активный алерт молчать нельзя:
      // на safety-платформе тихо уронить реальное предупреждение опаснее,
      // чем один лишний уточняющий вопрос — отдаём его с явной рамкой
      // неуверенности вместо простого отказа.
      const hedge =
        `(!) "${p.name}" — неточное совпадение по названию с запросом "${placeName}", ` +
        `данные этого места ниже не приложены. Уточни у пользователя точное ` +
        `название, прежде чем говорить про статус или опасности.`;
      if (p.alert_message) {
        parts.push(`${hedge} Но по похожему названию есть активный алерт: ${p.alert_message} — уточни, относится ли он к месту, которое спросили.`);
      } else if (p.active_alerts?.length) {
        parts.push(`${hedge} Но по похожему названию есть активные алерты: ${p.active_alerts.join(', ')} — уточни, относятся ли они к месту, которое спросили.`);
      } else {
        parts.push(hedge);
      }
      // Оранжевый/красный ACC — как и алерт, нельзя молча уронить при слабом
      // совпадении: отдаём с рамкой неуверенности.
      const lowAcc = accOf(p);
      if (lowAcc === 'orange' || lowAcc === 'red') {
        parts.push(`Но по похожему названию вулкан под кодом KVERT ${ACC_META[lowAcc].short.toUpperCase()} (${ACC_META[lowAcc].label.toLowerCase()}) — уточни, тот ли это вулкан.`);
      }
      continue;
    }

    // Алерты первыми — безопасность важнее описания
    if (p.alert_message) {
      parts.push(`Алерт: ${p.alert_message}`);
    } else if (p.active_alerts?.length) {
      parts.push(`Активные алерты: ${p.active_alerts.join(', ')}.`);
    }

    // Авиационный цветовой код вулкана (KVERT, migration 728) — сразу после
    // алертов: прямой safety-сигнал. Наблюдённого кода нет → молчим (не «зелёный»).
    const acc = accOf(p);
    if (acc) parts.push(accLine(acc, p));

    if (p.tourists_today !== null && p.capacity_per_day) {
      parts.push(`Сегодня посетило: ${p.tourists_today} чел. (норма ${p.capacity_per_day}/день).`);
    }

    if (p.altitude_m) parts.push(`Высота ${p.altitude_m} м.`);

    if (p.nearest_medical_km) {
      parts.push(`До медпомощи: ${p.nearest_medical_km} км.`);
    }

    if (p.sat_communicator_required) {
      parts.push('Требуется спутниковый коммуникатор.');
    }

    if (p.hazard_types?.length) {
      const hazards = p.hazard_types.map((h) => HAZARD_LABELS[h] ?? h).join(', ');
      parts.push(`Опасности: ${hazards}.`);
    } else if (!p.altitude_m && !p.nearest_medical_km && !p.sat_communicator_required) {
      parts.push('Профиль безопасности для этого места не оцифрован.');
    }

    if (p.description) {
      parts.push(p.description.slice(0, 300));
    }
  }

  for (const a of alertsRes.rows) {
    parts.push(`[Алерт КБГС/МЧС] ${a.title}${a.description ? ': ' + a.description.slice(0, 150) : ''}`);
  }

  for (const k of knowledgeRes.rows) {
    if (k.type === 'indigenous') {
      parts.push(`[Традиционные знания] ${k.title}: ${k.compiled_truth.slice(0, 200)}`);
    } else {
      parts.push(`${k.title}: ${k.compiled_truth.slice(0, 200)}`);
    }
  }

  return parts.join('\n');
}
