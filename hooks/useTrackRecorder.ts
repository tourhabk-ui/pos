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
 * ── Устройство ─────────────────────────────────────────────────────────────
 *
 * Правила приёма засечки — в `lib/field/track-recorder` (чистые функции,
 * пороги по эталону Organic Maps). Здесь только их подключение к прибору,
 * сохранение и три исхода у каждого шага: пишем / отброшено с причиной /
 * прибор молчит.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  acceptFix, emptyRecorder, summarize, toGpx,
  type RecorderState, type TrackSummary,
} from '@/lib/field/track-recorder';
import {
  saveTrackDraft, getTrackDraft, clearTrackDraft,
  type FieldTrackDraft,
} from '@/lib/offline/db';

/** Дольше этого без засечки — прибор молчит, и это надо сказать. */
const SILENCE_MS = 45_000;
/** Как часто сбрасывать запись на диск. Чаще — изнашивать, реже — терять. */
const SAVE_EVERY = 5;

export interface TrackRecorderApi {
  recording: boolean;
  summary: TrackSummary;
  /** Прибор молчит дольше положенного — экран обязан это показать. */
  silent: boolean;
  /** Отказ словами; null — отказа не было. */
  error: string | null;
  start: (name: string) => void;
  stop: () => Promise<{ gpx: string; summary: TrackSummary } | null>;
  discard: () => Promise<void>;
  /** Есть недописанная запись с прошлого раза. */
  restored: boolean;
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
  const [restored, setRestored] = useState(false);
  const [silent, setSilent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<TrackSummary>(() => summarize(emptyRecorder()));

  const stateRef = useRef<RecorderState>(emptyRecorder());
  const nameRef = useRef<string>('');
  const startedRef = useRef<number>(0);
  const watchRef = useRef<number | null>(null);
  const lastFixRef = useRef<number>(0);
  const sinceSaveRef = useRef<number>(0);

  // Недописанная запись с прошлого раза: вкладку выгрузили, человек шёл
  // дальше. Показываем, что она есть, но НЕ продолжаем сами — решает он.
  useEffect(() => {
    let alive = true;
    void getTrackDraft().then(d => {
      if (!alive || !d || d.points.length === 0) return;
      stateRef.current = fromDraft(d);
      nameRef.current = d.name;
      startedRef.current = d.startedAt;
      setSummary(summarize(stateRef.current));
      setRestored(true);
    }).catch(() => { /* приватный режим — записи просто нет */ });
    return () => { alive = false; };
  }, []);

  // Молчание прибора замечается таймером, а не отсутствием событий:
  // «событий нет» и «всё хорошо, просто стоим» иначе неотличимы.
  useEffect(() => {
    if (!recording) { setSilent(false); return; }
    const t = setInterval(() => {
      setSilent(Date.now() - lastFixRef.current > SILENCE_MS);
    }, 5000);
    return () => clearInterval(t);
  }, [recording]);

  const start = useCallback((name: string) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setError('Телефон не отдаёт геопозицию — запись невозможна');
      return;
    }
    setError(null);
    if (!restored) {
      stateRef.current = emptyRecorder();
      startedRef.current = Date.now();
    }
    nameRef.current = name;
    setRestored(false);
    lastFixRef.current = Date.now();
    sinceSaveRef.current = 0;

    watchRef.current = navigator.geolocation.watchPosition(
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
    setRecording(true);
  }, [restored]);

  const stopWatch = useCallback(() => {
    if (watchRef.current !== null && typeof navigator !== 'undefined') {
      navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    }
  }, []);

  const stop = useCallback(async () => {
    stopWatch();
    setRecording(false);
    const st = stateRef.current;
    const sum = summarize(st);
    setSummary(sum);
    if (st.points.length < 2) {
      // Меньше двух точек — линии нет. Тот же порог, что у Organic Maps.
      setError('Записано меньше двух точек — трека не получилось');
      return null;
    }
    const name = nameRef.current || 'Выход';
    return { gpx: toGpx(st, name), summary: sum };
  }, [stopWatch]);

  const discard = useCallback(async () => {
    stopWatch();
    setRecording(false);
    setRestored(false);
    stateRef.current = emptyRecorder();
    setSummary(summarize(stateRef.current));
    await clearTrackDraft().catch(() => { /* нечего чистить */ });
  }, [stopWatch]);

  useEffect(() => stopWatch, [stopWatch]);

  return { recording, summary, silent, error, start, stop, discard, restored };
}
