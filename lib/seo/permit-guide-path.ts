/**
 * Адрес справки «Нужно ли разрешение на посещение» (#3566 п.5). Отдельный
 * модуль без зависимостей: на него ссылается и клиентский блок разрешения
 * (components/safety/ParkPermitAction), а lib/seo/permit-guide тянет модули
 * сервера.
 */
export const PERMIT_GUIDE_PATH = '/razreshenie-na-poseshchenie';
