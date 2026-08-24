/**
 * Типы протокола вебхука Алисы (Yandex Dialogs).
 *
 * Форма списана с исходников https://github.com/vitalets/alice-types
 * (клонирован и прочитан напрямую 24.08 — официальная документация
 * yandex.ru недоступна из песочницы, egress заблокирован). Пакет как
 * npm-зависимость не подключаем: нужен десяток интерфейсов, а не библиотека.
 *
 * Протокол: https://yandex.ru/dev/dialogs/alice/doc/protocol.html
 */

export interface AliceRequest {
  meta: {
    locale: string;
    timezone: string;
    client_id: string;
    interfaces?: {
      screen?: Record<string, never>;
      account_linking?: Record<string, never>;
    };
  };
  request: {
    command: string;
    original_utterance: string;
    type: 'SimpleUtterance' | 'ButtonPressed';
    payload?: unknown;
    nlu?: {
      tokens: string[];
      entities: AliceEntity[];
      intents?: Record<string, { slots: Record<string, unknown> }>;
    };
  };
  session: {
    message_id: number;
    session_id: string;
    skill_id: string;
    user_id: string;
    application: { application_id: string };
    new: boolean;
  };
  /** Эхо предыдущего session_state — то, что мы сами туда положили ходом раньше. */
  state?: {
    session?: Record<string, unknown>;
  };
  version: '1.0';
}

export type AliceEntity =
  | { type: 'YANDEX.NUMBER'; tokens: { start: number; end: number }; value: number }
  | { type: 'YANDEX.STRING'; tokens: { start: number; end: number }; value: string }
  | { type: 'YANDEX.GEO'; tokens: { start: number; end: number }; value: Record<string, unknown> }
  | { type: 'YANDEX.DATETIME'; tokens: { start: number; end: number }; value: Record<string, unknown> }
  | { type: 'YANDEX.FIO'; tokens: { start: number; end: number }; value: Record<string, unknown> };

export interface AliceButton {
  title: string;
  url?: string;
  payload?: unknown;
  hide?: boolean;
}

export interface AliceResponse {
  response: {
    text: string;
    tts?: string;
    buttons?: AliceButton[];
    end_session: boolean;
  };
  /**
   * Сервер без памяти между заходами: состояние диалога кладём сюда, Алиса
   * возвращает его нам следующим ходом в `request.state.session`. Без своей
   * БД под сессии — по образцу протокола, не по необходимости заводить
   * хранилище.
   */
  session_state?: Record<string, unknown>;
  version: '1.0';
}
