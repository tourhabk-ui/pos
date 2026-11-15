/**
 * Голос телефона для кнопки «Озвучить» — когда голос Ведара недоступен.
 *
 * Повод — слово владельца 15.11 «голос не работает». Проверка прода 189 в тот
 * день: обе модели голоса Qwen отвечают 403 `AllocationQuota.FreeTierOnly`,
 * бесплатная квота кончилась. Кнопка честно писала «Не удалось озвучить
 * ответ», но человек на маршруте оставался без голоса.
 *
 * У телефона свой синтез речи (Web Speech API), и русский голос в нём обычно
 * есть. Он бесплатный, а локальный голос работает и без сети. Кнопка берёт его,
 * только когда голос Ведара не ответил, и говорит об этом словами: голос
 * другой, и выдавать его за голос Ведара нельзя.
 *
 * Голос устройства бывает двух родов. Локальный (`localService`) синтезирует
 * на самом телефоне. Сетевой отправляет текст своему производителю и без сети
 * молчит. Локальный берётся первым всегда, сетевой — только при сети.
 */

/** Сколько ждать список голосов: в Chrome он приходит не сразу. */
export const VOICES_WAIT_MS = 1000;

/** То, что нужно знать о голосе устройства для выбора. */
export interface VoiceLike {
  lang: string;
  localService: boolean;
}

/** Русский голос устройства: локальный первым; без сети — только локальный. */
export function pickRussianVoice<T extends VoiceLike>(voices: readonly T[], online: boolean): T | null {
  const ru = voices.filter((v) => /^ru(?:[-_]|$)/i.test(v.lang));
  const local = ru.find((v) => v.localService);
  if (local) return local;
  return online ? ru[0] ?? null : null;
}

/**
 * Список голосов устройства. В Chrome первый вызов `getVoices()` отдаёт пустой
 * список, а голоса приходят событием `voiceschanged` — ждём его не дольше
 * VOICES_WAIT_MS и отдаём то, что есть.
 */
export function loadDeviceVoices(synth: SpeechSynthesis, waitMs = VOICES_WAIT_MS): Promise<SpeechSynthesisVoice[]> {
  const now = synth.getVoices();
  if (now.length > 0) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      synth.removeEventListener('voiceschanged', done);
      resolve(synth.getVoices());
    };
    const timer = setTimeout(done, waitMs);
    synth.addEventListener('voiceschanged', done);
  });
}
