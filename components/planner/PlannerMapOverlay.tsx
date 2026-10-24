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
 *   • «маршрутов нет» называет, ЧТО искали — подписями плиток анкеты; без
 *     выбора интересов — какие маршруты показаны, а не «по вашим»;
 *   • заменяемый день открыт, а загрузка отказала — плашка дня не пустая
 *     («Повторить» — одна, в плашке отказа);
 *   • открыт день, который не заменяют, — точки остаются в цветах зон, и
 *     легенда остаётся, свёрнутой;
 *   • «что нажать» при замене — те же слова, что на кнопке карточки точки.
 *
 * Пятый круг (22.10):
 *   • плитки мест ищут маршрут по месту пути (lib/planner/bg-routes), и
 *     служебных «вид маршрута», «пометка» в словах больше нет: искали —
 *     «маршруты с точкой на карте» по подписи плитки; что делать — только
 *     когда на карте пусто («Добавьте занятие или место в шаге «Что
 *     интересно»»);
 *   • в плашке дня при отказе — следствие, а не второй раз отказ: «Заменить
 *     день можно, когда точки загрузятся — «Повторить» ниже»;
 *   • предупреждение «часть не загрузилась» стоит над легендой, а пока на
 *     телефоне открыта карточка точки, легенда свёрнута: на 375×667
 *     карточка закрывала и предупреждение, и низ легенды;
 *   • на компьютере легенда у незаменяемого дня сама не сворачивается — то
 *     же правило широкого экрана, что при появлении плана.
 *
 * Шестой круг (22.10):
 *   • отказ при открытом дне — ОДНА плашка: плашка дня говорит «Маршруты не
 *     загрузились — заменить день N можно после «Повторить»» и держит
 *     кнопку. Две плашки подряд на телефоне ложились на северный пин дня;
 *   • частичный отказ называет, что не загрузилось («Не загрузились:
 *     «Вулканы»»), и это имя не попадает в «На карте нет маршрутов»;
 *   • «…или поставить вместо дня» — только когда в плане есть день, который
 *     заменяют; план из прилёта и отъезда этого не обещает;
 *   • каталог знает больше, чем показано, — «показаны 30 из 52»;
 *   • пока на телефоне открыта карточка точки, плашка замены не повторяет
 *     «нажмите точку» и цвета: точка уже нажата, кнопка — в карточке, а
 *     колонка плашек короче (карточка встаёт под её низ, PlannerClient).
 */

import { useEffect, useId, useRef, useState, useSyncExternalStore, type Ref } from 'react';
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
  emptyBare: 'На карте нет маршрутов.',
  // Что делать, когда на карте пусто, — слова шага анкеты.
  chooseInterests: 'Выберите интересы в шаге «Что интересно».',
  addInterest: 'Добавьте занятие или место в шаге «Что интересно».',
  partial: 'Часть маршрутов не загрузилась.',
  legendTitle: 'Маршруты по зонам',
  days: 'Дни вашего плана. Нажмите кружок — день откроется в плане.',
  hintNoPlan: 'Точки — маршруты под ваши интересы. Нажмите точку — откроется карточка маршрута.',
  hintTap: 'Нажмите точку — откроется карточка маршрута.',
  hintPlan: 'Нажмите точку — её можно добавить в план новым днём или поставить вместо дня.',
  // Открыт день, который не заменяют: карточка точки предлагает только «Добавить в план».
  hintAddOnly: 'Нажмите точку — её можно добавить в план новым днём.',
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

/**
 * Заменяемый день открыт, а маршруты не загрузились: отказ и что это значит
 * для дня — одной строкой в плашке дня, рядом с «Повторить». Отдельная
 * плашка отказа под плашкой дня на телефоне ложилась на северный пин дня.
 */
export function editFailedText(n: number): string {
  return `Маршруты не загрузились — заменить день ${n} можно после «Повторить».`;
}

const quoted = (labels: readonly string[]) => labels.map(l => `«${l}»`).join(', ');

/**
 * Каталог ответил пусто по этим интересам — называем, что искали, подписями
 * плиток анкеты. Ищутся маршруты с координатами, поэтому «на карте»:
 * маршрут без координат может быть, а на карте его нет.
 */
export function emptyKindsText(labels: readonly string[]): string {
  return `На карте нет маршрутов: ${quoted(labels)}.`;
}

/**
 * Часть интересов не ответила — называем какие. Это отказ, а не «нет»:
 * эти подписи в «На карте нет маршрутов» не попадают (PlannerClient).
 */
export function partialText(failed: readonly string[]): string {
  return failed.length > 0
    ? `Не загрузились: ${quoted(failed)}. Проверьте связь и нажмите «Повторить».`
    : MAP_TEXT.partial;
}

/** Каталог знает больше, чем пришло, — «показаны 30 из 52», по интересу. */
export function truncatedText(items: readonly PlannerMapTruncated[]): string {
  return `${items.map(i => `«${i.label}» — показаны ${i.shown} из ${i.total}`).join('; ')}.`;
}

/** Интересы не выбраны — показаны маршруты по умолчанию, и это сказано. */
export function byDefaultText(labels: readonly string[]): string {
  return `Интересы не выбраны — на карте маршруты: ${quoted(labels)}. Свои — в шаге «Что интересно».`;
}

/** Интерес, по которому каталог знает больше маршрутов, чем на карте. */
export interface PlannerMapTruncated { label: string; shown: number; total: number }

/** Что карта искала (lib/planner/bg-routes) — подписями плиток. */
export interface PlannerMapSearch {
  /** Интересы не выбраны — спрошены виды по умолчанию. */
  byDefault: boolean;
  /** Виды, по которым точки есть. */
  shown: readonly string[];
  /** Виды, по которым каталог ответил: маршрутов нет. */
  empty: readonly string[];
  /** Виды, по которым каталог не ответил (отказ, не «нет»). */
  failed?: readonly string[];
  /** Виды, по которым показаны не все маршруты. */
  truncated?: readonly PlannerMapTruncated[];
}

const NO_SEARCH: PlannerMapSearch = { byDefault: false, shown: [], empty: [] };

/** Плашка «пусто» (на карте ничего): что искали и что сделать. */
export function emptyText(search: PlannerMapSearch): string {
  const what = search.empty.length > 0 ? emptyKindsText(search.empty) : MAP_TEXT.emptyBare;
  return `${what} ${search.byDefault ? MAP_TEXT.chooseInterests : MAP_TEXT.addInterest}`;
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

function RetryButton({ onRetry, inline = false }: { onRetry: () => void; inline?: boolean }) {
  return (
    <button
      type="button"
      onClick={onRetry}
      className={`pointer-events-auto ${inline ? 'shrink-0' : 'mt-2'} inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold bg-[var(--warning)] text-[var(--bg-primary)] transition-opacity duration-200 hover:opacity-90`}
    >
      <RotateCw className="w-3.5 h-3.5" aria-hidden />
      {MAP_TEXT.retry}
    </button>
  );
}

const WIDE_QUERY = '(min-width: 1024px)';

/** Широкий экран (компьютер): легенда там не закрывает карту и сама не сворачивается. */
function isWideScreen(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia(WIDE_QUERY).matches;
  } catch (err) {
    console.error('[planner-map] matchMedia недоступен', err);
    return false;
  }
}

function subscribeWide(onChange: () => void): () => void {
  try {
    const mql = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(WIDE_QUERY) : null;
    mql?.addEventListener?.('change', onChange);
    return () => mql?.removeEventListener?.('change', onChange);
  } catch (err) {
    console.error('[planner-map] подписка на ширину экрана не удалась', err);
    return () => {};
  }
}

/** Широкий экран — с подпиской: повернули планшет — правило сменилось. */
function useWideScreen(): boolean {
  return useSyncExternalStore(subscribeWide, isWideScreen, () => false);
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
  status, refreshing = false, legend, total, partial, hasPlan, canReplace = false, editing, search = NO_SEARCH, cardOpen = false,
  onRetry, onStopEditing, panelRef,
}: {
  status: PlannerMapStatus;
  /** Идёт перезагрузка, а на карте ещё прежние точки. */
  refreshing?: boolean;
  legend: readonly LegendEntry[];
  total: number;
  /** Часть интересов не загрузилась, но точки есть. */
  partial: boolean;
  hasPlan: boolean;
  /**
   * В плане есть день, который заменяют маршрутом (lib/planner/plan-ops).
   * Нет — подсказка не обещает «поставить вместо дня»: план из прилёта и
   * отъезда заменить нечем. Не сказано — не обещаем.
   */
  canReplace?: boolean;
  editing: PlannerMapEditing | null;
  /** Что искали — для «пусто» и строки о видах без маршрутов. */
  search?: PlannerMapSearch;
  /** Открыта карточка точки: на телефоне она встаёт под колонку плашек. */
  cardOpen?: boolean;
  onRetry: () => void;
  onStopEditing: () => void;
  /** Колонка плашек — карта оставляет её низ над точками при подгонке вида. */
  panelRef?: Ref<HTMLDivElement>;
}) {
  // Свернуть можно: на телефоне развёрнутая легенда закрывает север края.
  // По умолчанию развёрнута — человек сначала должен прочитать, что на карте.
  const [collapsed, setCollapsed] = useState(false);
  const wide = useWideScreen();
  // План появился — на телефоне легенда сворачивается сама, один раз: дальше
  // решает человек.
  const hadPlan = useRef(hasPlan);
  useEffect(() => {
    if (hasPlan && !hadPlan.current && !isWideScreen()) setCollapsed(true);
    hadPlan.current = hasPlan;
  }, [hasPlan]);
  // Карточка точки на телефоне встаёт под колонку плашек (на 375×667 она
  // закрывала предупреждение и низ легенды): пока она открыта, легенда
  // свёрнута. Развернуть можно — до закрытия карточки; закрыл — легенда
  // снова такая, какой была.
  const squeezed = cardOpen && !wide;
  const [openWithCard, setOpenWithCard] = useState(false);
  const [cardSeen, setCardSeen] = useState(cardOpen);
  if (cardSeen !== cardOpen) {
    setCardSeen(cardOpen);
    setOpenWithCard(false);
  }
  const detailsId = useId();
  const replaceable = editing !== null && editing.refusal === null;
  // Открыт день, который не заменяют: точки на карте остаются в цветах зон,
  // и легенда остаётся — на телефоне свёрнутой, чтобы не спорить с плашкой
  // дня (на компьютере место есть, и она сама не сворачивается — то же
  // правило, что при появлении плана). Развернуть можно; выбор помнится
  // для этого дня, а не навсегда.
  const fixedDay = editing !== null && editing.refusal !== null ? editing.number : null;
  const foldForDay = fixedDay !== null && !wide;
  const [legendOpenForDay, setLegendOpenForDay] = useState<number | null>(null);
  const showLegend = status === 'ok' && (!editing || fixedDay !== null);
  const showDays = hasPlan && !editing;
  const legendCollapsed = squeezed
    ? !openWithCard
    : foldForDay ? legendOpenForDay !== fixedDay : collapsed;
  const open = !showLegend || !legendCollapsed;
  const toggleLegend = () => {
    if (squeezed) setOpenWithCard(o => !o);
    else if (foldForDay) setLegendOpenForDay(d => (d === fixedDay ? null : fixedDay));
    else setCollapsed(c => !c);
  };
  // При замене дня «нажмите точку» — только когда точки есть. Нет точек —
  // плашка замены говорит, почему, вместо второй плашки поверх карты.
  const editingInline = editing && (status === 'loading' || status === 'empty');
  // Что показано и чего нет — строкой в легенде: без выбора — какие
  // маршруты показаны, с выбором — по каким интересам маршрутов не нашли.
  // Что делать — только в плашке «пусто»: здесь точки на карте есть.
  const searchLine = search.byDefault
    ? (search.shown.length > 0 ? byDefaultText(search.shown) : null)
    : (search.empty.length > 0 ? emptyKindsText(search.empty) : null);
  const hint = fixedDay !== null
    ? MAP_TEXT.hintAddOnly
    : hasPlan
      ? (canReplace ? MAP_TEXT.hintPlan : MAP_TEXT.hintAddOnly)
      : search.byDefault ? MAP_TEXT.hintTap : MAP_TEXT.hintNoPlan;
  const truncatedLine = search.truncated && search.truncated.length > 0 ? truncatedText(search.truncated) : null;
  // Отказ при открытом дне — в плашке дня, одной плашкой (шестой круг).
  const failedInDay = editing !== null && status === 'failed';

  return (
    <>
    <div
      ref={panelRef}
      data-theme="dark"
      className="absolute top-3 left-3 right-14 lg:right-auto lg:max-w-sm z-10 flex flex-col gap-2 pointer-events-none"
    >
      {editing && (
        <div
          className={`${GLASS} pointer-events-auto flex items-start gap-3`}
          // Отказ в плашке дня узнаётся кромкой предупреждения, как плашка отказа.
          style={failedInDay ? WARN_EDGE : { border: `1px solid color-mix(in srgb, ${planDayHex()} 80%, transparent)` }}
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
            {/* Карточка точки открыта (телефон) — точка уже нажата, «Заменить
                день N» — в карточке: колонка короче, карточка под ней. */}
            {replaceable && status === 'ok' && !squeezed && (
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
            {/* Отказ при открытом дне — здесь же, одной плашкой: отказ, что
                это значит для дня, и «Повторить». Отдельная плашка отказа под
                этой ложилась на телефоне на северный пин дня. */}
            {failedInDay && (
              <div role="alert" className="mt-0.5 flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0 text-[var(--warning)]" aria-hidden />
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] leading-snug text-[var(--glass-fg)]">
                    {replaceable ? editFailedText(editing.number) : MAP_TEXT.failed}
                  </p>
                  <RetryButton onRetry={onRetry} />
                </div>
              </div>
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

      {status === 'failed' && !failedInDay && (
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

      {/* Часть интересов не ответила — отдельно от легенды и НАД ней:
          свёрнутая легенда, замена дня и карточка точки на телефоне это
          предупреждение не прячут. Кнопка — в строку с текстом: плашка
          низкая, и на 375×667 при замене дня она целиком над карточкой. */}
      {status === 'ok' && partial && (
        <div role="status" className={`${GLASS} pointer-events-auto flex items-center gap-2`} style={WARN_EDGE}>
          <AlertTriangle className="w-4 h-4 shrink-0 text-[var(--warning)]" aria-hidden />
          <p className="flex-1 min-w-0 text-xs leading-snug">{partialText(search.failed ?? [])}</p>
          <RetryButton onRetry={onRetry} inline />
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
          {open && showLegend && truncatedLine && (
            <p className="mt-1.5 text-[11px] leading-snug text-[var(--glass-fg)]">{truncatedLine}</p>
          )}
        </div>
      )}

    </div>
    {open && showLegend && (
      <p data-theme="dark" className={`${GLASS} absolute bottom-3 left-3 right-14 z-10 text-sm leading-snug text-[var(--glass-fg-muted)] pointer-events-none`}>
        {hint}
      </p>
    )}
    </>
  );
}
