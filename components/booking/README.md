# 📅 Компоненты Бронирования - KamHub

**Статус:** ✅ Полностью готово к использованию  
**Версия:** 1.0.0  
**Дата:** 5 ноября 2025

---

## 📦 Что внутри

### Календари (`calendars/`)

| Компонент | Описание | Строк |
|-----------|----------|-------|
| `BaseCalendar.tsx` | Базовый календарь | 150 |
| `StayDatePicker.tsx` | Отели (диапазон дат) | 300 |
| `TourDatePicker.tsx` | Туры (групповые/индивидуальные) | 350 |
| `TransferDateTimePicker.tsx` | Трансферы (дата + расписание) | 400 |
| `calendar-utils.ts` | 30+ утилит для дат | 350 |
| `calendar.module.css` | Стили | 600 |

### UI компоненты (`ui/`)

| Компонент | Описание | Строк |
|-----------|----------|-------|
| `GuestSelector.tsx` | Выбор гостей | 200 |
| `AvailabilityIndicator.tsx` | Индикатор доступности | 80 |
| `TimeSlotPicker.tsx` | Выбор времени | 150 |

**ИТОГО:** 9 файлов, 2,580 строк кода

---

## 🚀 Быстрый старт

### 1. Установка зависимостей

```bash
npm install react-datepicker date-fns clsx react-hot-toast @types/react-datepicker
```

### 2. Использование

#### 🏨 Отели

```tsx
import { StayDatePicker } from '@/components/booking/calendars/StayDatePicker';

<StayDatePicker
  accommodationId="hotel-123"
  pricePerNight={3450}
  minNights={2}
  onDatesChange={(checkIn, checkOut, pricing) => {
    console.log('Цена:', pricing?.total);
  }}
/>
```

#### 🏔️ Туры

```tsx
import { TourDatePicker } from '@/components/booking/calendars/TourDatePicker';

<TourDatePicker
  tourId="tour-456"
  tourType="group" // или "individual"
  duration={5}
  onDateSelect={(date, timeSlot) => {
    console.log('Дата:', date);
  }}
/>
```

#### 🚌 Трансферы

```tsx
import { TransferDateTimePicker } from '@/components/booking/calendars/TransferDateTimePicker';

<TransferDateTimePicker
  routeId="route-789"
  fromLocation="Петропавловск"
  toLocation="Долина гейзеров"
  distance={180}
  onScheduleSelect={(id, date, schedule) => {
    console.log('Рейс:', schedule);
  }}
/>
```

#### 👥 Выбор гостей

```tsx
import { GuestSelector } from '@/components/booking/ui/GuestSelector';

<GuestSelector
  maxGuests={20}
  onChange={(adults, children, ages) => {
    console.log('Гостей:', adults + children);
  }}
/>
```

---

## 🔌 Необходимые API

Календари требуют следующие endpoints:

### Для отелей:
- `GET /api/accommodations/[id]/blocked-dates`
- `GET /api/accommodations/[id]/availability?checkIn=...&checkOut=...`

### Для туров:
- `GET /api/tours/[id]/available-dates`
- `GET /api/tours/[id]/time-slots?date=...`

### Для трансферов:
- `GET /api/transfers/[routeId]/schedules?date=...`


---

## Документация

Раньше здесь стояла таблица из четырёх файлов (`КАЛЕНДАРИ_ИНСТРУКЦИЯ.md`,
`ИТОГ_КАЛЕНДАРИ.md`, `docs/CALENDAR_UI_SPECS.md`, `docs/CALENDAR_FINAL_DECISION.md`).
Ни одного из них в репозитории нет — проверено 10.09.2026. Ссылка на
несуществующий документ хуже её отсутствия: читающий идёт искать то, чего
нет, и решает, что не нашёл. Актуальные источники: этот README, стандарт
карточки тура в `CLAUDE.md` §11 (блок «липкая бронь», `BookingFormClient`,
`TourDateField` → `GET /api/tours/[id]/slots`) и `docs/DEVELOPER_GUIDE.md`.

---

## ⚙️ Технологии

- **react-datepicker** 4.21.0 - Базовый календарь
- **date-fns** 2.30.0 - Работа с датами
- **clsx** 2.0.0 - Условные классы
- **react-hot-toast** 2.4.1 - Уведомления

---

## 🎨 Кастомизация

Измените цвета в `calendars/calendar.module.css`:

```css
:root {
  --calendar-bg: #0b0b0b;
  --accent-gold: #E6C149;
  /* ... */
}
```

---

## ✅ Возможности

### Общие:
- ✅ TypeScript
- ✅ Русская локализация
- ✅ Мобильная адаптация
- ✅ Клавиатурная навигация
- ✅ Accessibility (ARIA)
- ✅ Анимации
- ✅ Loading states
- ✅ Error handling

### StayDatePicker:
- ✅ Диапазон дат
- ✅ Блокировка дат
- ✅ Минимум ночей
- ✅ Расчёт цены
- ✅ Проверка доступности

### TourDatePicker:
- ✅ Групповые туры
- ✅ Индивидуальные туры
- ✅ Индикаторы загрузки
- ✅ Слоты времени
- ✅ Информация о погоде

### TransferDateTimePicker:
- ✅ Календарь + расписание
- ✅ Типы транспорта
- ✅ Водители + рейтинг
- ✅ Свободные места
- ✅ Особенности (WiFi, AC, VIP)

---

## 🐛 Troubleshooting

### Ошибка: "Cannot find module 'react-datepicker'"

Решение:
```bash
npm install react-datepicker @types/react-datepicker
```

### Ошибка: "Locale is not registered"

Проверьте импорт в `BaseCalendar.tsx`:
```tsx
import { ru } from 'date-fns/locale';
registerLocale('ru', ru);
```

### Календарь не стилизован

Убедитесь что импортирован CSS:
```tsx
import 'react-datepicker/dist/react-datepicker.css';
```

---

## 📊 Статистика

```
✅ 9 компонентов
✅ 2,580 строк кода
✅ 30+ утилит
✅ 120+ страниц документации
✅ 100% TypeScript
✅ 100% Русская локализация
```

---

## 🎯 Статус

```
✅ Календари               [████████████] 100%
⏳ API endpoints           [███░░░░░░░░░] 30%
⏳ Формы бронирования      [░░░░░░░░░░░░] 0%
```

---

## 🚀 Следующие шаги

1. Создать API endpoints (3-4ч)
2. Создать формы бронирования (4-5ч)
3. Интегрировать CloudPayments (6-8ч)
4. Добавить Email уведомления (3-4ч)

---

**Создано:** 5 ноября 2025  
**Лицензия:** Для внутреннего использования KamHub  
**Контакты:** См. главный README.md проекта

🏔️ **Сделано с любовью для Камчатки!** 🏔️



