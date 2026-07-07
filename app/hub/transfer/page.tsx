import { redirect } from 'next/navigation';

/**
 * Старый мок-дашборд трансферов удалён (решение владельца): 100% фиктивные
 * данные (mockRoutes, графики на Math.random) и кнопки без обработчиков.
 * Публичный поиск/бронирование — /transfers; реальный кабинет транспортного
 * оператора — /hub/transfer-operator.
 */
export default function TransferRedirect() {
  redirect('/transfers');
}
