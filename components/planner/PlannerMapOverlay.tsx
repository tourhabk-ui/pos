'use client';

/**
 * Что карта планировщика говорит словами (22.10).
 *
 * Владелец со скрином /planner на телефоне: «как работает карта в
 * Планировщике не пойму?». На карте не было ни слова о том, что такое точки
 * и что будет по нажатию; плашка обещала четыре цвета зон, которых карта не
 * рисовала; отказ загрузки выглядел как «маршрутов нет». Здесь — одна
 * колонка в левом верхнем углу:
 *
 *   • при замене дня — плашка замены (что нажать и что значат яркие и
 *     серые точки);
 *   • загрузка / отказ / «маршрутов нет» — три разных состояния, разными
 *     словами (§4.0: отказ — не «нет данных»);
 *   • легенда — только зоны, которые нарисованы, тем же цветом, что пин
 *     (lib/planner/map-markers, plannerLegend);
 *   • подсказка, что делать с точкой, и что значат кружки с номером.
 *
 * Стекло тёмное (поверх карты, §2): `data-theme="dark"`, текст —
 * `--glass-fg`. Отказ узнаётся кромкой цвета предупреждения, кнопка
 * «Повторить» — сплошная. Плашка замены — кромкой цвета пина дня: тем же,
 * каким выделен день на карте и в списке, а не тёплым цветом предупреждения.
 *
 * Ревью 22.10 (второй круг):
 *   • день, который маршрутом не заменяют (прилёт, отъезд, переезд, день
 *     многодневного тура), не обещает «нажмите точку — она встанет вместо
 *     дня»: плашка говорит почему, и только;
 *   • серые точки при замене — «другая зона или зона не записана»: зона
 *     точки без записи неизвестна, назвать её «другой» было бы догадкой;
 *   • (третий круг) у дня, чья зона не записана или вне четырёх, «той же
 *     зоны» нет: ярких точек нет, и плашка говорит это словами, а не
 *     красит точки зоны, угаданной по расстоянию;
 *   • «Часть маршрутов не загрузилась» — с «Повторить» и вне сворачиваемой
 *     части: свернул легенду — предупреждение осталось;
 *   • на телефоне, когда план появился, легенда сворачивается сама до строки
 *     заголовка и строки о днях: развёрнутая она закрывала север края, а
 *     вид подогнан раньше, чем план вырос.
 *
 * Ревью 22.10 (третий круг, мелкое):
 *   • «маршрутов нет» называет, ЧТО искали: точки ищутся по виду маршрута,
 *     а плитки мест («Вулканы») — виды мест, и маршрутов с такой пометкой
 *     нет (lib/planner/bg-routes). Прежнее «для выбранных интересов
 *     маршрутов нет» было неправдой: маршруты на вулканы есть. Без выбора
 *     интересов — «показаны маршруты с пометкой …», а не «по вашим»;
 *   • заменяемый день открыт, а загрузка отказала — плашка дня не пустая:
 *     «Точек нет — маршруты не загрузились» («Повторить» — в своей плашке);
 *   • открыт день, который не заменяют, — точки остаются в цветах зон, и
 *     легенда остаётся, свёрнутой;
 *   • «что нажать» при замене — те же слова, что на кнопке карточки точки.
 */

import { useEffect, useId, useRef, useState, type Ref } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Loader, RotateCw, X } from 'lucide-react';
import type { LegendEntry } from '@/lib/planner/map-markers';
import { asPlannerZone, planDayHex, zoneName, ZONE_OUTSIDE } from '@/lib/planner/zone-style';

export type PlannerMapStatus = 'loading' | 'ok' | 'empty' | 'failed';

export const MAP_TEXT = {
  // Без «по вашим интересам»: пока интересы не выбраны, грузятся маршруты по
  // умолчанию, и «ваши» было бы неправдой.
  loading: 'Загружаем маршруты для карты…',
  // Обновить страницу — потерять план: он не хранится ни в адресе, ни в
  // браузере. Слова ведут к кнопке, которая перезагружает только маршруты.
  failed: 'Маршруты не загрузились. Проверьте связь и нажмите «Повторить».',
  retry: 'Повторить',
  // Каталог ответил, а спрошенных видов нет вовсе — подписей нечего назвать.
  emptyBare: 'Маршрутов с точкой на карте нет.',
  chooseInterests: 'Выберите интересы.',
  partial: 'Часть маршрутов не загрузилась.',
  legendTitle: 'Маршруты по зонам',
  days: 'Дни вашего плана. Нажмите кружок — день откроется в плане.',
  hintNoPlan: 'Точки — маршруты под ваши интересы. Нажмите точку — откроется карточка маршрута.',
  hintTap: 'Нажмите точку — откроется карточка маршрута.',
  hintPlan: 'Нажмите точку — её можно добавить в план новым днём или поставить вместо дня.',
  // Открыт день, который не заменяют: карточка точки предлагает только «Добавить в план».
  hintAddOnly: 'Нажмите точку — её можно добавить в план новым днём.',
  // Заменяемый день открыт, а маршруты не загрузились: «Повторить» — в плашке отказа.
  editFailed: 'Точек нет — маршруты не загрузились.',
  editColors: 'Яркие — та же зона, что у дня; серые — другая зона или зона не записана.',
  // Без «под ваши интересы»: интересы могли быть и не выбраны (точки по умолчанию).
  editNoSameZone: 'В зоне этого дня точек на карте нет — все точки серые. Поставить можно любую.',
  // Зона дня не из четырёх (не записана или район вне их): «та же зона»
  // не определена, и серость точек — не приговор им (§4.0).
  editZoneNotRecorded: 'Зона этого дня не записана — все точки серые. Поставить можно любую.',
  editZoneOutside: 'Этот день вне четырёх зон — все точки серые. Поставить можно любую.',
} as const;

/**
 * Что нажать при замене дня — те же слова, что на кнопке карточки точки
 * («Заменить день N», RouteDetailCard): точка сама день не меняет, она
 * открывает карточку.
 */
export function editActionText(n: number): string {
  return `Нажмите точку, затем «Заменить день ${n}».`;
}

const quoted = (labels: readonly string[]) => labels.map(l => `«${l}»`).join(', ');

/**
 * Каталог ответил пусто по этим видам. Точки ищутся по виду МАРШРУТА, и
 * плитка места («Вулканы») такой пометкой у маршрутов не бывает — говорим,
 * что искали, а не «маршрутов нет»: маршруты на вулканы есть.
 */
export function emptyKindsText(labels: readonly string[]): string {
  return `Точки ищутся по виду маршрута; маршрутов с пометкой ${quoted(labels)} нет.`;
}

/** Интересы не выбраны — показаны маршруты по умолчанию, и это сказано. */
export function byDefaultText(labels: readonly string[]): string {
  return `Показаны маршруты с пометкой ${quoted(labels)} — выберите интересы.`;
}

/** Что карта искала (lib/planner/bg-routes) — подписями плиток. */
export interface PlannerMapSearch {
  /** Интересы не выбраны — спрошены виды по умолчанию. */
  byDefault: boolean;
  /** Виды, по которым точки есть. */
  shown: readonly string[];
  /** Виды, по которым каталог ответил: маршрутов нет. */
  empty: readonly string[];
}

const NO_SEARCH: PlannerMapSearch = { byDefault: false, shown: [], empty: [] };

/** Плашка «пусто»: что искали и, без выбора, что сделать. */
export function emptyText(search: PlannerMapSearch): string {
  const what = search.empty.length > 0 ? emptyKindsText(search.empty) : MAP_TEXT.emptyBare;
  return search.byDefault ? `${what} ${MAP_TEXT.chooseInterests}` : what;
}

/** «Замена дня 2» — одно слово на плашке карты и на полосе над вкладками. */
export function editingDayTitle(n: number, replaceable: boolean): string {
  return replaceable ? `Замена дня ${n}` : `День ${n}`;
}

const GLASS = 'fx-glass-dense rounded-2xl px-3 py-2.5 shadow-lg text-[var(--glass-fg)]';
const WARN_EDGE = { border: '1px solid color-mix(in srgb, var(--warning) 60%, transparent)' } as const;

/** Кружок с номером — как пин дня на карте. */
function DaySwatch({ n, size = 'sm' }: { n: number; size?: 'sm' | 'md' }) {
  const box = size === 'md' ? 'w-7 h-7 text-[11px]' : 'w-4 h-4 text-[9px]';
  return (
    <span
      aria-hidden
      className={`${box} shrink-0 rounded-full ring-2 ring-white/90 flex items-center justify-center font-bold text-[var(--glass-fg)]`}
      style={{ background: planDayHex() }}
    >
      {n}
    </span>
  );
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <button
      type="button"
      onClick={onRetry}
      className="pointer-events-auto mt-2 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold bg-[var(--warning)] text-[var(--bg-primary)] transition-opacity duration-200 hover:opacity-90"
    >
      <RotateCw className="w-3.5 h-3.5" aria-hidden />
      {MAP_TEXT.retry}
    </button>
  );
}

/** Широкий экран (компьютер): легенда там не закрывает карту и сама не сворачивается. */
function isWideScreen(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(min-width: 1024px)').matches;
  } catch (err) {
    console.error('[planner-map] matchMedia недоступен', err);
    return false;
  }
}

export interface PlannerMapEditing {
  number: number;
  title: string;
  /** Почему этот день маршрутом не заменяют (lib/planner/plan-ops); null — заменяют. */
  refusal: string | null;
  /** Сколько точек на карте в той же зоне, что у дня. */
  sameZone: number;
  /**
   * Зона дня, как её видит человек (записанная, не угаданная — DayPlan.zoneShown).
   * Не одна из четырёх — ярких точек нет, и плашка говорит почему.
   */
  dayZone: string | null;
}

/** Что значат цвета точек при замене этого дня — словами. */
function editColorsText(editing: PlannerMapEditing): string {
  if (asPlannerZone(editing.dayZone) === null) {
    return zoneName(editing.dayZone) === ZONE_OUTSIDE ? MAP_TEXT.editZoneOutside : MAP_TEXT.editZoneNotRecorded;
  }
  return editing.sameZone > 0 ? MAP_TEXT.editColors : MAP_TEXT.editNoSameZone;
}

export function PlannerMapOverlay({
  status, refreshing = false, legend, total, partial, hasPlan, editing, search = NO_SEARCH, onRetry, onStopEditing, panelRef,
}: {
  status: PlannerMapStatus;
  /** Идёт перезагрузка, а на карте ещё прежние точки. */
  refreshing?: boolean;
  legend: readonly LegendEntry[];
  total: number;
  /** Часть интересов не загрузилась, но точки есть. */
  partial: boolean;
  hasPlan: boolean;
  editing: PlannerMapEditing | null;
  /** Что искали — для «пусто» и строки о видах без маршрутов. */
  search?: PlannerMapSearch;
  onRetry: () => void;
  onStopEditing: () => void;
  /** Колонка плашек — карта оставляет её низ над точками при подгонке вида. */
  panelRef?: Ref<HTMLDivElement>;
}) {
  // Свернуть можно: на телефоне развёрнутая легенда закрывает север края.
  // По умолчанию развёрнута — человек сначала должен прочитать, что на карте.
  const [collapsed, setCollapsed] = useState(false);
  // План появился — на телефоне легенда сворачивается сама, один раз: дальше
  // решает человек.
  const hadPlan = useRef(hasPlan);
  useEffect(() => {
    if (hasPlan && !hadPlan.current && !isWideScreen()) setCollapsed(true);
    hadPlan.current = hasPlan;
  }, [hasPlan]);
  const detailsId = useId();
  const replaceable = editing !== null && editing.refusal === null;
  // Открыт день, который не заменяют: точки на карте остаются в цветах зон,
  // и легенда остаётся — свёрнутой, чтобы не спорить с плашкой дня.
  // Развернуть можно; выбор помнится для этого дня, а не навсегда.
  const fixedDay = editing !== null && editing.refusal !== null ? editing.number : null;
  const [legendOpenForDay, setLegendOpenForDay] = useState<number | null>(null);
  const showLegend = status === 'ok' && (!editing || fixedDay !== null);
  const showDays = hasPlan && !editing;
  const legendCollapsed = fixedDay !== null ? legendOpenForDay !== fixedDay : collapsed;
  const open = !showLegend || !legendCollapsed;
  const toggleLegend = () => {
    if (fixedDay !== null) setLegendOpenForDay(d => (d === fixedDay ? null : fixedDay));
    else setCollapsed(c => !c);
  };
  // При замене дня «нажмите точку» — только когда точки есть. Нет точек —
  // плашка замены говорит, почему, вместо второй плашки поверх карты.
  const editingInline = editing && (status === 'loading' || status === 'empty');
  // Что показано и чего нет — строкой в легенде: без выбора — «показаны
  // маршруты с пометкой …», с выбором — по каким видам маршрутов нет.
  const searchLine = search.byDefault
    ? (search.shown.length > 0 ? byDefaultText(search.shown) : null)
    : (search.empty.length > 0 ? emptyKindsText(search.empty) : null);
  const hint = fixedDay !== null
    ? MAP_TEXT.hintAddOnly
    : hasPlan ? MAP_TEXT.hintPlan : search.byDefault ? MAP_TEXT.hintTap : MAP_TEXT.hintNoPlan;

  return (
    <div
      ref={panelRef}
      data-theme="dark"
      className="absolute top-3 left-3 right-14 lg:right-auto lg:max-w-sm z-10 flex flex-col gap-2 pointer-events-none"
    >
      {editing && (
        <div
          className={`${GLASS} pointer-events-auto flex items-start gap-3`}
          style={{ border: `1px solid color-mix(in srgb, ${planDayHex()} 80%, transparent)` }}
        >
          <DaySwatch n={editing.number} size="md" />
          <div className="flex-1 min-w-0">
            {/* На телефоне это же название уже стоит на полосе над вкладками —
                здесь оно только на широком экране, и не обрезается. */}
            <p className="hidden lg:block text-xs font-semibold break-words">
              {editingDayTitle(editing.number, replaceable)}: {editing.title}
            </p>
            {editing.refusal !== null && (
              <p className="text-[11px] leading-snug text-[var(--glass-fg)]">{editing.refusal}</p>
            )}
            {replaceable && status === 'ok' && (
              <>
                <p className="text-[11px] leading-snug text-[var(--glass-fg-muted)]">{editActionText(editing.number)}</p>
                <p className="text-[11px] leading-snug text-[var(--glass-fg-muted)]">
                  {editColorsText(editing)}
                </p>
              </>
            )}
            {replaceable && editingInline && (
              <p role="status" className="text-[11px] leading-snug text-[var(--glass-fg-muted)]">
                {status === 'loading' ? MAP_TEXT.loading : emptyText(search)}
              </p>
            )}
            {/* Отказ: на телефоне название дня скрыто (оно на полосе над
                вкладками), и без этой строки плашка была пустой. Кнопка
                «Повторить» — одна, в плашке отказа ниже. */}
            {replaceable && status === 'failed' && (
              <p className="text-[11px] leading-snug text-[var(--glass-fg)]">{MAP_TEXT.editFailed}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onStopEditing}
            aria-label={replaceable ? 'Закончить замену дня' : 'Закрыть день'}
            className="w-9 h-9 -mr-1 -mt-1 flex items-center justify-center rounded-lg text-[var(--glass-fg-muted)] hover:text-[var(--glass-fg)] transition-colors duration-200 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {status === 'loading' && !(replaceable && editingInline) && (
        <div role="status" className={`${GLASS} flex items-center gap-2 text-xs`}>
          <Loader className="w-3.5 h-3.5 animate-spin shrink-0" aria-hidden />
          {MAP_TEXT.loading}
        </div>
      )}

      {status === 'failed' && (
        <div role="alert" className={`${GLASS} pointer-events-auto flex items-start gap-2`} style={WARN_EDGE}>
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--warning)]" aria-hidden />
          <div className="flex-1 min-w-0">
            <p className="text-xs leading-snug">{MAP_TEXT.failed}</p>
            <RetryButton onRetry={onRetry} />
          </div>
        </div>
      )}

      {status === 'empty' && !(replaceable && editingInline) && (
        <div role="status" className={`${GLASS} text-xs leading-snug`}>
          {emptyText(search)}
        </div>
      )}

      {(showLegend || showDays) && (
        <div className={GLASS} aria-live="polite">
          {showLegend && (
            <button
              type="button"
              onClick={toggleLegend}
              aria-expanded={!legendCollapsed}
              aria-controls={detailsId}
              className="pointer-events-auto w-full flex items-center gap-1.5 text-xs font-semibold text-left -my-1 py-1"
            >
              <span className="flex-1">{MAP_TEXT.legendTitle} · {total}</span>
              {refreshing && <Loader className="w-3 h-3 animate-spin" aria-label="Обновляем" />}
              {legendCollapsed
                ? <ChevronDown className="w-4 h-4 shrink-0 text-[var(--glass-fg-muted)]" aria-hidden />
                : <ChevronUp className="w-4 h-4 shrink-0 text-[var(--glass-fg-muted)]" aria-hidden />}
              <span className="sr-only">{legendCollapsed ? 'Показать легенду' : 'Свернуть легенду'}</span>
            </button>
          )}
          {open && showLegend && (
            <ul id={detailsId} aria-label="Цвета зон на карте" className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
              {legend.map(e => (
                <li key={e.zone ?? 'none'} className="flex items-center gap-1.5 text-xs">
                  <span
                    aria-hidden
                    className="w-2.5 h-2.5 shrink-0 rounded-full ring-1 ring-white/80"
                    style={{ background: e.hex }}
                  />
                  <span>{e.name}</span>
                  <span className="text-[var(--glass-fg-muted)]">{e.count}</span>
                </li>
              ))}
            </ul>
          )}
          {/* Строка о днях видна и в свёрнутой легенде: кружки с номером —
              главное, что появилось на карте вместе с планом. */}
          {showDays && (
            <p className={`flex items-center gap-1.5 text-xs leading-snug ${showLegend ? 'mt-1.5' : ''}`}>
              <DaySwatch n={1} />
              {MAP_TEXT.days}
            </p>
          )}
          {open && showLegend && searchLine && (
            <p className="mt-1.5 text-[11px] leading-snug text-[var(--glass-fg)]">{searchLine}</p>
          )}
          {open && showLegend && (
            <p className="mt-1.5 text-[11px] leading-snug text-[var(--glass-fg-muted)]">{hint}</p>
          )}
        </div>
      )}

      {/* Часть интересов не ответила — отдельно от легенды: свёрнутая легенда
          и замена дня это предупреждение не прячут. */}
      {status === 'ok' && partial && (
        <div role="status" className={`${GLASS} pointer-events-auto flex items-start gap-2`} style={WARN_EDGE}>
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--warning)]" aria-hidden />
          <div className="flex-1 min-w-0">
            <p className="text-xs leading-snug">{MAP_TEXT.partial}</p>
            <RetryButton onRetry={onRetry} />
          </div>
        </div>
      )}
    </div>
  );
}
