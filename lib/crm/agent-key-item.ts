/**
 * Ключ MCP партнёра в списке кабинета (CRM 1д-2) — без самого ключа и без
 * хеша. Отдельным модулем без импортов: тип читает и экран кабинета, а
 * lib/crm/agent-keys тянет node:crypto, которому в браузерной сборке не место
 * (сторож client-no-node-builtins).
 */
export interface AgentKeyItem {
  id: string;
  label: string;
  key_prefix: string;
  can_write: boolean;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  /**
   * Подключение по OAuth (кнопкой «Подключить» в Claude): имя приложения.
   * NULL — ключ, выпущенный в кабинете. У подключения начало ключа меняется
   * каждый час, поэтому экран показывает имя, а не key_prefix.
   */
  oauth_client: string | null;
  /** Когда подключение OAuth истечёт без обновления; у ключа — NULL. */
  expires_at: string | null;
}
