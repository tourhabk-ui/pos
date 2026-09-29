/**
 * Сборка снимка «MCP против сайта» — обе стороны в один момент.
 *
 * Чистая от ввода-вывода: всё, что читает мир, приходит через `ParityDeps`.
 * Боевые зависимости собирает роут `/api/cron/channel-parity` (MCP — тем же
 * `validateToolArgs` + `executeKuzmichTool`, что зовёт `/api/mcp`; сайт — теми
 * же функциями, что рисуют страницы), тест подставляет свои.
 *
 * Правило отказа (§4.0): каждый блок собирается своим `try`. Упавший блок —
 * `null` и запись в `failed` с причиной; остальные блоки живут. Снимок с
 * упавшим блоком не «зелёный»: `ok` — только когда отказов нет.
 */
import type { MarketplaceTourRow } from '@/lib/search/tour-search';
import type { SafetyLiveData } from '@/app/_home/data';
import { catalogAvailability, tourDays } from '@/lib/tours/catalog-availability';
import { volcanoStem } from '@/lib/services/safety/volcano-match';
import {
  TOUR_FIELDS, VOLCANO_FIELDS, contractParams, diffFields, emptyTour, emptyVolcano,
  parseAvailabilityText, parseEgsPhrase, parseKvertPhrase, parseSafetyText,
  parseToursText, parseVolcanoAggregates, parseVolcanoText,
  type ContractTool, type Diff, type NotCompared, type SafetyFacts, type TourFacts, type VolcanoFacts,
} from '@/lib/quality/channel-parity';

/** Фиксированный набор владельца (29.09): восемь живых туров каталога. */
export const PARITY_TOUR_IDS: readonly number[] = [27, 4, 5, 6, 7, 9, 10, 11];
/** Тур, у которого сверяются свободные даты. */
export const PARITY_AVAILABILITY_TOUR_ID = 27;
/** Вулканы, которые сверяются поимённо. Имена — как их называет человек, а не KVERT. */
export const PARITY_VOLCANOES: readonly string[] = [
  'Крашенинникова', 'Шивелуч', 'Чикурачки', 'Безымянный', 'Горелый', 'Карымская', 'Ключевская', 'Мутновский',
];
/** Окно `get_tour_availability` по умолчанию — 14 суток, и не больше 12 строк в ответе. */
const AVAILABILITY_DAYS = 14;
const AVAILABILITY_MAX_LINES = 12;

export interface UiSlot { date: string; free_slots: number }

export interface ParityDeps {
  now: Date;
  /** Вызвать инструмент MCP тем же путём, что `/api/mcp`. Бросает — отказ блока. */
  callMcp: (tool: string, args: Record<string, string>) => Promise<string>;
  mcpServerInfo: { name: string; version: string };
  mcpTools: ReadonlyArray<{ name: string; inputSchema: unknown }>;
  /** Каталог сайта. */
  uiTours: () => Promise<MarketplaceTourRow[]>;
  /** Свободные даты тура так, как их получает календарь карточки. `null` — тур не на витрине. */
  uiSlots: (id: number) => Promise<UiSlot[] | null>;
  /** Живой срез, на котором строятся `/safety` и главная. */
  uiSafety: () => Promise<SafetyLiveData>;
}

export interface ParityReport {
  ok: boolean;
  probe: 'channel_parity_v1';
  taken_at: string;
  contract: { mcp: { server: { name: string; version: string }; tools: ContractTool[] } };
  tours: { mcp: Record<string, TourFacts | null> | null; ui: Record<string, TourFacts | null> | null };
  tour_availability: {
    tour_id: number;
    window: { from: string; to: string };
    mcp: Array<{ date: string; seats: number }> | null;
    ui: Array<{ date: string; seats: number }> | null;
  };
  safety: { mcp: SafetyFacts | null; ui: SafetyFacts | null };
  volcanoes: {
    mcp: Record<string, VolcanoFacts | null> | null;
    ui: Record<string, VolcanoFacts | null> | null;
    aggregates: { mcp: Aggregates | null; ui: Aggregates | null };
  };
  diffs: Diff[];
  /** Поля, у которых хотя бы одна сторона молчит: сверить нечем. Не расхождения. */
  not_compared: NotCompared[];
  failed: Array<{ block: string; reason: string }>;
  /** Что читателю снимка нужно знать, чтобы не принять оговорку источника за расхождение. */
  notes: string[];
}

export interface Aggregates {
  elevated_any_scale: number | null;
  elevated_kvert_only: number | null;
  kvert_watched: number | null;
}

const ELEVATED = new Set(['yellow', 'orange', 'red']);

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Камчатка не нужна: `today` для года «29 сентября» — сутки ответа MCP, то есть UTC-дата запроса. */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Сторона сайта: туры ─────────────────────────────────────────────────────

export function uiTourFacts(row: MarketplaceTourRow, slots: UiSlot[] | null, now: Date): TourFacts {
  // pg отдаёт bigint строкой: без Number id в снимке был бы "27", а не 27.
  const t = emptyTour(Number(row.id));
  const price = Number(row.base_price);
  t.title = row.title ?? null;
  t.price_amount = Number.isFinite(price) && price > 0 ? price : null;
  t.price_unit = row.price_unit ?? null;
  t.duration_days = tourDays(row);
  t.operator = row.operator_name ?? null;
  t.activity_type = row.activity_type ?? null;
  // «Не читали» (slots === null) и «читали — свободных нет» — разные исходы:
  // первое null, второе 0.
  if (slots) {
    t.seats_free = slots.length > 0 ? slots[0].free_slots : 0;
    t.next_date = slots.length > 0 ? slots[0].date : null;
  }
  t.season_open = catalogAvailability(row, now) !== 'season_over';
  return t;
}

// ── Вулканы: сопоставление имён двух сторон ─────────────────────────────────

/** Один ли это вулкан. Сравниваются основы (`volcanoStem`) — тем же способом, что ищет MCP. */
export function sameVolcano(a: string, b: string): boolean {
  const x = volcanoStem(a);
  const y = volcanoStem(b);
  if (x.length === 0 || y.length === 0) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

/** Чтение КФ ЕГС с радара: подпись метки несёт ту же фразу, что и ответ MCP. */
function egsFromRadarNote(note: string): { color: string | null; events: number | null } {
  const e = parseEgsPhrase(note);
  return { color: e.color, events: e.events };
}

export function uiVolcanoFacts(name: string, live: SafetyLiveData, bulletinDate: string | null): VolcanoFacts | null {
  const item = live.volcanoes.items.find((v) => sameVolcano(v.name, name));
  const mark = live.radar.hazards.find((h) => h.kind === 'volcano' && sameVolcano(h.label, name));
  if (!item && !mark) return null;
  const f = emptyVolcano();
  f.name_ru = item?.name ?? mark?.label ?? null;
  if (item) {
    f.kvert_color = item.acc;
    f.ash_km = item.ashHeightM ? item.ashHeightM / 1000 : null;
    // Сутки по Камчатке, как в ответе MCP: тот печатает дату в этом поясе.
    f.kvert_observed_at = item.observedAt ? kamchatkaIsoDay(item.observedAt) : null;
  }
  if (mark) {
    // На радаре КФ ЕГС виден только у повышенных вулканов: спокойный вулкан
    // отметки не получает, и «на сайте КФ ЕГС нет» здесь — устройство экрана,
    // а не пропажа (см. notes).
    const e = egsFromRadarNote(mark.note);
    f.egs_color = e.color;
    f.egs_events = e.events;
    f.egs_bulletin_date = e.color ? bulletinDate : null;
  }
  return f;
}

function kamchatkaIsoDay(iso: string): string | null {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return new Date(t.getTime() + 12 * 3_600_000).toISOString().slice(0, 10);
}

// ── Сборка ──────────────────────────────────────────────────────────────────

export async function collectChannelParity(deps: ParityDeps): Promise<ParityReport> {
  const today = isoDay(deps.now);
  const failed: ParityReport['failed'] = [];
  const diffs: Diff[] = [];
  const notCompared: NotCompared[] = [];
  const notes: string[] = [
    'MCP отдаёт день наблюдения KVERT без времени, поэтому kvert_observed_at сравнивается по суткам Камчатки.',
    'На сайте КФ ЕГС виден только у вулканов, повышенных хотя бы по одной шкале (радар): у спокойного вулкана egs_* на стороне ui пусты по устройству экрана.',
    'Каталог get_tours кэшируется в процессе на 3 минуты: мест и ближайших дат MCP может отставать от сайта на этот срок.',
    'У safety_status нет списка предупреждений — feed_titles на стороне mcp всегда null; сверяется счётчик и верхнее предупреждение.',
  ];

  // Контракт: из тех же данных, которые отдаёт tools/list.
  const contract: ParityReport['contract'] = {
    mcp: {
      server: { name: deps.mcpServerInfo.name, version: deps.mcpServerInfo.version },
      tools: deps.mcpTools.map((t) => ({ name: t.name, params: contractParams(t.inputSchema) })),
    },
  };

  // ── Туры ──
  let toursMcp: Record<string, TourFacts | null> | null = null;
  let toursUi: Record<string, TourFacts | null> | null = null;
  try {
    const text = await deps.callMcp('get_tours', {});
    const parsed = parseToursText(text, today);
    if (parsed.size === 0) throw new Error('get_tours: ни одной строки тура не разобрано из ответа');
    toursMcp = {};
    for (const id of PARITY_TOUR_IDS) toursMcp[String(id)] = parsed.get(id) ?? null;
  } catch (e) {
    failed.push({ block: 'tours.mcp', reason: reason(e) });
  }
  try {
    const rows = await deps.uiTours();
    if (rows.length === 0) throw new Error('каталог сайта отдал ноль туров');
    toursUi = {};
    for (const id of PARITY_TOUR_IDS) {
      const row = rows.find((r) => Number(r.id) === id);
      if (!row) { toursUi[String(id)] = null; continue; }
      let slots: UiSlot[] | null = null;
      try {
        slots = await deps.uiSlots(id);
      } catch (e) {
        failed.push({ block: `tours.ui.slots.${id}`, reason: reason(e) });
      }
      toursUi[String(id)] = uiTourFacts(row, slots, deps.now);
    }
  } catch (e) {
    failed.push({ block: 'tours.ui', reason: reason(e) });
  }
  if (toursMcp && toursUi) {
    for (const id of PARITY_TOUR_IDS) {
      const a = toursMcp[String(id)];
      const b = toursUi[String(id)];
      if (!a || !b) {
        // Тур на одной стороне есть, на другой нет — расхождение само по себе.
        if (a || b) diffs.push({ scope: `tour:${id}`, field: 'presence', mcp: a ? 'есть' : 'нет', ui: b ? 'есть' : 'нет' });
        else notCompared.push({ scope: `tour:${id}`, field: 'presence', silent: ['mcp', 'ui'] });
        continue;
      }
      const d = diffFields(`tour:${id}`, TOUR_FIELDS, a as unknown as Record<string, unknown>, b as unknown as Record<string, unknown>);
      diffs.push(...d.diffs);
      notCompared.push(...d.not_compared);
    }
  }

  // ── Свободные даты ──
  const to = isoDay(new Date(Date.parse(today) + (AVAILABILITY_DAYS - 1) * 86_400_000));
  let availMcp: Array<{ date: string; seats: number }> | null = null;
  let availUi: Array<{ date: string; seats: number }> | null = null;
  try {
    const text = await deps.callMcp('get_tour_availability', { tour: String(PARITY_AVAILABILITY_TOUR_ID) });
    const p = parseAvailabilityText(text);
    if (!p) throw new Error('get_tour_availability: ответ не разобран');
    availMcp = p.dates.map((d) => ({ date: d.date, seats: d.free }));
  } catch (e) {
    failed.push({ block: 'tour_availability.mcp', reason: reason(e) });
  }
  try {
    const slots = await deps.uiSlots(PARITY_AVAILABILITY_TOUR_ID);
    if (slots === null) throw new Error('тур не на витрине сайта — календарь дат не отдан');
    availUi = slots.filter((s) => s.date >= today && s.date <= to).map((s) => ({ date: s.date, seats: s.free_slots }));
  } catch (e) {
    failed.push({ block: 'tour_availability.ui', reason: reason(e) });
  }
  if (availMcp && availUi) {
    // MCP печатает не больше 12 строк; UI сверяем по тем же первым датам,
    // иначе «MCP обрезал» читалось бы как «MCP потерял».
    const uiWindow = availMcp.length >= AVAILABILITY_MAX_LINES ? availUi.slice(0, AVAILABILITY_MAX_LINES) : availUi;
    const dates = [...new Set([...availMcp.map((x) => x.date), ...uiWindow.map((x) => x.date)])].sort();
    for (const d of dates) {
      const a = availMcp.find((x) => x.date === d);
      const b = uiWindow.find((x) => x.date === d);
      if (!a || !b) diffs.push({ scope: `availability:${PARITY_AVAILABILITY_TOUR_ID}`, field: `date:${d}`, mcp: a ? a.seats : 'нет даты', ui: b ? b.seats : 'нет даты' });
      else if (a.seats !== b.seats) diffs.push({ scope: `availability:${PARITY_AVAILABILITY_TOUR_ID}`, field: `seats:${d}`, mcp: a.seats, ui: b.seats });
    }
  }

  // ── Обстановка ──
  let live: SafetyLiveData | null = null;
  try {
    live = await deps.uiSafety();
  } catch (e) {
    failed.push({ block: 'safety.ui', reason: reason(e) });
  }
  let safetyMcp: SafetyFacts | null = null;
  let safetyUi: SafetyFacts | null = null;
  try {
    const text = await deps.callMcp('safety_status', {});
    safetyMcp = parseSafetyText(text);
    if (!safetyMcp) throw new Error(`safety_status: ответ не разобран (${text.slice(0, 80)})`);
  } catch (e) {
    failed.push({ block: 'safety.mcp', reason: reason(e) });
  }
  if (live) {
    if (live.safety.degraded) {
      failed.push({ block: 'safety.ui', reason: 'лента обстановки сайта собрана со сбоем (degraded) — цифрам верить нельзя' });
    } else {
      const top = live.safety.alerts[0] ?? null;
      safetyUi = {
        alert_count: live.safety.activeCount,
        max_severity: live.safety.maxSeverity,
        top_alert: top ? { text: top.title, source: null, kind: top.type } : null,
        updated_at: live.safety.updatedAt,
        feed_titles: live.safety.alerts.map((a) => a.title),
      };
    }
  }
  if (safetyMcp && safetyUi) {
    const flat = (s: SafetyFacts) => ({
      alert_count: s.alert_count, max_severity: s.max_severity, updated_at: s.updated_at,
      top_alert_text: s.top_alert?.text ?? null, top_alert_kind: s.top_alert?.kind ?? null, top_alert_source: s.top_alert?.source ?? null,
    });
    const d = diffFields('safety', ['alert_count', 'max_severity', 'top_alert_text', 'top_alert_kind', 'top_alert_source', 'updated_at'], flat(safetyMcp), flat(safetyUi));
    diffs.push(...d.diffs);
    notCompared.push(...d.not_compared);
  }

  // ── Вулканы ──
  let volMcp: Record<string, VolcanoFacts | null> | null = null;
  let volUi: Record<string, VolcanoFacts | null> | null = null;
  let aggMcp: Aggregates | null = null;
  let aggUi: Aggregates | null = null;

  try {
    const general = await deps.callMcp('get_volcano_status', {});
    const agg = parseVolcanoAggregates(general);
    // Повышенных только по KVERT — из строк общего ответа. Верно, пока список
    // не обрезан («…и ещё N»): обрезанный список — неполный счёт, то есть null.
    const truncated = /…и ещё \d+/.test(general);
    const lineColors = general.split('\n')
      .filter((l) => /^[^:]+: КФ ЕГС/.test(l))
      .map((l) => parseKvertPhrase(l).color);
    aggMcp = {
      elevated_any_scale: agg.elevated_any_scale,
      elevated_kvert_only: agg.elevated_any_scale !== null && !truncated
        ? lineColors.filter((c) => c !== null && ELEVATED.has(c)).length
        : null,
      kvert_watched: agg.kvert_watched,
    };
    volMcp = {};
    for (const name of PARITY_VOLCANOES) {
      const text = await deps.callMcp('get_volcano_status', { volcano: name });
      volMcp[name] = parseVolcanoText(text, (n) => sameVolcano(n, name));
    }
  } catch (e) {
    failed.push({ block: 'volcanoes.mcp', reason: reason(e) });
  }
  if (live) {
    if (live.volcanoes.degraded) {
      failed.push({ block: 'volcanoes.ui', reason: 'пульс вулканов сайта собран со сбоем (degraded)' });
    } else {
      // Дату сводки КФ ЕГС сайт не показывает числом — берём ту, что назвал MCP:
      // это дата ОДНОЙ и той же сводки, которую читают обе стороны.
      const bulletin = volMcp ? Object.values(volMcp).map((v) => v?.egs_bulletin_date ?? null).find((x) => x !== null) ?? null : null;
      volUi = {};
      for (const name of PARITY_VOLCANOES) volUi[name] = uiVolcanoFacts(name, live, bulletin);
      const marks = live.radar.degraded ? null : live.radar.hazards.filter((h) => h.kind === 'volcano').length;
      if (marks === null) {
        notes.push('Радар сайта собран с оговоркой (degraded): часть кодов не привязана к месту и отметки не нарисованы, поэтому число отметок вулканов неполно — elevated_any_scale на стороне ui = null, а не занижено.');
      }
      aggUi = {
        elevated_any_scale: marks,
        elevated_kvert_only: live.volcanoes.items.filter((v) => ELEVATED.has(v.acc)).length,
        kvert_watched: live.volcanoes.items.length,
      };
    }
  }
  if (volMcp && volUi) {
    for (const name of PARITY_VOLCANOES) {
      const a = volMcp[name];
      const b = volUi[name];
      if (!a && !b) { notCompared.push({ scope: `volcano:${name}`, field: 'presence', silent: ['mcp', 'ui'] }); continue; }
      if (!a || !b) {
        diffs.push({ scope: `volcano:${name}`, field: 'presence', mcp: a ? 'есть' : 'нет в сводках', ui: b ? 'есть' : 'нет на сайте' });
        continue;
      }
      // name_ru сравнивается по основе: «Вулкан Ключевская сопка» и «Ключевской» — один вулкан.
      const d = diffFields(`volcano:${name}`, VOLCANO_FIELDS.filter((f) => f !== 'name_ru'), a as unknown as Record<string, unknown>, b as unknown as Record<string, unknown>);
      diffs.push(...d.diffs);
      notCompared.push(...d.not_compared);
      // Латиница в названии там, где человек читает по-русски, — дефект вывода
      // (случай Чикурачки 29.09): значения полей совпасть могут, а имя нет.
      const latin = (n: string | null) => n !== null && /[A-Za-z]{4,}/.test(n);
      if (latin(a.name_ru) || latin(b.name_ru)) {
        diffs.push({ scope: `volcano:${name}`, field: 'name_script', mcp: a.name_ru, ui: b.name_ru });
      }
    }
  }
  if (aggMcp && aggUi) {
    const d = diffFields('volcano:aggregates', ['elevated_any_scale', 'elevated_kvert_only', 'kvert_watched'],
      aggMcp as unknown as Record<string, unknown>, aggUi as unknown as Record<string, unknown>);
    diffs.push(...d.diffs);
    notCompared.push(...d.not_compared);
  }

  return {
    ok: failed.length === 0,
    probe: 'channel_parity_v1',
    taken_at: deps.now.toISOString(),
    contract,
    tours: { mcp: toursMcp, ui: toursUi },
    tour_availability: {
      tour_id: PARITY_AVAILABILITY_TOUR_ID, window: { from: today, to }, mcp: availMcp, ui: availUi,
    },
    safety: { mcp: safetyMcp, ui: safetyUi },
    volcanoes: { mcp: volMcp, ui: volUi, aggregates: { mcp: aggMcp, ui: aggUi } },
    diffs,
    not_compared: notCompared,
    failed,
    notes,
  };
}
