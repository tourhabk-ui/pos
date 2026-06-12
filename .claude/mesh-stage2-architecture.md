# Меш-сеть Слой 2: LoRa-шлюз (архитектура)

> Статус: Roadmap. Не реализовано. Ждёт: выбор железа, ответ по регуляторке частот.

## Принцип

PWA — интерфейс на концах, не транспорт.
LoRa-узлы формируют радиосеть между собой. Шлюз-узел с интернетом делает POST к API.

```
Телефон туриста
  └─ (BLE/Serial) ─→ LoRa-узел A
                          └─ (радио 868 МГц) ─→ узел B ─→ ... ─→ Шлюз (Wi-Fi/4G)
                                                                        └─ POST /api/safety/sos
```

## Контракт шлюза (сервер готов, менять не нужно)

```http
POST /api/safety/sos
Content-Type: application/json

{
  "lat": 53.123,
  "lng": 159.456,
  "accuracy": 15,
  "tourist_name": "...",
  "tourist_phone": "...",
  "message": "SOS",
  "source": "lora_mesh",
  "mesh_hops": 3
}
```

Поле `source: "lora_mesh"` и `mesh_hops` уже принимаются — сервер не нужно трогать.
Поле `relayed_by` — deviceId шлюза (для аудита).

## Мост телефон ↔ LoRa-узел

### Web Bluetooth API (Chrome Android)

```typescript
// Пример: подключение к Meshtastic-узлу по BLE
const device = await navigator.bluetooth.requestDevice({
  filters: [{ namePrefix: 'Meshtastic' }],
  optionalServices: ['6ba1b218-15a8-461f-9fa8-5d6d11b4f1ac'],
});
const server = await device.gatt!.connect();
const service = await server.getPrimaryService('6ba1b218-15a8-461f-9fa8-5d6d11b4f1ac');
const characteristic = await service.getCharacteristic('...');
await characteristic.writeValue(encoder.encode(JSON.stringify(sosPayload)));
```

**Ограничения:**
- Только Chrome (Android, desktop)
- iOS Safari: Web Bluetooth не поддерживается

### iOS blocker mitigation

**Вариант A: QR-код** (работает на всех устройствах)
1. Пользователь нажимает SOS
2. PWA показывает QR с данными: `{"lat":..,"lng":..,"name":"..","ts":..}`
3. Гид/оператор сканирует своим Android-телефоном → BLE → LoRa-узел
4. Реализация: `qrcode` npm package или SVG-генератор

**Вариант B: React Native Expo** (будущее)
Expo имеет `expo-bluetooth` API на iOS. Переходить только если нужен полноценный iOS-мост.

**Вариант C: Web Serial API** (USB-C → LoRa-модуль)
Для стационарных точек (базовый лагерь, КПП). Chrome-only.

## Железо (не выбрано)

Кандидаты для узлов:
- **Heltec LoRa32 V3** (~$15): ESP32 + LoRa 868 МГц, батарея
- **TTGO T-Beam**: GPS + LoRa, для gateway
- **Meshtastic**: готовый firmware, BLE-интерфейс, есть iOS-приложение

Требования к шлюзу:
- LoRa приёмник/передатчик 868 МГц (РФ)
- Wi-Fi или LTE для HTTP POST
- Питание: аккумулятор 4000+ mAh (≥24ч без зарядки)

## Регуляторка (РФ)

- Диапазон 868 МГц входит в ISM-полосу (863–870 МГц)
- В России: разрешено без лицензии по РЧЦ до 25 мВт ERP
- Heltec/TTGO работают до 20 дБм (100 мВт) — нужна проверка
- **Открытый вопрос**: подтверждение у Flux/заинтересованных сторон ожидается

## Фазы реализации

| Фаза | Задача | Блокер |
|------|--------|--------|
| 2.1 | QR-SOS fallback в PWA | нет |
| 2.2 | Web Bluetooth → Meshtastic прототип | Android только |
| 2.3 | LoRa шлюз (Heltec + Raspberry Pi) | железо |
| 2.4 | Deployment: стратегические точки маршрутов | регуляторка |
| 2.5 | iOS: Expo wrapper с BLE | решение по платформе |

## Текущий статус PWA

После Трека 1+2 реализованы:
- VolcanoMesh WebRTC: активируется на /sos и /map при GPS
- SOS relay: если у пира есть интернет (хотспот), он ретранслирует SOS
- SSE reconnect: backoff 1s→2s→4s→...→30s
- Peer markers на карте: cyan маркеры с временем последнего контакта
