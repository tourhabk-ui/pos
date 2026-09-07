/**
 * lib/agents/run-evidence.ts — улики прогона человеческими словами.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * Мы хорошо умеем ЗАПИСЫВАТЬ, что делал агент, и почти не умеем это ЧИТАТЬ.
 * `agent_run_history.metadata` пишется давно, `GET /api/admin/agents/runs`
 * его возвращает — а панель «AI и автоматизации» не показывала это поле
 * вообще: ни одного упоминания в компоненте.
 *
 * Цена измерена 04.09. Разведчик не опубликовал выпуск, потому что модель
 * ответила запиской оператору вместо поста; журнал прогона (#1559) знал про
 * это своим кодом, а увидел владелец — глазами, в канале с подписчиками.
 * Между «записано» и «увидено» лежал только отсутствующий экран.
 *
 * ── Устройство ─────────────────────────────────────────────────────────────
 *
 * `metadata` у каждого агента СВОЯ и произвольная: разведчик пишет причины
 * пропуска, ядро — счётчики задач, ингест — число тревог. Общей схемы нет и
 * заводить её ради экрана нельзя — это переписывание всех агентов ради
 * витрины. Поэтому читатель универсальный: показывает ВСЁ, что записано, а
 * знакомым кодам подставляет слова:
 *
 *   *_skip_reason  → SKIP_REASON_LABELS (тот же словарь, что уходит в алерт)
 *   *_detail       → подпись к предыдущему факту, а не отдельная строка
 *   булево         → «да» / «нет»
 *
 * ── Третье состояние (§4.0) ────────────────────────────────────────────────
 *
 * Пустая `metadata` — это «агент ничего про себя не записал», и сказать так
 * обязательно. Молчаливо показать пусто значит выдать «не знаю» за «всё
 * прошло чисто»: ровно та подмена, из-за которой зелёный smoke держал
 * мёртвую карточку. Неизвестный код показывается КАК ЕСТЬ — сырой код
 * честнее слова «неизвестно» и им же ищется по репозиторию.
 */

import { SKIP_REASON_LABELS } from '@/lib/agents/scout-skip-reasons';

/** Тон факта — им же красится строка. `alert` только для настоящих отказов. */
export type EvidenceTone = 'plain' | 'good' | 'alert' | 'muted';

export interface EvidenceFact {
  /** Ключ из metadata — по нему ищут в коде, поэтому виден всегда. */
  key: string;
  /** Как назвать по-русски; для незнакомого ключа — сам ключ. */
  label: string;
  /** Значение словами. */
  value: string;
  /** Уточнение под фактом: текст из парного `*_detail`, если он записан. */
  detail?: string;
  tone: EvidenceTone;
}

export interface RunEvidence {
  facts: EvidenceFact[];
  /** true — агент не записал о прогоне ничего. Это состояние, а не пустота. */
  nothingRecorded: boolean;
}

/** Ключи, которые панель называет по-русски. Остальные показываются как есть. */
const KEY_LABELS: Record<string, string> = {
  trigger: 'чем запущен',
  signals_found: 'сигналов найдено',
  digest_sent: 'выпуск опубликован',
  digest_skip_reason: 'выпуск не вышел, потому что',
  ai_channel_sent: 'пост в AI-канал опубликован',
  ai_channel_skip_reason: 'пост в AI-канал не вышел, потому что',
  claims_dropped: 'утверждений вычеркнуто',
  repeats_suppressed: 'повторов подавлено',
  repeat_blocked: 'заблокирован как повтор',
  sources: 'источников опрошено',
  dead_sources: 'источников молчат',
  items_processed: 'записей обработано',
  llm_calls: 'обращений к модели',
  skip_reason: 'пропущено, потому что',
  status: 'исход',
};

/** Значения, которые сами по себе означают отказ или тревогу. */
const ALERT_KEYS = new Set([
  'digest_skip_reason', 'ai_channel_skip_reason', 'skip_reason',
  'dead_sources', 'errors', 'failed', 'failed_core',
]);

/** Ключ несёт код пропуска — его переводит словарь причин. */
function isSkipReasonKey(key: string): boolean {
  return key === 'skip_reason' || key.endsWith('_skip_reason');
}

/** Ключ — уточнение к соседнему факту, а не самостоятельная строка. */
function isDetailKey(key: string): boolean {
  return key.endsWith('_detail');
}

/**
 * Имя уточнения для факта. Пар в журнале две формы, обе живые:
 * `X` + `X_detail` и `X_skip_reason` + `X_skip_detail` — вторая у разведчика
 * (`ai_channel_skip_reason` / `ai_channel_skip_detail`, #1559). Одной формы
 * мало: по правилу «просто добавь _detail» пара разведчика не сходится, и
 * текст отказа модели уехал бы отдельной безымянной строкой.
 */
function detailKeyCandidates(key: string): string[] {
  const candidates = [`${key}_detail`];
  if (key.endsWith('_reason')) candidates.push(`${key.slice(0, -'_reason'.length)}_detail`);
  return candidates;
}

/** Значение → человеческие слова. Числа и строки как есть, булево словами. */
function renderValue(key: string, raw: unknown): string {
  if (raw === null || raw === undefined) return 'не записано';
  if (typeof raw === 'boolean') return raw ? 'да' : 'нет';
  if (typeof raw === 'number') return String(raw);
  if (Array.isArray(raw)) return raw.length === 0 ? 'пусто' : raw.map(String).join(', ');
  if (typeof raw === 'object') return JSON.stringify(raw);
  const text = String(raw);
  if (!isSkipReasonKey(key)) return text;
  // Незнакомый код показывается как есть: сырой код ищется по репозиторию,
  // слово «неизвестно» не ищется ничем.
  const words = SKIP_REASON_LABELS[text];
  return words ? `${words} (${text})` : text;
}

/** Тон факта: отказ — тревожно, «да» у успеха — хорошо, пустота — приглушённо. */
function toneFor(key: string, raw: unknown): EvidenceTone {
  if (raw === null || raw === undefined) return 'muted';
  if (ALERT_KEYS.has(key)) {
    if (typeof raw === 'number') return raw > 0 ? 'alert' : 'plain';
    if (Array.isArray(raw)) return raw.length > 0 ? 'alert' : 'plain';
    return 'alert';
  }
  if (typeof raw === 'boolean' && (key.endsWith('_sent') || key === 'success')) {
    return raw ? 'good' : 'alert';
  }
  return 'plain';
}

/**
 * Разбирает `metadata` прогона в список фактов для показа.
 *
 * Порядок сохраняется тот, в каком агент записал, — он несёт смысл (сначала
 * что нашли, потом что с этим сделали). Пересортировать значило бы навязать
 * свой порядок чужому рассказу.
 */
export function describeRunEvidence(metadata: unknown): RunEvidence {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { facts: [], nothingRecorded: true };
  }
  const entries = Object.entries(metadata as Record<string, unknown>);
  // Пустые значения не выбрасываем — «поле есть, значения нет» это тоже факт;
  // но объект из одних пустот всё равно остаётся рассказом, а не молчанием.
  if (entries.length === 0) return { facts: [], nothingRecorded: true };

  const bag = new Map(entries);
  const used = new Set<string>();
  const facts: EvidenceFact[] = [];
  for (const [key, raw] of entries) {
    if (isDetailKey(key)) continue; // уйдёт подписью к своему факту
    let detail: string | undefined;
    for (const candidate of detailKeyCandidates(key)) {
      const value = bag.get(candidate);
      if (typeof value === 'string' && value.trim()) {
        detail = value.trim();
        used.add(candidate);
        break;
      }
    }
    facts.push({
      key,
      label: KEY_LABELS[key] ?? key,
      value: renderValue(key, raw),
      ...(detail ? { detail } : {}),
      tone: toneFor(key, raw),
    });
  }

  // Уточнение, не подхваченное ни одним фактом (записали `*_detail`, а сам
  // ключ — нет), не теряется: показываем отдельной строкой, иначе улика
  // исчезает молча — а молча исчезнувшая улика и есть то, что мы чиним.
  for (const [key, raw] of entries) {
    if (!isDetailKey(key) || used.has(key)) continue;
    facts.push({ key, label: KEY_LABELS[key] ?? key, value: renderValue(key, raw), tone: 'plain' });
  }

  return { facts, nothingRecorded: facts.length === 0 };
}
