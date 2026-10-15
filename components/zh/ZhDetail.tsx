/**
 * Китайские конспекты тура и места (аудит 15.10, CN-pages; Китай, шаг 7,
 * вариант «в» — малый объём с честной пометкой машинного перевода).
 *
 * Конспект — НЕ вторая карточка тура (CLAUDE.md §11): брони, формы заявки,
 * цены «от» сверх поля базы и своей SOS-кнопки здесь нет. Единственная
 * карточка с бронью — русская /catalog/tours/[slug], и конспект ведёт на неё
 * ссылкой «唯一的预订页面». SOS — одна кнопка платформы в шапке (§2, #887).
 *
 * Что откуда:
 *   - тексты оператора (название, описание, программа, состав, что взять) —
 *     машинный перевод из content_translations, только сделанный с нынешнего
 *     текста; иначе русский оригинал с пометкой «暂无中文翻译» или «原文已更新»
 *     — без придуманной транслитерации;
 *   - цена, длительность, группа, сезон, оператор — из полей базы при показе
 *     (lib/zh/entry), модель их не видит;
 *   - безопасность — по-русски из базы с пометкой «安全信息仅提供俄语原文»:
 *     китайского словаря опасностей у платформы нет, а машинный перевод
 *     правил безопасности — то место, где ошибка стоит дороже всего;
 *   - китайское имя места — только из источника (OSM name:zh в place_aliases),
 *     иначе русское имя с пометкой «（俄文名）».
 *
 * Серверные компоненты без хуков: данные приходят готовыми, и сторож судит
 * их рендером (tests/unit/zh-pages.test.tsx).
 */
import Link from 'next/link';
import { OperatorNameLink } from '@/components/operators/OperatorNameLink';
import { tourPath } from '@/lib/tours/tour-url';
import { hazardLabel } from '@/lib/safety/hazard-labels';
import { asProfileSource, mayStateAsFact } from '@/lib/safety/profile-source';
import { ZH_PAGE } from '@/lib/mcp/zh-layer';
import { ZH_DETAIL } from '@/lib/zh/detail-text';
import { ruPlacePath } from '@/lib/zh/pages';
import { priceZh, durationZh, seasonZh, groupZh } from '@/lib/zh/entry';
import {
  ZH_PLACE_FIELDS, ZH_TOUR_FIELDS, readField,
  type ZhFieldKind, type ZhFieldValue, type ZhFieldView, type ZhProgramStep, type ZhStoredTranslation,
} from '@/lib/zh/fields';
import type { ZhPlaceName, ZhPlaceSourceRow, ZhTourSourceRow } from '@/lib/zh/content';

type Translations = ReadonlyMap<string, ZhStoredTranslation> | null;

/** Пометка поля без свежего перевода. */
function fieldNote(state: 'stale' | 'missing' | 'unknown'): string {
  return state === 'stale' ? ZH_DETAIL.stale : state === 'unknown' ? ZH_DETAIL.unknown : ZH_DETAIL.missing;
}

function FieldValue({ kind, value }: { kind: ZhFieldKind; value: ZhFieldValue }) {
  if (kind === 'text') return <p className="whitespace-pre-line">{value as string}</p>;
  if (kind === 'list') {
    return (
      <ul className="list-disc list-inside space-y-1">
        {(value as string[]).map((item, i) => <li key={i}>{item}</li>)}
      </ul>
    );
  }
  return (
    <ol className="space-y-2">
      {(value as ZhProgramStep[]).map((s, i) => (
        <li key={i}>
          <p className="font-semibold">{s.title}</p>
          {s.text && <p className="whitespace-pre-line" style={{ color: 'var(--text-secondary)' }}>{s.text}</p>}
        </li>
      ))}
    </ol>
  );
}

/**
 * Поле конспекта: свежий перевод — по-китайски; иначе — русский оригинал под
 * lang="ru" и пометка, почему не по-китайски. Поля нет в исходнике — блока нет.
 */
export function ZhFieldBlock({ heading, kind, view, field }: { heading: string; kind: ZhFieldKind; view: ZhFieldView; field: string }) {
  if (view.state === 'none') return null;
  return (
    <section className="space-y-2" data-zh-field={field} data-zh-state={view.state}>
      <h2 className="ds-h2">{heading}</h2>
      <div className="ds-card p-4 text-sm space-y-2" style={{ color: 'var(--text-primary)' }}>
        {view.state === 'fresh' ? (
          <FieldValue kind={kind} value={view.zh} />
        ) : (
          <>
            <p className="text-xs" style={{ color: 'var(--warning)' }} data-zh-note={view.state}>{fieldNote(view.state)}</p>
            <div lang="ru"><FieldValue kind={kind} value={view.source} /></div>
          </>
        )}
      </div>
    </section>
  );
}

/** Самая поздняя дата свежего перевода и вычитаны ли все свежие поля. */
function translationStamp(views: ZhFieldView[]): { date: string | null; any: boolean; allReviewed: boolean } {
  let max: number | null = null;
  let any = false;
  let allReviewed = true;
  for (const v of views) {
    if (v.state !== 'fresh') continue;
    any = true;
    if (!v.reviewed) allReviewed = false;
    const t = v.translatedAt?.getTime();
    if (t !== undefined && !Number.isNaN(t) && (max === null || t > max)) max = t;
  }
  return { date: max === null ? null : new Date(max).toISOString().slice(0, 10), any, allReviewed: any && allReviewed };
}

/** Пометка машинного перевода и ссылка на русский оригинал. */
function MtNote({ views, href, linkText, booking }: { views: ZhFieldView[]; href: string; linkText: string; booking: boolean }) {
  const stamp = translationStamp(views);
  return (
    <div className="ds-card p-4 text-sm space-y-1" style={{ color: 'var(--text-secondary)' }} data-zh-mt-note>
      {stamp.any ? (
        <p>
          <strong style={{ color: 'var(--text-primary)' }}>{stamp.allReviewed ? ZH_DETAIL.mtReviewed : ZH_DETAIL.mtUnreviewed}</strong>
          {stamp.date && <>（{ZH_DETAIL.translatedOn}：{stamp.date}）</>}
        </p>
      ) : (
        <p>{ZH_DETAIL.noPageTranslation}</p>
      )}
      <p>{ZH_DETAIL.basis}</p>
      {booking && <p>{ZH_DETAIL.noBooking}</p>}
      <p>
        <Link className="underline" style={{ color: 'var(--ocean)' }} href={href} lang="zh-CN" data-zh-original>
          {linkText}
        </Link>
      </p>
    </div>
  );
}

function Facts({ items }: { items: Array<[string, React.ReactNode | null]> }) {
  return (
    <dl className="ds-card p-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" style={{ color: 'var(--text-primary)' }} data-zh-facts>
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt style={{ color: 'var(--text-secondary)' }}>{label}</dt>
          <dd data-zh-fact={label}>{value ?? <span style={{ color: 'var(--text-secondary)' }}>{ZH_DETAIL.notRecorded}</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Поля тура для показа — по одному правилу readField. */
export function tourViews(tour: ZhTourSourceRow, translations: Translations): Record<keyof typeof ZH_TOUR_FIELDS, ZhFieldView> {
  const out = {} as Record<keyof typeof ZH_TOUR_FIELDS, ZhFieldView>;
  for (const [field, kind] of Object.entries(ZH_TOUR_FIELDS) as Array<[keyof typeof ZH_TOUR_FIELDS, ZhFieldKind]>) {
    out[field] = readField(kind, tour[field], translations, field);
  }
  return out;
}

export function ZhTourSummary({ tour, translations }: { tour: ZhTourSourceRow; translations: Translations }) {
  const v = tourViews(tour, translations);
  const zhTitle = v.title.state === 'fresh' ? (v.title.zh as string) : null;
  const original = tourPath(tour);
  const notes = (tour.safety_notes ?? []).map((n) => String(n).trim()).filter(Boolean);
  const bodyFields = ['short_description', 'description', 'program', 'included', 'not_included', 'what_to_bring'] as const;
  const operator = (
    <span lang="ru"><OperatorNameLink name={tour.operator_name} slug={tour.operator_slug} isPublic={tour.operator_public} /></span>
  );

  return (
    <article className="max-w-3xl mx-auto px-4 py-8 space-y-6" data-zh-tour-summary={tour.id}>
      <header className="space-y-2">
        {zhTitle ? (
          <>
            <h1 className="font-playfair text-3xl sm:text-4xl font-bold" style={{ color: 'var(--text-primary)' }}>{zhTitle}</h1>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {ZH_DETAIL.originalTitle}：<span lang="ru" data-zh-original-title>{tour.title}</span>
            </p>
          </>
        ) : (
          <>
            <h1 className="font-playfair text-3xl sm:text-4xl font-bold" style={{ color: 'var(--text-primary)' }} lang="ru">{tour.title}</h1>
            <p className="text-xs" style={{ color: 'var(--warning)' }} data-zh-note={v.title.state}>
              {fieldNote(v.title.state === 'none' || v.title.state === 'fresh' ? 'missing' : v.title.state)}
            </p>
          </>
        )}
      </header>

      <MtNote views={Object.values(v)} href={original} linkText={ZH_DETAIL.originalTour} booking />

      <Facts
        items={[
          [ZH_DETAIL.facts.price, priceZh(tour)],
          [ZH_DETAIL.facts.duration, durationZh(tour)],
          [ZH_DETAIL.facts.group, groupZh(tour.max_participants)],
          [ZH_DETAIL.facts.season, seasonZh(tour.season_start, tour.season_end)],
          [ZH_DETAIL.facts.operator, operator],
        ]}
      />

      {bodyFields.map((f) => (
        <ZhFieldBlock key={f} field={f} heading={ZH_DETAIL.sections[f]} kind={ZH_TOUR_FIELDS[f]} view={v[f]} />
      ))}

      <section className="space-y-2" data-zh-safety>
        <h2 className="ds-h2">{ZH_DETAIL.safetyHeading}</h2>
        <div className="ds-card p-4 text-sm space-y-2" style={{ color: 'var(--text-primary)' }}>
          <p className="text-xs" style={{ color: 'var(--warning)' }}>{ZH_DETAIL.safetyRuOnly}</p>
          {notes.length > 0 ? (
            <ul className="list-disc list-inside space-y-1" lang="ru">
              {notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          ) : (
            <p style={{ color: 'var(--text-secondary)' }}>{ZH_DETAIL.noSafetyNotes}</p>
          )}
          <p>{ZH_DETAIL.liveSafety}</p>
          <p>{ZH_PAGE.emergency}</p>
        </div>
      </section>

      <footer className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        <Link className="underline" href="/zh">{ZH_DETAIL.backToList}</Link>
      </footer>
    </article>
  );
}

function coord(v: string | null): string | null {
  const n = Number(v);
  return v != null && Number.isFinite(n) ? n.toFixed(5) : null;
}

export function ZhPlaceSummary({ place, zhName, translations, rule }: {
  place: ZhPlaceSourceRow;
  zhName: ZhPlaceName | null;
  translations: Translations;
  /** Правило отбора мест словами (ZH_PLACES_RULE). */
  rule: string;
}) {
  const description = readField(ZH_PLACE_FIELDS.description, place.description, translations, 'description');
  const original = ruPlacePath(place);
  const hazards = mayStateAsFact(asProfileSource(place.profile_source))
    ? (place.hazard_types ?? []).map((h) => String(h).trim()).filter(Boolean)
    : [];
  const lat = coord(place.lat);
  const lng = coord(place.lng);
  const altitude = place.altitude_m != null && Number(place.altitude_m) > 0 ? `${Math.round(Number(place.altitude_m))} 米` : null;

  return (
    <article className="max-w-3xl mx-auto px-4 py-8 space-y-6" data-zh-place-summary={place.id}>
      <header className="space-y-2">
        {zhName ? (
          <>
            <h1 className="font-playfair text-3xl sm:text-4xl font-bold" style={{ color: 'var(--text-primary)' }}>{zhName.name}</h1>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {ZH_DETAIL.originalTitle}：<span lang="ru" data-zh-original-title>{place.name}</span>
              {zhName.source && <> · {ZH_DETAIL.zhNameSource}：<span data-zh-name-source>{zhName.source}</span></>}
            </p>
          </>
        ) : (
          <h1 className="font-playfair text-3xl sm:text-4xl font-bold" style={{ color: 'var(--text-primary)' }}>
            <span lang="ru">{place.name}</span>
            <span className="text-base font-normal" style={{ color: 'var(--text-secondary)' }} data-zh-ru-name>{ZH_DETAIL.ruName}</span>
          </h1>
        )}
        <p className="text-xs" style={{ color: 'var(--text-secondary)' }} data-zh-places-rule>{rule}</p>
      </header>

      <MtNote views={[description]} href={original} linkText={ZH_DETAIL.originalPlace} booking={false} />

      <Facts
        items={[
          [ZH_DETAIL.facts.coords, lat && lng ? `${lat}, ${lng}` : null],
          [ZH_DETAIL.facts.altitude, altitude],
        ]}
      />

      <ZhFieldBlock field="description" heading={ZH_DETAIL.sections.description} kind={ZH_PLACE_FIELDS.description} view={description} />

      <section className="space-y-2" data-zh-safety>
        <h2 className="ds-h2">{ZH_DETAIL.safetyHeading}</h2>
        <div className="ds-card p-4 text-sm space-y-2" style={{ color: 'var(--text-primary)' }}>
          <p className="text-xs" style={{ color: 'var(--warning)' }}>{ZH_DETAIL.safetyRuOnly}</p>
          {hazards.length > 0 ? (
            <ul className="list-disc list-inside space-y-1" lang="ru">
              {hazards.map((h) => <li key={h}>{hazardLabel(h)}</li>)}
            </ul>
          ) : (
            <p style={{ color: 'var(--text-secondary)' }}>{ZH_DETAIL.hazardsNone}</p>
          )}
          <p>{ZH_PAGE.emergency}</p>
        </div>
      </section>

      <footer className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        <Link className="underline" href="/zh">{ZH_DETAIL.backToList}</Link>
      </footer>
    </article>
  );
}
