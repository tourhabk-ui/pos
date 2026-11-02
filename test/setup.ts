// Матчеры jest-dom (toBeInTheDocument, toHaveTextContent…) нужны только там,
// где есть DOM. Среда по умолчанию — node (vitest.config.ts), и в ней импорт
// матчеров стоил бы ~0,25 с на каждый файл без экрана — а таких почти все.
if (typeof document !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
}

// Кнопки-записи без подписи (lib/chat-cabinet/signed-payload) тесты жмут
// напрямую: окно приёма старых кнопок в тестах не закрывается по календарю.
process.env.CALLBACK_LEGACY_UNTIL_MS ??= String(Date.parse('9999-01-01T00:00:00Z'));
