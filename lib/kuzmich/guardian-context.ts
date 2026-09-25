import { pool } from '@/lib/db-pool';
import { ACC_META, type AccColor } from '@/lib/services/safety/kvert-vona';
import { kfegsPhrase, kfegsIsFresh, levelForColor, type ScaleColor } from '@/lib/services/safety/volcano-scales';
import { placeTypeLabel } from '@/lib/places/type-label';
import { hazardLabelLower } from '@/lib/safety/hazard-labels';
import { placeNameSearchSql } from '@/lib/places/name-match';

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
  /** Последняя строка сводки КФ ЕГС по этому месту (миграция 1010). */
  kfegs_color: ScaleColor | null;
  kfegs_raw: string | null;
  kfegs_seismicity: string | null;
  kfegs_date: string | null;
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
    // По Камчатке, как в get_volcano_status: по часам сервера (UTC)
    // наблюдение утра 25.09 читалось как 24.09 — два инструмента называли
    // одному агенту разные даты одного снимка (сверка 26.09).
    ? ` (наблюдение ${new Date(p.volcano_observed_at).toLocaleDateString('ru-RU', { timeZone: 'Asia/Kamchatka' })})`
    : '';
  return `Авиационный цветовой код KVERT: ${meta.short.toUpperCase()} — ${meta.label.toLowerCase()}.${ash}${seen}`;
}

/**
 * Вторая шкала — сводка КФ ЕГС (24.09). До этого MCP и Кузьмич отвечали про
 * Мутновский «KVERT: ЗЕЛЁНЫЙ — спокоен» при жёлтом у КФ ЕГС (сейсмичность
 * выше фона, сотни событий за сутки): авиационный код — не про тропу.
 *
 * Строки в сводке нет — вулкан ею не охвачен, молчим (как с KVERT). Строка
 * есть, но устарела — говорим, что устарела, а не выдаём старый цвет за
 * текущий и не молчим, будто её не было (§4.0).
 */
function kfegsLine(p: GuardianPlaceRow, nowMs: number = Date.now()): string | null {
  if (!p.kfegs_date || p.kfegs_raw === null) return null;
  if (!kfegsIsFresh(p.kfegs_date, nowMs)) {
    const [, m, d] = p.kfegs_date.split('-');
    return `Сводка КФ ЕГС по вулкану устарела (последняя за ${d}.${m}) — текущего уровня по ней нет.`;
  }
  const phrase = kfegsPhrase({
    color: p.kfegs_color, raw: p.kfegs_raw, seismicity: p.kfegs_seismicity, date: p.kfegs_date,
  });
  // Пояснение — только при повышенном уровне: у зелёного и неразобранного
  // кода «повышенная сейсмичность» была бы неправдой.
  const why = levelForColor(p.kfegs_color)
    ? ' Это не авиационный код: по этой шкале выше зелёного — повышенная сейсмичность и эмиссия газов.'
    : '';
  return `Шкала ${phrase}.${why}`;
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

/**
 * Место для ПУБЛИЧНОЙ ссылки (handoff MCP, задача #60): id первой записи по
 * тому же правилу матчинга, что и основной запрос getGuardianContext ниже
 * (merged_into_id IS NULL, ILIKE, кратчайшее имя первым) — чтобы ссылка вела
 * на то место, о котором инструмент ответил. Сверх правила — is_visible:
 * страж может знать скрытое место, но ссылку на невидимую страницу не даём.
 */
export async function resolvePlaceForLink(placeNameRaw: string): Promise<string | null> {
  const q = placeNameRaw.trim();
  if (!q) return null;
  try {
    // Слова, не буквальная фраза (issue #1987): «Горелый вулкан» и «Вулкан
    // Горелый» — один и тот же порядок для человека, разный для ILIKE '%…%'.
    const { clause, params } = placeNameSearchSql('name', q, 1);
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM places
        WHERE merged_into_id IS NULL AND is_visible = true AND (${clause})
        ORDER BY char_length(name) ASC
        LIMIT 1`,
      params,
    );
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

export async function getGuardianContext(placeNameRaw: string): Promise<string> {
  // Обезвреживаем ввод до подстановки в промпт (issue #328). Название места
  // и так уходит эхом в hedge-строки контекста для callAIFast/callAIWaterfall.
  // Флаг injectionSuspected доступен через sanitizePromptInput для логирования
  // на уровне вызывающего кода; здесь просто не пропускаем маркеры в промпт.
  const { text: placeName } = sanitizePromptInput(placeNameRaw);
  if (!placeName.trim()) return '';

  // Слова, не буквальная фраза (issue #1986/#1987): ILIKE '%Мутновский
  // вулкан%' не находит «Вулкан Мутновский» (обратный порядок) и вместо
  // отказа молча подставляет случайную запись, СОДЕРЖАЩУЮ ту же подстроку
  // («Скитур на Мутновский вулкан») — без KVERT-строки канонической точки.
  const placeMatch = placeNameSearchSql('p.name', placeName, 1);

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
         vs.observed_at         AS volcano_observed_at,
         kb.color               AS kfegs_color,
         kb.color_raw           AS kfegs_raw,
         kb.seismicity          AS kfegs_seismicity,
         kb.observed_date::text AS kfegs_date
       FROM places p
       LEFT JOIN location_safety_profile lsp ON lsp.agent_route_id = p.ark_id
       LEFT JOIN location_real_time_status lrs ON lrs.agent_route_id = p.ark_id
       LEFT JOIN volcano_status vs ON vs.place_ark_id = p.ark_id
       LEFT JOIN LATERAL (
         SELECT b.color, b.color_raw, b.seismicity, b.observed_date
           FROM volcano_bulletin_kfegs b
          WHERE b.place_ark_id = p.ark_id
          ORDER BY b.observed_date DESC
          LIMIT 1
       ) kb ON TRUE
       WHERE p.merged_into_id IS NULL AND (${placeMatch.clause})
       ORDER BY char_length(p.name) ASC
       LIMIT 3`,
      placeMatch.params,
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
      // type <> 'outcome': оценки ответов Кузьмича (kuzmich-outcomes) — служебная
      // телеметрия качества, не знание о месте. Запись «Оценка ответа: 6/10...»
      // совпадала по ILIKE с названием места и уходила туристу (проба 113, 15.08).
      `SELECT title, compiled_truth, type
       FROM agent_knowledge
       WHERE agent_id = 'kuzmich'
         AND type <> 'outcome'
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

  // Дедуп алертов между записями: зонные/общерегиональные алерты приходят в
  // active_alerts КАЖДОГО совпавшего места (safety-ingest, зона без координат),
  // и один и тот же список печатался трижды подряд, раздувая контекст втрое
  // (проба 113: 6.5 КБ, из них ~3 КБ — повторы). Каждый алерт показывается
  // один раз — при первом упоминании; ни один не теряется.
  const shownAlerts = new Set<string>();
  const freshAlerts = (list: string[]): string[] => {
    const fresh = list.filter((a) => !shownAlerts.has(a));
    fresh.forEach((a) => shownAlerts.add(a));
    return fresh;
  };

  for (const p of placesRes.rows) {
    const status = p.recommender_status ? STATUS_LABEL[p.recommender_status] ?? p.recommender_status : null;
    // Раздел каталога — в заголовке, рядом с именем. До 17.09 location_type
    // выбирался этим же запросом и не печатался: тип был виден только на
    // бейдже карточки и маркере карты, а в MCP — единственном канале, которым
    // прод читается из сессии, — его не было. Так два городских холма
    // месяцами носили «ВУЛКАН» (972-974), и проверить починку было нечем.
    // Типа нет → ничего не печатаем (не «Место»): «не записано» не равно
    // «известно, что это место» (§4.0).
    const kind = placeTypeLabel(p.location_type);
    const nameWithKind = kind ? `${p.name} (${kind.toLowerCase()})` : p.name;
    const header = status
      ? `${nameWithKind} [${status}${p.is_open === false ? ' — ЗАКРЫТО' : ''}]`
      : nameWithKind;
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
      const hedgeAlerts = p.active_alerts?.length ? freshAlerts(p.active_alerts) : [];
      if (p.alert_message) {
        parts.push(`${hedge} Но по похожему названию есть активный алерт: ${p.alert_message} — уточни, относится ли он к месту, которое спросили.`);
      } else if (hedgeAlerts.length) {
        parts.push(`${hedge} Но по похожему названию есть активные алерты: ${hedgeAlerts.join(', ')} — уточни, относятся ли они к месту, которое спросили.`);
      } else {
        parts.push(hedge);
      }
      // Оранжевый/красный ACC — как и алерт, нельзя молча уронить при слабом
      // совпадении: отдаём с рамкой неуверенности.
      const lowAcc = accOf(p);
      if (lowAcc === 'orange' || lowAcc === 'red') {
        parts.push(`Но по похожему названию вулкан под кодом KVERT ${ACC_META[lowAcc].short.toUpperCase()} (${ACC_META[lowAcc].label.toLowerCase()}) — уточни, тот ли это вулкан.`);
      }
      // То же для шкалы КФ ЕГС: критичный уровень свежей сводки не роняется.
      if (levelForColor(p.kfegs_color) === 'critical' && kfegsIsFresh(p.kfegs_date)) {
        parts.push(`Но по похожему названию у вулкана уровень КФ ЕГС ${p.kfegs_color === 'red' ? 'красный' : 'оранжевый'} — уточни, тот ли это вулкан.`);
      }
      continue;
    }

    // Алерты первыми — безопасность важнее описания
    if (p.alert_message) {
      parts.push(`Алерт: ${p.alert_message}`);
    } else if (p.active_alerts?.length) {
      const fresh = freshAlerts(p.active_alerts);
      if (fresh.length) parts.push(`Активные алерты: ${fresh.join(', ')}.`);
    }

    // Авиационный цветовой код вулкана (KVERT, migration 728) — сразу после
    // алертов: прямой safety-сигнал. Наблюдённого кода нет → молчим (не «зелёный»).
    const acc = accOf(p);
    if (acc) parts.push(accLine(acc, p));
    const kfegs = kfegsLine(p);
    if (kfegs) parts.push(kfegs);

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
      const hazards = p.hazard_types.map((h) => hazardLabelLower(h)).join(', ');
      parts.push(`Опасности: ${hazards}.`);
    } else if (!p.altitude_m && !p.nearest_medical_km && !p.sat_communicator_required) {
      parts.push('Профиль безопасности для этого места не оцифрован.');
    }

    if (p.description) {
      parts.push(p.description.slice(0, 300));
    }
  }

  for (const a of alertsRes.rows) {
    // active_alerts мест хранит те же ea.title (safety-ingest) — алерт, уже
    // показанный в строке места, здесь не повторяем.
    if (shownAlerts.has(a.title)) continue;
    shownAlerts.add(a.title);
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
