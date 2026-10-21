/**
 * Оформление виджетов партнёра из `partners.widget_config`: плавающая кнопка
 * формы заявки (`/api/widget/lead.js`), цвет чата и формы
 * (`/api/widget/partner/[partnerId]`), вступление формы заявки. Всё, что
 * отсюда выходит, вписывается в скрипт или страницу на чужом сайте, поэтому
 * на вход — unknown, на выход — только проверенное.
 */
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Цвет кнопки, если партнёр своего не выбрал, — светлый `--accent` платформы
 * (CLAUDE.md §2). До 15.10 здесь стоял прежний акцент #D44A0C: белый текст на
 * нём даёт 4,39:1, ниже AA 4,5; светлый акцент затемнён аудитом 02.10, а
 * виджет остался на старом (находка аудита 15.10 WID-config, W10).
 */
export const WIDGET_DEFAULT_ACCENT = '#006CE4';

/** Подпись кнопки формы заявки, если партнёр своей не выбрал. */
export const LEAD_BUTTON_DEFAULT_TEXT = 'Заявка на тур';

/**
 * Вступление над полями формы заявки, если партнёр своего не задал. Без
 * обещания срока: «свяжется сегодня» стояло здесь без источника — когда
 * ответит партнёр, платформа не знает (§4.0).
 */
export const LEAD_FORM_INTRO_DEFAULT = 'Оставьте заявку — с вами свяжутся по указанному телефону.';

/**
 * Заготовка колонки из миграции 142:
 * `{"greeting":"Привет!","accentColor":"#D44A0C","buttonText":"Чат","position":"right"}`.
 * Эти значения никто из партнёров не выбирал — их ставил DEFAULT каждой новой
 * строке, и они выглядели как выбор. «Чат» на кнопке, которая открывает
 * ФОРМУ заявки, — неправда (у «Местечка» на проде 15.10 так и было), а
 * #D44A0C — прежний акцент ниже AA. Поэтому заготовка читается как «не
 * задано», а не как решение партнёра (находка аудита 15.10 WID-config, W1).
 */
const LEGACY_DEFAULT_BUTTON_TEXT = 'Чат';
const LEGACY_DEFAULT_ACCENT = '#d44a0c';

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
  const rawAccent = typeof cfg.accentColor === 'string' ? cfg.accentColor : '';
  const accent = HEX_COLOR.test(rawAccent) && rawAccent.toLowerCase() !== LEGACY_DEFAULT_ACCENT
    ? rawAccent
    : WIDGET_DEFAULT_ACCENT;
  const rawText = typeof cfg.buttonText === 'string' ? cfg.buttonText.trim() : '';
  const buttonText = rawText && rawText !== LEGACY_DEFAULT_BUTTON_TEXT
    ? rawText.slice(0, 40)
    : LEAD_BUTTON_DEFAULT_TEXT;
  const position = cfg.position === 'left' ? 'left' : 'right';
  const rawBottom = typeof cfg.bottom === 'number' ? cfg.bottom : typeof cfg.bottom === 'string' ? Number(cfg.bottom) : NaN;
  const bottom = Number.isFinite(rawBottom) ? Math.max(0, Math.min(400, Math.round(rawBottom))) : 24;
  return { accent, buttonText, position, bottom };
}

/**
 * Вступление формы заявки: `widget_config.formIntro` партнёра или нейтральный
 * текст. Приветствие ЧАТА (`greeting`) сюда не идёт: до 15.10 форма ставила
 * его над полями имени и телефона, и у «Местечка» над формой стояло «Я
 * Кузьмич… спрашивайте» — приглашение к разговору там, где разговора нет.
 */
export function leadFormIntro(cfg: Record<string, unknown>): string {
  const own = typeof cfg.formIntro === 'string' ? cfg.formIntro.trim() : '';
  return own ? own.slice(0, 300) : LEAD_FORM_INTRO_DEFAULT;
}
