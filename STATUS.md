# KamchatourHub — Статус платформы

_Обновлено: 9 мая 2026_

---

## Текущее состояние

| Показатель | Значение |
|---|---|
| Build | ✅ `npm run build` проходит |
| TypeScript | ✅ 0 ошибок (`tsc --noEmit`) |
| Страниц | 94 (App Router) |
| API endpoints | 256 |
| Компонентов | 119 |
| Хабов | 8 |
| Миграции | 663 (raw SQL) |
| Маршрутов (kamchatka_routes) | 294 |
| Мест (places) | 779 |
| Туров (operator_tours) | 20 |
| Гидов (аттестованных) | 112 |

---

## Активные ветки

| Ветка | PR | Статус |
|---|---|---|
| `claude/offline-travel-skills-Fjahq` | #1 (draft) | Офлайн-рюкзак + безопасность |

---

## Последние изменения (май 2026)

- ✅ Офлайн-рюкзак: `/trips/plan` + `/trips/[id]` + IndexedDB v2
- ✅ SW v8: кеш `/trips/[uuid]`, `/places/[id]`, `/safety/offline`, `/sos`
- ✅ SafetyBlock: GPS + SOS + SMS МЧС в viewer маршрута
- ✅ MChs reminder в плане-строителе
- ✅ MChs номер исправлен: +7 (4152) 23-53-62

---

## Деплой

- Timeweb Cloud → App ID: 175477 → `tourhab.ru`
- GitHub → автодеплой при push в `main`
- Переменные: панель Timeweb Cloud
