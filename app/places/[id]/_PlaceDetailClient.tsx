'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Navigation, Download, Video, ChevronDown } from 'lucide-react';
import type { PlaceData } from '@/components/places/types';
import { DIFFICULTY_LABELS } from '@/components/places/types';
import { OWN_ROUTE_ANCHOR } from '@/components/places/PlaceOwnRoute';
import { HazardBadgeStrip } from '@/components/shared/HazardBadgeStrip';
import { hasVolcanoCamera, VOLCANO_CAMERAS_URL, VOLCANO_CAMERAS_SOURCE } from '@/lib/safety/volcano-cameras';
import { buildPlaceAdvisory } from '@/lib/kuzmich/place-advisory';

const PlaceHero             = dynamic(() => import('@/components/places/PlaceHero'),             { ssr: false });
const OfflineGPSBanner      = dynamic(() => import('@/components/shared/OfflineGPSBanner'),      { ssr: false });
const PlaceRealtimeStatus   = dynamic(() => import('@/components/places/PlaceRealtimeStatus'),   { ssr: false });
const VolcanoAccBadge       = dynamic(() => import('@/components/places/VolcanoAccBadge'),       { ssr: false });
const PlaceDescription      = dynamic(() => import('@/components/places/PlaceDescription'),      { ssr: false });
const PlaceFacts            = dynamic(() => import('@/components/places/PlaceFacts'),            { ssr: false });
const PlaceSafety           = dynamic(() => import('@/components/places/PlaceSafety'),           { ssr: false });
const PlaceAccess           = dynamic(() => import('@/components/places/PlaceAccess'),           { ssr: false });
const PlaceSeason           = dynamic(() => import('@/components/places/PlaceSeason'),           { ssr: false });
const PlaceRoutes           = dynamic(() => import('@/components/places/PlaceRoutes'),           { ssr: false });
const PlaceTours            = dynamic(() => import('@/components/places/PlaceTours'),            { ssr: false });
const PlaceKuzmich          = dynamic(() => import('@/components/places/PlaceKuzmich'),          { ssr: false });
const PlaceReviews          = dynamic(() => import('@/components/places/PlaceReviews'),          { ssr: false });
const PlaceNearby           = dynamic(() => import('@/components/places/PlaceNearby'),           { ssr: false });
const PlaceEco              = dynamic(() => import('@/components/places/PlaceEco'),              { ssr: false });
const PlaceLNT              = dynamic(() => import('@/components/places/PlaceLNT'),              { ssr: false });
const PlaceIndigenous       = dynamic(() => import('@/components/places/PlaceIndigenous'),       { ssr: false });
const PlaceFooter           = dynamic(() => import('@/components/places/PlaceFooter'),           { ssr: false });
const PlaceFieldReports     = dynamic(() => import('@/components/places/PlaceFieldReports'),     { ssr: false });
const PhotoUpload           = dynamic(() => import('@/components/places/PhotoUpload').then(m => ({ default: m.PhotoUpload })), { ssr: false });
const PlaceUserPhotos       = dynamic(() => import('@/components/places/PlaceUserPhotos'),       { ssr: false });
const PlaceActionBar        = dynamic(() => import('@/components/places/PlaceActionBar').then(m => ({ default: m.PlaceActionBar })), { ssr: false });
const PlaceOwnRoute         = dynamic(() => import('@/components/places/PlaceOwnRoute').then(m => ({ default: m.PlaceOwnRoute })), { ssr: false });
const Header                = dynamic(() => import('@/components/layout/Header').then(m => ({ default: m.Header })), { ssr: false });

function Skeleton() {
  return (
    <div className="animate-pulse">
      <div className="w-full bg-[var(--bg-hover)]" style={{ height: 'clamp(320px, 62vh, 560px)' }} />
      <div className="mx-auto w-full max-w-3xl px-4 lg:max-w-6xl lg:px-6 pt-8 space-y-4">
        <div className="h-5 bg-[var(--bg-hover)] rounded-full w-20" />
        <div className="h-9 bg-[var(--bg-hover)] rounded-lg w-3/4" />
        <div className="h-4 bg-[var(--bg-hover)] rounded w-full" />
        <div className="h-4 bg-[var(--bg-hover)] rounded w-5/6" />
        <div className="h-4 bg-[var(--bg-hover)] rounded w-4/6" />
        <div className="flex gap-2 mt-6">
          {[1,2,3,4].map(i => <div key={i} className="h-9 bg-[var(--bg-hover)] rounded-xl w-28" />)}
        </div>
      </div>
    </div>
  );
}

/**
 * SOS живёт ТОЛЬКО в `PlaceSOS` (page.tsx) — не здесь. До 24.08 у этого бара
 * был свой `<a href="tel:112">СОС</a>` (кириллица — мимо латинского regex
 * сторожа sos-always-reachable.test.ts), и он рисовался ОДНОВРЕМЕННО с
 * `PlaceSOS`: два fixed bottom-0 бара поверх друг друга, верхний по z-index
 * прятал «Навигация»/«Оффлайн». Раз SOS всегда есть снизу, здесь остаётся
 * только то, что PlaceSOS не делает — offset подобран под высоту PlaceSOS без
 * safe-area (см. её собственный комментарий), чтобы бары не перекрывались.
 *
 * «Навигация» отсюда убрана 07.09 (владелец, скрин: «почему 2 кнопки
 * навигация?») — `PlaceActionBar` уже держит sticky «Навигация», и она видна
 * на мобильном НАРАВНЕ с этим баром: до правки человек видел два одинаковых
 * CTA на одном экране.
 *
 * Разделение труда с тех пор не изменилось, а вот содержание изменилось
 * дважды: 13.09 «Навигация» в шапке стала звать свой расчёт вместо geo:, а
 * отсюда ушёл om:// Organic Maps. Шапка даёт ДЕЙСТВИЕ, этот бар — ФАЙЛ.
 */
function MobileBottomBar({ place }: { place: PlaceData }) {
  // «Оффлайн — Organic Maps» (om://) снят 13.09 вместе с остальными чужими
  // навигаторами. Слово «оффлайн» тут было к тому же чужой заслугой: офлайн
  // у нас свой — пакеты карты районов и GPX/PDF места, и обещать его через
  // приложение, которого у человека может не стоять, значит обещать чужим.
  //
  // Взамен — наш офлайн-файл трека: GPX кладётся в любой прибор и не зависит
  // ни от какой установленной программы.
  return (
    <div
      className="fixed left-0 right-0 z-50 md:hidden"
      style={{ bottom: 'calc(env(safe-area-inset-bottom) + 52px)' }}
    >
      <div className="flex items-center gap-2 px-3 py-3 bg-[var(--bg-card)] border-t border-[var(--border)]">
        <a
          href={`/api/places/${place.id}/gpx`}
          download
          className="flex-1 flex items-center justify-center gap-2 text-sm font-medium text-[var(--text-primary)] bg-[var(--bg-hover)] border border-[var(--border)] rounded-xl py-3 hover:border-[var(--accent)] transition-colors"
        >
          <Download className="w-4 h-4" />
          Скачать точку (GPX)
        </a>
      </div>
    </div>
  );
}

/**
 * Раздел карточки: надзаголовок и тонкая линейка.
 *
 * Заведён 14.09. До этого карточка была стопкой из двадцати с лишним секций
 * подряд — опасности, описание, эко-правила, отзывы и форма загрузки фото
 * шли одинаковыми карточками с одинаковой рамкой, в том порядке, в котором
 * их когда-то дописывали. Владелец: «это не UX».
 *
 * Заголовок объявляется ТОЛЬКО под содержимое: условия `hasNow`/`hasAbout`/
 * `hasKnow`/`hasNext` считаются на данных выше. Заголовок над пустотой — то
 * же обещание без источника (правило 10.09), только на экране.
 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="pt-10 first:pt-6">
      {/*
        Заголовок раздела ВИДЕН.

        Первая редакция (14.09, тем же днём) делала его деликатным: одиннадцать
        пикселей, разрядка, самый тусклый токен `--text-muted`. На тёмном фоне
        он попросту исчез — страница осталась ровным серым полем без единой
        точки опоры, и владелец назвал это одним словом: «муть».

        Голос края — Playfair, крупно (§2 языка Ведара). Рядом короткая черта
        цветом лавы: единственное место, где акцент работает как метка
        структуры, а не как призыв к действию.
      */}
      <h2
        className="mb-5 text-2xl font-bold text-[var(--text-primary)]"
        style={{ fontFamily: 'var(--font-playfair)' }}
      >
        {title}
        <span className="mt-2 block h-[3px] w-10 rounded-full bg-[var(--accent)]" aria-hidden />
      </h2>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

/**
 * Плита раздела — содержимое на своей подложке.
 *
 * Убрать рамки было правильно, но само по себе дало ровное поле: текст,
 * таблица и кнопки лежали на одном фоне без планов. Плита возвращает
 * ПЛАН, не возвращая коробочности: подложка `--bg-card`, щедрые поля,
 * НЕТ рамки и нет вложенных плит — карточка в карточке запрещена
 * (vedar-design §3).
 */
function Plate({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-[var(--bg-card)] p-5 sm:p-6">{children}</div>
  );
}

const LS_PREFIX = 'kh_place_';

function lsRead(id: string): PlaceData | null {
  try {
    const raw = localStorage.getItem(LS_PREFIX + id);
    return raw ? (JSON.parse(raw) as PlaceData) : null;
  } catch { return null; }
}

function lsWrite(id: string, data: PlaceData) {
  try {
    localStorage.setItem(LS_PREFIX + id, JSON.stringify(data));
  } catch { /* localStorage full */ }
}

export default function PlaceDetailClient({ id }: { id: string }) {
  // `?route=1` — человек уже нажал «Навигация» на листе места (карта) и
  // приехал сюда за путём. Читается из location, а не через useSearchParams:
  // хук заставил бы обернуть страницу в Suspense ради одного булева флага.
  const autoRoute = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('route') === '1';
  const [place, setPlace] = useState<PlaceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Показываем кэш сразу — пока грузится сеть
      const cached = lsRead(id);
      if (cached && !cancelled) {
        setPlace(cached);
        setLoading(false);
        setFromCache(true);
      }

      try {
        const res = await fetch(`/api/places/${id}`);
        if (!res.ok) {
          // HTTP error — show server message, not "offline"
          const errBody = await res.json().catch(() => null) as Record<string, unknown> | null;
          if (!cancelled && !cached) {
            setError((errBody?.error as string | null) ?? `Ошибка сервера (${res.status})`);
            setLoading(false);
          } else if (!cancelled) {
            setLoading(false);
          }
          return;
        }
        const j = await res.json();
        if (!cancelled) {
          if (j?.success && j.data) {
            setPlace(j.data);
            setFromCache(false);
            lsWrite(id, j.data);
          } else if (!cached) {
            setError(j.error ?? 'Место не найдено');
          }
          setLoading(false);
        }
      } catch {
        // Network error (offline / host unreachable)
        if (!cancelled) {
          if (!cached) setError('Нет подключения. Откройте карточку онлайн заранее.');
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  if (loading) return <><Header /><Skeleton /></>;

  if (error || !place) {
    return (
      <>
        <Header />
        <div className="max-w-3xl mx-auto px-4 py-24 text-center">
          <p className="text-[var(--text-secondary)] mb-4">{error ?? 'Место не найдено'}</p>
          <Link href="/routes?kind=place" className="ds-btn ds-btn-secondary">← Все места</Link>
        </div>
      </>
    );
  }

  const hasSeason = place.safety.openFromDate || place.safety.openToDate || place.bestSeason || place.seasonalNotes;

  // Факты первого экрана — то, что человек спрашивает раньше всего: далеко ли
  // до помощи, тяжело ли идти, высоко ли. Собираются ЗДЕСЬ, а не в герое:
  // «не знаем» выражается отсутствием строки, а не прочерком (§4.0), и
  // решать, что известно, должна карточка, у которой данные на руках.
  const heroFacts: Array<{ label: string; value: string }> = [];
  if (place.safety.altitudeM != null) {
    heroFacts.push({ label: 'высота', value: `${place.safety.altitudeM.toLocaleString('ru-RU')} м` });
  }
  if (place.safety.difficultyLevel != null) {
    heroFacts.push({
      label: 'сложность',
      value: DIFFICULTY_LABELS[place.safety.difficultyLevel] ?? String(place.safety.difficultyLevel),
    });
  }
  if (place.safety.nearestMedicalKm != null) {
    heroFacts.push({ label: 'до медпомощи', value: `${place.safety.nearestMedicalKm} км` });
  }

  // Что в карточке ЕСТЬ. Раздел с заголовком объявляется только под
  // содержимое: заголовок над пустотой — то же обещание без источника
  // (правило 10.09), только на экране.
  const hasNow = Boolean(place.realtime)
    || place.safety.hazardTypes.length > 0
    || place.safety.registrationRequired
    || Boolean(place.volcanoStatus)
    || (place.locationType === 'volcano' && hasVolcanoCamera(place.name));
  const hasAbout = Boolean(place.essence || place.description)
    || Boolean(place.indigenous)
    || place.safety.hazardTypes.length > 0
    || place.safety.altitudeM != null
    || place.safety.difficultyLevel != null
    || Boolean(place.zone);
  const hasKnow = Boolean(place.eco) || hasSeason
    || place.safety.hazardTypes.length > 0
    || place.safety.nearestMedicalKm != null
    || place.safety.capacityPerDay != null;
  const hasNext = place.routes.length > 0 || place.tours.length > 0 || place.nearby.length > 0;

  return (
    <>
      <Header />
      <OfflineGPSBanner />

      {/* 1. Hero — full-width photo with name overlay */}
      <PlaceHero
        placeId={place.id}
        name={place.name}
        locationType={place.locationType}
        lat={place.lat}
        lng={place.lng}
        photoUrl={place.photoUrl}
        photoCount={place.photoCount}
        images={place.images as string[]}
        facts={heroFacts}
      />

      {/* Атрибуция фото. Автор и лицензия — что записано, без умолчаний.
          До 14.09 здесь стояло `author || 'Wikimedia Commons'`: у снимка без
          автора карточка ПРИПИСЫВАЛА его Wikimedia Commons. Для вики-фото это
          выглядело безобидно, но подпись — утверждение о правах, и под фото,
          взятым у правообладателя (ИВиС ДВО РАН / КВЕРТ), она стала бы ложью
          вдвойне: чужое имя и намёк на свободную лицензию, которой нет.
          Не знаем автора — не называем его (§4.0). */}
      {place.photoAttribution && (place.photoAttribution.author || place.photoAttribution.license) && (
        <div className="mx-auto w-full max-w-3xl px-4 lg:max-w-6xl lg:px-6 pt-1.5 text-right text-[11px] text-[var(--text-muted)]">
          Фото:{' '}
          {place.photoAttribution.author && (
            place.photoAttribution.sourceUrl ? (
              <a href={place.photoAttribution.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="underline hover:text-[var(--ocean)]">
                {place.photoAttribution.author}
              </a>
            ) : (
              <span>{place.photoAttribution.author}</span>
            )
          )}
          {place.photoAttribution.license && (
            <>
              {place.photoAttribution.author ? ' · ' : ''}
              {place.photoAttribution.licenseUrl ? (
                <a href={place.photoAttribution.licenseUrl} target="_blank" rel="noopener noreferrer nofollow" className="underline hover:text-[var(--ocean)]">
                  {place.photoAttribution.license}
                </a>
              ) : (
                <span>{place.photoAttribution.license}</span>
              )}
            </>
          )}
          {/* Источник без автора и лицензии подписью не является, но ссылка
              на него полезна — она есть в блоке выше, когда автор известен. */}
        </div>
      )}

      {/* Action bar: navigate, bookmark, share, weather.
          Полноширинный липкий бар — намеренно вне сетки ниже: он относится ко
          всей странице, а не к колонке текста. */}
      <PlaceActionBar lat={place.lat} lng={place.lng} placeId={place.id} name={place.name} />

      {/* Offline cache notice */}
      {fromCache && (
        <div className="w-full px-4 py-2 bg-[var(--bg-hover)] border-b border-[var(--border)] flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--warning)] flex-shrink-0" />
          Данные из кэша — нет подключения к сети
        </div>
      )}

      {/*
        РАСКЛАДКА КАРТОЧКИ — ОДНА, И ОНА ЗДЕСЬ (14.09).

        До этого дня ширину и поля решал КАЖДЫЙ блок сам: `max-w-3xl mx-auto
        px-4` стояло в девятнадцати компонентах, а родитель половину из них
        оборачивал в такой же контейнер ещё раз. Отсюда разъезд, который на
        широком экране видно сразу: у одних блоков отступ 16 пикселей, у
        других 32, а `PlaceCharacteristics` и `PlaceNearby` контейнера не имели
        вовсе и растягивались во всю ширину монитора, пока соседи стояли
        колонкой посередине. Правило, написанное двадцать раз, — это двадцать
        правил, и они уже разошлись (тот же урок, что со стандартом линии §12).

        Второе: на мониторе 1440+ вся карточка была лентой в 768 пикселей с
        пустыми полями по бокам. Поэтому на широком экране появляется вторая
        колонка — «как добраться»: она прилипает и едет вместе с чтением,
        вместо того чтобы уезжать вверх и теряться.

        Порядок DOM — сначала столбец «как добраться», потом основной текст —
        выбран НЕ случайно: на телефоне сетки нет, и блоки идут подряд, то
        есть свой путь остаётся сразу под шапкой (решение владельца 07.09).
        На широком экране `lg:col-start-2 lg:row-start-1` переносит его
        вправо, не трогая порядок на телефоне и не создавая второй копии
        компонента — две копии одного действия уже расходились поведением (#887).
      */}
      <div className="mx-auto w-full max-w-3xl px-4 lg:max-w-6xl lg:px-6 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-10 lg:items-start">

        {/* Как добраться — правый столбец на широком экране */}
        <aside className="lg:col-start-2 lg:row-start-1 lg:sticky lg:top-[120px] pt-3 space-y-3">
          {/* Свой рассчитанный автопуть (владелец 07.09: «добавить свой трек на
              место»): до той правки НИ ОДНА ссылка навигации на карточке не
              вела на платформу, обе уходили во внешние навигаторы.

              13.09 чужие ссылки отсюда УБРАНЫ совсем (владелец: «кнопка
              навигация до сих пор открывает сторонние сервисы»): 07.09 свой
              путь только ДОБАВИЛИ, оставив рядом geo: в шапке и om:// в нижнем
              баре — от этого на одной карточке жили три навигации, две чужие. */}
          <div id={OWN_ROUTE_ANCHOR} style={{ scrollMarginTop: 112 }}>
            <PlaceOwnRoute lat={place.lat} lng={place.lng} name={place.name} autoStart={autoRoute} hideIdleTrigger />
          </div>

          {/* Дорога считается выше своим графом, здесь начинается то, чего у
              дорожного пути нет вовсе — тропа. Ищет путь ТЕМ ЖЕ полем поиска,
              что заполнил бы человек сам — предзаполнен именем места через ?q=.
              auto=1 (владелец 30.08: «сразу на маршруте от места, где находится
              пользователь») доводит цель и старт (живой GPS) до автовыбора.

              14.09 переехало сюда снизу: пеший путь и автопуть — один вопрос
              «как я сюда попаду», и разносить их через всю страницу незачем. */}
          {/* На телефоне — скромная ссылка, на широком экране — карточка в
              столбце. Иначе первый экран телефона занимали ЧЕТЫРЕ кнопки
              навигации подряд («Навигация», автопуть, пеший путь, GPX) и ни
              одного слова о самом месте. Элемент один и тот же — вторая копия
              ради второго вида расходится поведением (#887). */}
          <Link
            href={`/planning?mode=trail&q=${encodeURIComponent(place.name)}&auto=1`}
            className="flex items-center gap-2 py-1 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--accent)] lg:rounded-lg lg:border lg:border-[var(--border)] lg:bg-[var(--bg-card)] lg:px-4 lg:py-2.5 lg:text-[var(--text-primary)] lg:hover:border-[var(--accent)]"
          >
            <Navigation className="h-4 w-4 text-[var(--accent)]" aria-hidden />
            Пройти сюда с компасом и GPS
          </Link>
        </aside>

        {/* Основной столбец */}
        <div className="lg:col-start-1 lg:row-start-1 min-w-0">

          {/* СЕЙЧАС — всё, что меняется день ото дня и решает, ехать ли
              сегодня. Стоит первым и без него раздела нет вовсе. */}
          {hasNow && (
            <Section title="Сейчас">
              {place.realtime && <PlaceRealtimeStatus realtime={place.realtime} />}

              {(place.safety.hazardTypes.length > 0 || place.safety.registrationRequired) && (
                <HazardBadgeStrip
                  hazards={place.safety.hazardTypes}
                  mchsRequired={place.safety.registrationRequired}
                />
              )}

              {/* Авиационный цветовой код вулкана (KVERT) */}
              {place.volcanoStatus && <VolcanoAccBadge status={place.volcanoStatus} />}

              {/* Живая камера вулкана — только для вулканов под видеонаблюдением
                  КФ ФИЦ ЕГС РАН (lib/safety/volcano-cameras). Внешний онлайн-
                  ресурс: обычная ссылка, не iframe, с честной пометкой про сеть. */}
              {place.locationType === 'volcano' && hasVolcanoCamera(place.name) && (
                <a
                  href={VOLCANO_CAMERAS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-4 py-3 hover:bg-[var(--bg-hover)] transition-colors"
                >
                  <Video className="w-5 h-5 text-[var(--ocean)] shrink-0" strokeWidth={1.8} />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-[var(--text-primary)]">Камеры вулкана вживую</span>
                    <span className="block text-xs text-[var(--text-secondary)]">{VOLCANO_CAMERAS_SOURCE} · внешний источник, нужна сеть</span>
                  </span>
                </a>
              )}
            </Section>
          )}

          {/* О МЕСТЕ — что это такое: текст, коренной контекст, показатели. */}
          {hasAbout && (
            <Section title="О месте">
              <PlaceDescription
                name={place.name}
                essence={place.essence}
                description={place.description}
                descriptionSource={place.descriptionSource}
                placeId={place.id}
              />

              {place.indigenous && <PlaceIndigenous indigenous={place.indigenous} />}

              <Plate>
                <PlaceFacts
                  locationType={place.locationType}
                  zone={place.zone}
                  safety={place.safety}
                  terrainType={place.safety.terrainType}
                />
              </Plate>
            </Section>
          )}

          {/* ЧТО ЗНАТЬ — безопасность как свойство места (§9, блок 6), сезон,
              эко-режим и след. Это подготовка, а не сводка «сейчас». */}
          {hasKnow && (
            <Section title="Что знать">
              <Plate>
                <PlaceSafety safety={place.safety} placeId={place.id} />
              </Plate>

              {hasSeason && (
                <PlaceSeason
                  openFromDate={place.safety.openFromDate}
                  openToDate={place.safety.openToDate}
                  bestSeason={place.bestSeason}
                  seasonalNotes={place.seasonalNotes}
                />
              )}

              {place.eco && <PlaceEco eco={place.eco} placeName={place.name} />}

              <PlaceLNT
                capacityPerDay={place.safety.capacityPerDay}
                ecoZone={place.eco?.zone ?? null}
              />
            </Section>
          )}

          {/* КАК ДОБРАТЬСЯ — карта и подъезд. Расчёт дороги и пеший путь
              стоят выше, в правом столбце: до 14.09 они были разнесены по
              разным концам страницы, хотя отвечают на один вопрос.
              Чужих навигаторов здесь нет с 13.09 (решение владельца). */}
          <Section title="Как добраться">
            <PlaceAccess
              placeId={place.id}
              name={place.name}
              lat={place.lat}
              lng={place.lng}
              accessInfo={place.accessInfo}
              nearbyMarkers={place.nearby}
            />
          </Section>

          {/* ДАЛЬШЕ — куда идти с этой страницы. Коммерция остаётся на
              странице тура, здесь только переходы (§9, блок 11). */}
          {hasNext && (
            <Section title="Дальше">
              {place.routes.length > 0 && <PlaceRoutes routes={place.routes} placeId={place.id} />}
              {place.tours.length > 0 && <PlaceTours tours={place.tours} />}
              {place.nearby.length > 0 && <PlaceNearby nearby={place.nearby} placeId={place.id} />}
            </Section>
          )}

          {/* КУЗЬМИЧ — без обёртки раздела: у блока есть собственный
              заголовок «Кузьмич о месте», и второй над ним был бы тем же
              дублем, что «Как добраться» над «Как добраться». */}
          <div className="pt-10">
            <PlaceKuzmich
              placeId={place.id}
              placeName={place.name}
              kuzmichReview={place.kuzmichReview}
              advisory={buildPlaceAdvisory({
                volcano: place.volcanoStatus
                  ? { colorCode: place.volcanoStatus.colorCode, observedAt: place.volcanoStatus.observedAt }
                  : null,
                realtime: place.realtime
                  ? { isOpen: place.realtime.isOpen, activeAlerts: place.realtime.activeAlerts, alertSeverity: place.realtime.alertSeverity }
                  : null,
                hazardTypes: place.safety.hazardTypes,
              })}
            />
          </div>

          {/*
            ОТ ЛЮДЕЙ — под раскрытием.

            Три из этих четырёх блоков рисуются ВСЕГДА, даже когда показывать
            нечего: «Отзывов пока нет», пустая лента фото и форма загрузки. На
            карточке с одним абзацем описания они занимали больше места, чем
            всё содержание вместе, и именно они делали страницу на 3270
            пикселей прокрутки.

            Раскрытие — нативное <details>: без JS, работает офлайн и не
            ломается при отказе гидрации. Ничего не спрятано насовсем —
            перенесено на один тап, который человек делает, когда ему это
            нужно, а не всем подряд.
          */}
          <details className="group mt-8 rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-[var(--text-primary)]">
              Отзывы, фото и наблюдения туристов
              <ChevronDown className="h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform group-open:rotate-180" aria-hidden />
            </summary>
            <div className="space-y-6 border-t border-[var(--border)] px-4 py-5">
              <PlaceReviews placeId={place.id} reviews={place.reviews} />

              {/* Одобренные фото ПЕРЕД формой загрузки: человек сначала видит,
                  куда попадёт его снимок, и только потом загружает. */}
              <PlaceUserPhotos placeId={place.id} />
              <PhotoUpload placeId={place.id} placeName={place.name} />

              <PlaceFieldReports placeId={place.id} />
            </div>
          </details>

          {/* Footer */}
          <div className="pt-4 mb-24 md:mb-12">
            <PlaceFooter
              sourceUrl={place.sourceUrl}
              sourceName={place.sourceName}
              updatedAt={place.updatedAt}
            />
          </div>

        </div>{/* /основной столбец */}
      </div>{/* /сетка карточки */}

      {/* Mobile sticky bottom bar */}
      <MobileBottomBar place={place} />
    </>
  );
}
