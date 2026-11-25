/**
 * Страницы, где человек сам отправляет заявку, подготовленную ИИ-агентом
 * (/confirm, /confirm/change). Баннер согласия и сторонние скрипты здесь не
 * показываем: на телефоне полоса cookie ложилась на кнопку «Отправить»
 * (проход страницы 25.11), а адрес страницы несёт личный токен — счётчикам
 * тут делать нечего (Метрика исключена ещё раньше, METRIKA_EXCLUDED_PREFIXES).
 */
export function isConfirmSurface(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return pathname === '/confirm' || pathname.startsWith('/confirm/');
}
