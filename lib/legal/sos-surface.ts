/**
 * Экраны экстренной помощи: баннер согласия и сторонние скрипты здесь
 * не показываем — они перекрывали инструкцию «Что делать» на /sos.
 */
export function isSosSurface(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return pathname === '/sos' || pathname.startsWith('/sos/');
}
