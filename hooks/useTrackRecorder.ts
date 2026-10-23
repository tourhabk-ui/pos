'use client';

/**
 * Запись трека телефоном (владелец 22.08, по образцу MAPS.ME).
 *
 * ── Что честно сказать про браузер ─────────────────────────────────────────
 *
 * Нативный навигатор пишет трек фоновой службой и с погашенным экраном.
 * Браузер так не может: система усыпляет вкладку, и `watchPosition` замолкает.
 * Врать про это нельзя — человек рассчитывает на трек и убирает телефон в
 * карман. Поэтому: паузы ЗАМЕЧАЮТСЯ и считаются, а не заглаживаются, и
 * запись переживает выгрузку вкладки, потому что лежит на диске.
 *
 * ── Прервана — не значит остановлена (скрин владельца 12.10) ──────────────
 *
 * «При повторном открытии не сохраняется трек». Черновик на диске не знал,
 * нажимал ли человек «Остановить», и экран маршрута принимал любой черновик
 * за готовый трек: при открытии со связью тихо отправлял обрывок и стирал
 * его с телефона, а запись не продолжалась. Человек возвращался в
 * приложение — и не находил ни линии, ни идущей записи.
 *
 * Теперь у черновика есть отметка `stoppedAt`. Остановленный ждёт отправки,
 * как раньше. Прерванный ПРОДОЛЖАЕТСЯ сам, как у навигаторов: запись идёт,
 * пока человек её не остановил. Провал между последней точкой до перерыва и
 * первой после станет границей `<trkseg>` (SEGMENT_GAP_S) — прямой через
 * пропущенный кусок в треке не будет.
 *
 * ── Устройство ─────────────────────────────────────────────────────────────
 *
 * Правила приёма засечки — в `lib/field/track-recorder` (чистые функции,
 * пороги по эталону Organic Maps). Здесь только их подключение к прибору,
 * сохранение и три исхода у каждого шага: пишем / отброшено с причиной /
 * прибор молчит.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  acceptFix, emptyRecorder, summarize, toGpx, DROP_WORDS,
  type DropReason, type RecorderState, type TrackSummary,
} from '@/lib/field/track-recorder';
import {
  saveTrackDraft, getTrackDraft, clearTrackDraft,
  type FieldTrackDraft,
} from '@/lib/offline/db';
import { geolocationWatch } from '@/lib/geo/current-position';

/** Дольше этого без засечки — прибор молчит, и это надо сказать. */
const SILENCE_MS = 45_000;
/**
 * Дольше этого без ПРИНЯТОЙ засечки, когда сами засечки идут, — отказ приёма.
 *
 * Это третье состояние, которого не было (случай 31.08, см. DROP_WORDS):
 * «молчит» и «говорит, но негодное» — разные беды, а выглядели одинаково,
 * потому что второе не выглядело никак. Окно длиннее тишины: одиночные
 * отказы нормальны на старте, пока прибор ловит спутники.
 */
const REJECT_MS = 60_000;
/** Как часто сбрасывать запись на диск. Чаще — изнашивать, реже — терять. */
const SAVE_EVERY = 5;

export interface TrackRecorderApi {
  recording: boolean;
  /**
   * Идущая запись продолжает прежнюю (прерванную или не досланную), а не
   * начата с нуля. Экран по нему решает, стирать ли нарисованный след:
   * продолжение — та же линия, новая запись — новая.
   */
  continued: boolean;
  summary: TrackSummary;
  /** Прибор молчит дольше положенного — экран обязан это показать. */
  silent: boolean;
  /**
   * Засечки идут, но ни одна не годится дольше минуты: запись выглядит
   * рабочей, а не пишется. Причина словами; null — приём в порядке.
   * Молчание прибора сюда НЕ попадает, у него своё имя (`silent`).
   */
  rejecting: string | null;
  /** Отказ словами; null — отказа не было. */
  error: string | null;
  start: (name: string) => void;
  stop: () => Promise<{ gpx: string; summary: TrackSummary } | null>;
  discard: () => Promise<void>;
  /**
   * На диске лежит ОСТАНОВЛЕННАЯ запись с прошлого раза, ещё не отправленная.
   * Прерванная сюда не попадает: она продолжается сама (`recording`).
   */
  restored: boolean;
  /**
   * Пакует ОСТАНОВЛЕННУЮ запись (с диска или недоотправленную) в GPX, не
   * трогая запись/watch — для автодожима при возврате связи, когда человек
   * ничего не нажимал. null — пакетировать нечего: меньше двух точек или
   * запись не остановлена (прерванная — идущая работа, а не готовый трек).
   */
  packageDraft: () => { gpx: string; summary: TrackSummary } | null;
}

function toDraft(name: string, startedAt: number, st: RecorderState): FieldTrackDraft {
  return {
    id: 'current',
    name,
    startedAt,
    points: st.points.map(p => [p.lat, p.lng, p.altitude, p.t]),
    dropped: { ...st.dropped },
    lengthM: st.lengthM,
  };
}

function fromDraft(d: FieldTrackDraft): RecorderState {
  return {
    points: d.points.map(([lat, lng, altitude, t]) => ({
      lat, lng, altitude, t, accuracy: 0,
    })),
    dropped: {
      accuracy: d.dropped.accuracy ?? 0,
      jitter: d.dropped.jitter ?? 0,
      jump: d.dropped.jump ?? 0,
      unknown_accuracy: d.dropped.unknown_accuracy ?? 0,
      bad_number: d.dropped.bad_number ?? 0,
    },
    lengthM: d.lengthM,
  };
}

export function useTrackRecorder(): TrackRecorderApi {
  const [recording, setRecording] = useState(false);
  const [continued, setContinued] = useState(false);
  const [restored, setRestored] = useState(false);
  const [silent, setSilent] = useState(false);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<TrackSummary>(() => summarize(emptyRecorder()));

  const stateRef = useRef<RecorderState>(emptyRecorder());
  const nameRef = useRef<string>('');
  const startedRef = useRef<number>(0);
  const watchRef = useRef<number | null>(null);
  const lastFixRef = useRef<number>(0);
  const sinceSaveRef = useRef<number>(0);
  /** Когда в последний раз засечка была ПРИНЯТА (не просто получена). */
  const lastAcceptRef = useRef<number>(0);
  /** Чем отказывает прибор сейчас — для слов, а не для догадки. */
  const lastDropRef = useRef<DropReason | null>(null);
  /** Запись в памяти остановлена кнопкой и ждёт отправки. */
  const stoppedRef = useRef(false);

  // Молчание прибора замечается таймером, а не отсутствием событий:
  // «событий нет» и «всё хорошо, просто стоим» иначе неотличимы.
  useEffect(() => {
    if (!recording) { setSilent(false); setRejecting(null); return; }
    const t = setInterval(() => {
      const quiet = Date.now() - lastFixRef.current > SILENCE_MS;
      setSilent(quiet);
      // Отказ приёма — только когда прибор ГОВОРИТ. Если он молчит, это уже
      // названо словом `silent`, и двух тревог об одном не бывает.
      const reason = lastDropRef.current;
      setRejecting(
        !quiet && reason !== null && Date.now() - lastAcceptRef.current > REJECT_MS
          ? DROP_WORDS[reason]
          : null,
      );
    }, 5000);
    return () => clearInterval(t);
  }, [recording]);

  /**
   * Запуск прибора. `continuing` — дописывать то, что уже в stateRef
   * (прерванная или не досланная запись), а не начинать с нуля: точки,
   * которые человек уже прошёл, не выбрасываются из-за того, что экран
   * перезапустился. false — прибора нет, запись не идёт.
   */
  const beginWatch = useCallback((name: string, continuing: boolean): boolean => {
    // Объект геолокации без функций (заглушка браузера) — тот же отказ, что
    // его отсутствие, а не падение экрана (23.10).
    const geo = geolocationWatch();
    if (!geo) {
      setError('Телефон не отдаёт геопозицию — запись невозможна');
      return false;
    }
    setError(null);
    if (!continuing) {
      stateRef.current = emptyRecorder();
      startedRef.current = Date.now();
    }
    nameRef.current = name;
    stoppedRef.current = false;
    setRestored(false);
    lastFixRef.current = Date.now();
    lastAcceptRef.current = Date.now();
    lastDropRef.current = null;
    setRejecting(null);
    sinceSaveRef.current = 0;

    watchRef.current = geo.watchPosition(
      pos => {
        lastFixRef.current = Date.now();
        const r = acceptFix(stateRef.current, {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
          altitude: pos.coords.altitude !== null && Number.isFinite(pos.coords.altitude)
            ? pos.coords.altitude : null,
          t: pos.timestamp,
        });
        stateRef.current = r.state;
        setSummary(summarize(r.state));
        if (r.accepted) {
          lastAcceptRef.current = lastFixRef.current;
          lastDropRef.current = null;
        } else {
          lastDropRef.current = r.reason;
        }
        if (r.accepted && ++sinceSaveRef.current >= SAVE_EVERY) {
          sinceSaveRef.current = 0;
          void saveTrackDraft(toDraft(nameRef.current, startedRef.current, r.state))
            .catch(() => { /* диск отказал — запись продолжается в памяти */ });
        }
      },
      err => {
        // Отказ прибора — не молчание. Причину называем: «разрешите
        // доступ» и «спутников нет» лечатся по-разному.
        setError(err.code === err.PERMISSION_DENIED
          ? 'Доступ к геопозиции закрыт — разрешите в настройках браузера'
          : 'Спутники не ловятся. Выйдите на открытое место, запись продолжится сама');
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
    );
    setContinued(continuing);
    setRecording(true);
    return true;
  }, []);

  // Запись с прошлого раза. Остановленная — ждёт отправки (`restored`), её
  // судьбой распоряжается экран. Прерванная — продолжается: человек её не
  // останавливал, и решение «запись кончилась» за него принимать нельзя.
  useEffect(() => {
    let alive = true;
    void getTrackDraft().then(d => {
      if (!alive || !d || d.points.length === 0) return;
      // Человек успел нажать «Записать» раньше, чем прочёлся диск: запись уже
      // идёт, и второй прибор поверх неё означал бы две записи в одну.
      if (watchRef.current !== null) return;
      stateRef.current = fromDraft(d);
      nameRef.current = d.name;
      startedRef.current = d.startedAt;
      setSummary(summarize(stateRef.current));
      if (d.stoppedAt !== undefined) {
        stoppedRef.current = true;
        setRestored(true);
        return;
      }
      // Прибора нет — продолжить нечем, но запись не теряется: она видна
      // как лежащая на диске, и человек решит сам.
      if (!beginWatch(d.name || 'Выход', true)) setRestored(true);
    }).catch(err => {
      // Приватный режим или закрытое хранилище — записи просто нет. Но
      // отказ называется в логе: «не смог прочитать» не равно «нечего читать».
      console.error('[track] черновик записи не прочитан', err);
    });
    return () => { alive = false; };
  }, [beginWatch]);

  // Свернул приложение — сбрасываем запись на диск, не дожидаясь пятой точки:
  // свёрнутую вкладку система вправе выгрузить, и хвост пути пропал бы.
  useEffect(() => {
    if (!recording || typeof document === 'undefined') return;
    const onHide = () => {
      if (document.visibilityState !== 'hidden' || stateRef.current.points.length === 0) return;
      void saveTrackDraft(toDraft(nameRef.current, startedRef.current, stateRef.current))
        .catch(err => console.error('[track] запись не сохранена при сворачивании', err));
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [recording]);

  // Новая запись — с нуля, если на руках нет прежней. Не досланная
  // остановленная запись дописывается, а не затирается: черновик на диске
  // один, и новая запись иначе съела бы трек, который ещё не уехал.
  const start = useCallback((name: string) => {
    beginWatch(name, stateRef.current.points.length > 0);
  }, [beginWatch]);

  const stopWatch = useCallback(() => {
    if (watchRef.current !== null) {
      geolocationWatch()?.clearWatch(watchRef.current);
      watchRef.current = null;
    }
  }, []);

  const stop = useCallback(async () => {
    stopWatch();
    setRecording(false);
    setContinued(false);
    const st = stateRef.current;
    const sum = summarize(st);
    setSummary(sum);
    if (st.points.length < 2) {
      // Меньше двух точек — линии нет. Тот же порог, что у Organic Maps.
      // Хранить нечего: обрывок из одной точки не дописывается в следующую
      // запись и не досылается.
      setError('Записано меньше двух точек — трека не получилось');
      stateRef.current = emptyRecorder();
      stoppedRef.current = false;
      await clearTrackDraft().catch(err => console.error('[track] не удалось убрать пустую запись', err));
      return null;
    }
    // Остановленная запись — на диск С ОТМЕТКОЙ и целиком, до отправки:
    // между сбросами по пять точек хвост жил только в памяти, а отметка
    // отличает готовый трек от прерванного при следующем открытии.
    stoppedRef.current = true;
    await saveTrackDraft({
      ...toDraft(nameRef.current, startedRef.current, st),
      stoppedAt: Date.now(),
    }).catch(err => console.error('[track] остановленная запись не сохранена на диск', err));
    const name = nameRef.current || 'Выход';
    return { gpx: toGpx(st, name), summary: sum };
  }, [stopWatch]);

  const discard = useCallback(async () => {
    stopWatch();
    setRecording(false);
    setContinued(false);
    setRestored(false);
    stoppedRef.current = false;
    stateRef.current = emptyRecorder();
    setSummary(summarize(stateRef.current));
    await clearTrackDraft().catch(() => { /* нечего чистить */ });
  }, [stopWatch]);

  useEffect(() => stopWatch, [stopWatch]);

  const packageDraft = useCallback((): { gpx: string; summary: TrackSummary } | null => {
    if (!stoppedRef.current) return null;
    const st = stateRef.current;
    if (st.points.length < 2) return null;
    const name = nameRef.current || 'Выход';
    return { gpx: toGpx(st, name), summary: summarize(st) };
  }, []);

  return {
    recording, continued, summary, silent, rejecting, error,
    start, stop, discard, restored, packageDraft,
  };
}
