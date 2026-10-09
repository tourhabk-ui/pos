/**
 * Когда короткий клип можно играть сам.
 *
 * Клип на странице — украшение, а не содержание: он обязан уступать человеку,
 * сети и батарее. Решение одно на всю платформу, чистое и проверяемое без
 * браузера; компонент components/media/LazyClip только собирает окружение и
 * спрашивает здесь.
 *
 * Автоигра запрещена, если:
 *  - человек просил меньше движения (prefers-reduced-motion) — это не каприз,
 *    а доступность;
 *  - включена экономия трафика (Save-Data) или сеть медленная (2g, 3g): даже
 *    клип в 200 КБ — это секунды ожидания на полевом EDGE, а смысл экрана в
 *    другом;
 *  - сети нет вовсе: играть нечему, остаётся кадр-обложка.
 *
 * Запрет автоигры не прячет клип: остаётся обложка и кнопка «играть», и то,
 * что человек нажал сам, он получает (кроме офлайна — там нажимать не на что).
 * Окружение, которое не удалось определить, считается РАЗРЕШАЮЩИМ только для
 * тех признаков, которых у браузера нет (нет Network Information API — это
 * Safari/Firefox, и им нечем сказать «сеть плохая»): отсутствие сведения не
 * должно запрещать, но и сведение, которое есть, не должно игнорироваться.
 */
export interface ClipEnv {
  reducedMotion: boolean;
  saveData: boolean;
  /** 'slow-2g' | '2g' | '3g' | '4g'; undefined — браузер не сообщает. */
  effectiveType?: string;
  online: boolean;
}

export type ClipVerdict =
  | { autoplay: true; reason: 'ok' }
  | { autoplay: false; reason: 'reduced-motion' | 'save-data' | 'slow-network' | 'offline' };

const SLOW = new Set(['slow-2g', '2g', '3g']);

export function clipPolicy(env: ClipEnv): ClipVerdict {
  if (!env.online) return { autoplay: false, reason: 'offline' };
  if (env.reducedMotion) return { autoplay: false, reason: 'reduced-motion' };
  if (env.saveData) return { autoplay: false, reason: 'save-data' };
  if (env.effectiveType && SLOW.has(env.effectiveType)) return { autoplay: false, reason: 'slow-network' };
  return { autoplay: true, reason: 'ok' };
}

/** Что сказать человеку, когда клип сам не играет. null — ничего говорить не надо. */
export function clipHint(reason: ClipVerdict['reason']): string | null {
  switch (reason) {
    case 'offline': return 'Нет сети — видео появится, когда она вернётся.';
    case 'save-data': return 'Экономия трафика: нажмите, чтобы воспроизвести.';
    case 'slow-network': return 'Медленная сеть: нажмите, чтобы воспроизвести.';
    case 'reduced-motion': return 'Нажмите, чтобы воспроизвести.';
    case 'ok': return null;
  }
}
