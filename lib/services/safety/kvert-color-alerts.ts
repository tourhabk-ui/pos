/**
 * Смена авиационного кода KVERT → событие для external_alerts.
 *
 * Синк пишет коды в volcano_status, но разведка (Scout Digest) читает
 * раздел «Камчатка» только из external_alerts за последние 25 часов.
 * Пока смена цвета туда не попадала, дайджест не видел VONA, даже если
 * kvert-acc отработал зелёно. Событие строится здесь, без сети и без БД:
 * запись — дело вызывающего (saveEvent), чтобы правило «когда писать»
 * проверялось без базы.
 *
 * Пишем только ИЗМЕНЕНИЕ: повтор того же кода — не событие. Первый
 * увиденный зелёный код тоже не пишем (это фон, не новость). Первый
 * жёлтый/оранжевый/красный — пишем: для разведки это появление угрозы.
 * Код unassigned событием не бывает.
 */
import { ACC_META, type AccColor } from '@/lib/services/safety/kvert-vona';
import { volcanoesNamedIn, type SeismicEvent } from '@/lib/services/safety/seismic-parser';

const COLOR: ReadonlySet<string> = new Set(['green', 'yellow', 'orange', 'red', 'unassigned']);

export function isAccColor(value: string | null | undefined): value is AccColor {
  return !!value && COLOR.has(value);
}

/**
 * Нужно ли событие при переходе prev → next.
 * prev = null: вулкана ещё не было в volcano_status.
 */
export function aviationColorChanged(prev: AccColor | null, next: AccColor): boolean {
  if (next === 'unassigned') return false;
  if (prev === next) return false;
  if (prev === null && next === 'green') return false;
  return true;
}

/**
 * Зоны края для вулкана — из той же карты «вулкан → зона», по которой
 * размечаются сводки КБГС и МЧС (`volcanoesNamedIn`).
 *
 * До 23.11 событие писалось с пустыми зонами. Следствий было два, и оба
 * неверны: зона самого вулкана тревогу не получала (оценка зон и обстановка
 * по выезду отбирают по зоне), а проверка дат считала её «предупреждением с
 * неустановленным местом» и ставила «не проверено» каждому туру края на
 * пять суток — из-за кода у вулкана в четырёхстах километрах.
 *
 * Вулкан, которого в карте нет, остаётся без зоны: выдумывать её нельзя.
 * Такое событие названо в итоге синка (`alerts_unzoned`).
 */
export function kvertVolcanoZones(volcanoName: string): string[] {
  const zones = new Set<string>();
  for (const v of volcanoesNamedIn(volcanoName)) for (const z of v.zones) zones.add(z);
  return [...zones];
}

/** Общее начало `external_id` у событий одного вулкана. */
export function kvertAlertIdPrefix(slug: string): string {
  return `kvert-acc/${slug}/`;
}

const SEVERITY: Record<Exclude<AccColor, 'unassigned'>, 0 | 1 | 2 | 3> = {
  green: 0,
  yellow: 1,
  orange: 2,
  red: 3,
};

export function buildKvertColorAlert(opts: {
  slug: string;
  volcanoName: string;
  prev: AccColor | null;
  next: AccColor;
  sourceUrl: string | null;
  observedAt: Date | null;
  summary: string | null;
  ashHeightM: number | null;
}): SeismicEvent | null {
  if (!aviationColorChanged(opts.prev, opts.next)) return null;
  if (opts.next === 'unassigned') return null;

  const nextMeta = ACC_META[opts.next];
  const prevLabel = opts.prev && opts.prev !== 'unassigned' ? ACC_META[opts.prev].short : null;
  const title = prevLabel
    ? `KVERT: ${opts.volcanoName} — авиационный код ${nextMeta.short.toLowerCase()} (было: ${prevLabel.toLowerCase()})`
    : `KVERT: ${opts.volcanoName} — авиационный код ${nextMeta.short.toLowerCase()}`;

  const lines: string[] = [
    `${opts.volcanoName}: авиационный цветовой код ${nextMeta.short} (${nextMeta.label}).`,
  ];
  if (prevLabel) lines.push(`Предыдущий код: ${prevLabel}.`);
  if (opts.ashHeightM != null) lines.push(`Высота пепла: ${opts.ashHeightM} м.`);
  if (opts.summary) lines.push(opts.summary);

  const publishedAt = opts.observedAt ?? new Date();
  const day = publishedAt.toISOString().slice(0, 10);
  const elevated = opts.next === 'orange' || opts.next === 'red';

  return {
    source_id: `${kvertAlertIdPrefix(opts.slug)}${opts.next}/${day}`,
    source_url: opts.sourceUrl || 'http://kvert.febras.net/van/index.php?type=3&lend=en',
    published_at: publishedAt,
    alert_type: elevated ? 'ash_cloud' : 'info',
    severity: SEVERITY[opts.next],
    title,
    description: lines.join(' '),
    affected_zones: kvertVolcanoZones(opts.volcanoName),
    volcano_name: opts.volcanoName,
    volcano_scope: 'named',
    ash_height_m: opts.ashHeightM ?? undefined,
    expires_hours: elevated ? 120 : 72,
  };
}
