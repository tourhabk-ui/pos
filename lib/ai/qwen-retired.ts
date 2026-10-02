/**
 * Модели Alibaba Model Studio (DashScope), которые отключаются 10.10.2026
 * 00:00 UTC+8 — 2026-10-09T16:00Z.
 *
 * Источник — два уведомления Alibaba, прочитанные целиком 01.10 (письмо
 * владельцу от 28.09 само списка не несло, только ссылки):
 *   - id=2000, «Notice on the Postponed Retirement of Selected Legacy Models»;
 *   - id=2009, «Notice of Retirement for Selected Legacy Models», 91 модель
 *     с названной заменой у каждой.
 * После отключения вызов такой модели «не вернёт результата» — то есть живой
 * путь получит отказ там, где вчера был ответ.
 *
 * Зачем список в коде, а не только в памяти. Две двери выбирают модель сами,
 * без нашего id: резолвер «сильнейшей» (lib/ai/model-resolver) и подмена при
 * исчерпанной бесплатной квоте (lib/ai/qwen-free-quota). Обе берут из
 * каталога /v1/models то, что он отдаёт, — а каталог отдаёт и обречённое.
 * Замер 01.10: при квоте, кончившейся у qwen3.8-max и её снимка, резолвер
 * выбирал qwen3.6-max-preview, затем qwen3-max — обе в списке. Отказ модели
 * здесь не «не знаю», а заранее известный ответ, и выбирать её незачем.
 *
 * Только DashScope. deepseek-* и glm-* в уведомлениях — их копии на
 * площадке Alibaba; наши вызовы DeepSeek и z.ai идут к самим провайдерам и
 * этого списка не касаются.
 */

const RETIRED = new Set<string>(([
  // id=2000: аудио, снимки
  'qwen-tts-latest', 'qwen-tts-2025-05-22', 'qwen-tts-2025-04-10', 'qwen-tts-realtime-latest', 'qwen-tts-realtime-2025-07-15',
  // id=2000: Qwen и сторонние на DashScope
  'deepseek-v3.2', 'deepseek-r1', 'deepseek-v3', 'deepseek-v3.1', 'glm-4.7', 'glm-4.6', 'deepseek-v3.2-exp', 'deepseek-r1-0528',
  'Moonshot-Kimi-K2-Instruct', 'kimi-k2-thinking', 'deepseek-r1-distill-qwen-32b', 'deepseek-r1-distill-qwen-14b', 'deepseek-r1-distill-qwen-7b',
  'qwen3-max-2026-01-23', 'qwen3-max-2025-09-23', 'qwen3-vl-flash-2026-01-22', 'qwen3-vl-flash-2025-10-15',
  'qwen3-coder-plus-2025-09-23', 'qwen3-coder-plus-2025-07-22', 'qwen3-235b-a22b-instruct-2507', 'qwen3-32b',
  'qwen3-vl-235b-a22b-instruct', 'qwen3-vl-32b-thinking', 'qwen3-vl-32b-instruct', 'qwen3-vl-30b-a3b-thinking',
  'qwen3-vl-30b-a3b-instruct', 'qwen3-vl-8b-thinking', 'qwen3-vl-8b-instruct', 'qwen3-vl-235b-a22b-thinking',
  'qwen3-next-80b-a3b-instruct', 'qwen3-next-80b-a3b-thinking', 'qwen3-30b-a3b-instruct-2507', 'qwen3-30b-a3b-thinking-2507',
  'qwen3-235b-a22b-thinking-2507', 'qwen3-235b-a22b', 'qwen3-30b-a3b', 'qwen3-14b', 'qwen3-8b', 'qwen3-coder-next',
  'qwen3-coder-30b-a3b-instruct', 'qwen3-coder-480b-a35b-instruct',
  // id=2000: старые основные Qwen
  'qwen-turbo', 'qwen-turbo-realtime', 'qwen-vl-max', 'qwen-vl-plus', 'qwq-plus', 'qvq-max', 'qvq-plus',
  'qwen-math-turbo', 'qwen-coder-turbo', 'qwen-coder-plus',
  // id=2000: аудио, основные
  'qwen-tts', 'qwen-tts-realtime', 'qwen-voice-enrollment', 'qwen-voice-design', 'gummy-realtime-v1',
  // id=2000: Qwen3, основные
  'qwen3.6-max-preview', 'qwen3-max-preview', 'qwen3-max', 'qwen3-vl-flash', 'qwen3-coder-plus',
  // id=2009: изображения (замена — qwen-image-3.0 или wan2.7-r2v)
  'aitryon-parsing-v1', 'aitryon-plus', 'animate-anyone-detect-gen2', 'animate-anyone-gen2', 'animate-anyone-template-gen2',
  'emo-detect-v1', 'emo-v1', 'emoji-detect-v1', 'emoji-v1', 'liveportrait', 'liveportrait-detect',
  'qwen-image', 'qwen-image-edit', 'qwen-image-edit-max', 'qwen-image-edit-max-2026-01-16', 'qwen-image-edit-plus',
  'qwen-image-edit-plus-2025-10-30', 'qwen-image-edit-plus-2025-12-15', 'qwen-image-max', 'qwen-image-max-2025-12-30',
  'qwen-image-plus', 'qwen-image-plus-2026-01-09',
  // id=2009: речь и распознавание
  'cosyvoice-clone-v1', 'cosyvoice-v3', 'fun-asr-2025-08-25', 'fun-asr-2025-11-07', 'fun-asr-mtl', 'fun-asr-mtl-2025-08-25',
  'fun-asr-mtl-realtime', 'fun-asr-realtime-2025-09-15', 'fun-asr-realtime-2025-11-07', 'sensevoice-v1',
  'qwen3-asr-flash-2025-09-08', 'qwen3-asr-flash-2026-02-10', 'qwen3-asr-flash-filetrans-2025-11-17',
  'qwen3-asr-flash-realtime-2025-10-27', 'qwen3-asr-flash-realtime-2026-02-10',
  // id=2009: синтез речи (замена — cosyvoice-v3.5-plus или qwen3.5-omni-plus-realtime)
  'qwen3-tts-flash-2025-09-18', 'qwen3-tts-flash-2025-11-27', 'qwen3-tts-flash-realtime-2025-09-18',
  'qwen3-tts-flash-realtime-2025-11-27', 'qwen3-tts-instruct-flash', 'qwen3-tts-instruct-flash-2026-01-26',
  'qwen3-tts-instruct-flash-realtime', 'qwen3-tts-instruct-flash-realtime-2026-01-22', 'qwen3-tts-vc-2026-01-22',
  'qwen3-tts-vc-realtime-2025-11-27', 'qwen3-tts-vc-realtime-2026-01-15', 'qwen3-tts-vd-2026-01-26',
  'qwen3-tts-vd-realtime-2025-12-16', 'qwen3-tts-vd-realtime-2026-01-15',
  // id=2009: текст (замена — qwen3.7-plus или qwen3.6-flash-us)
  'codeqwen1.5-7b-chat', 'nlp-rag-rewrite-one', 'qwen-long-2025-01-25', 'qwen-long-latest', 'qwen-math-plus',
  'qwen-math-plus-0816', 'qwen-math-plus-0919', 'qwen-math-plus-latest', 'qwen-mt-lite-us', 'qwen-mt-turbo',
  'qwen-plus-0112', 'qwen-plus-1220', 'qwen-plus-2025-07-28', 'qwen-plus-2025-09-11', 'qwen-plus-2025-12-01-us',
  'qwen-plus-us', 'qwen-flash-us', 'qwen-flash-2025-07-28-us',
  // id=2009: мультимодальные
  'qwen-omni-turbo', 'qwen-omni-turbo-2025-01-19', 'qwen-omni-turbo-2025-03-26', 'qwen-omni-turbo-latest',
  'qwen-omni-turbo-realtime', 'qwen-omni-turbo-realtime-2025-05-08', 'qwen-omni-turbo-realtime-latest',
  'qwen2.5-omni-7b', 'qwen3-omni-30b-a3b-captioner', 'qwen3-omni-flash-2025-09-15', 'qwen3-omni-flash-2025-12-01',
  'qwen3-omni-flash-realtime', 'qwen3-omni-flash-realtime-2025-12-01', 'qwen3-livetranslate-flash-realtime',
  'qwen3-livetranslate-flash-realtime-2025-09-22', 'qwen-vl-ocr-1028', 'qwen-vl-ocr-2025-04-13', 'qwen-vl-ocr-latest',
  'qwen3-vl-plus-2025-09-23', 'qwen3-vl-plus-2025-12-19', 'qwen3-vl-flash-us', 'qwen3-vl-flash-2025-10-15-us',
  'qwen3-vl-flash-2026-01-22-us',
  // id=2009: DeepSeek на DashScope (замена — deepseek-v4-flash-0731)
  'deepseek-v4-flash', 'deepseek-v4-flash-us',
] as const).map((id) => id.toLowerCase()));

/** Отключается ли модель DashScope 10.10.2026. Регистр id не важен. */
export function isQwenRetired(model: string): boolean {
  return RETIRED.has(model.toLowerCase());
}
