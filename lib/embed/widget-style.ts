/**
 * Оформление плавающей кнопки формы заявки (`/api/widget/lead.js`) из
 * `partners.widget_config`. Всё, что отсюда выходит, вписывается в скрипт на
 * чужом сайте, поэтому на вход — unknown, на выход — только проверенное.
 */
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Конфиг партнёра → то, что можно безопасно вписать в скрипт.
 *
 * `bottom` — отступ кнопки снизу. У партнёра в нижних углах бывают свои
 * плашки: на fishingkam.ru это cookie-баннер, синяя полоса и «Связаться с
 * нами», и кнопка на штатных 24 px закрывала ссылку на согласие с cookie
 * (примерка 29.09). Число, 0–400, иначе 24.
 */
export function widgetStyle(cfg: Record<string, unknown>): {
  accent: string; buttonText: string; position: 'left' | 'right'; bottom: number;
} {
  const accent = typeof cfg.accentColor === 'string' && HEX_COLOR.test(cfg.accentColor) ? cfg.accentColor : '#D44A0C';
  const buttonText = typeof cfg.buttonText === 'string' && cfg.buttonText.trim() ? cfg.buttonText.trim().slice(0, 40) : 'Заявка на тур';
  const position = cfg.position === 'left' ? 'left' : 'right';
  const rawBottom = typeof cfg.bottom === 'number' ? cfg.bottom : typeof cfg.bottom === 'string' ? Number(cfg.bottom) : NaN;
  const bottom = Number.isFinite(rawBottom) ? Math.max(0, Math.min(400, Math.round(rawBottom))) : 24;
  return { accent, buttonText, position, bottom };
}
