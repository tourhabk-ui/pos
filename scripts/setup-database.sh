#!/bin/bash

# ============================================
# ПОЛНАЯ НАСТРОЙКА БАЗЫ ДАННЫХ KAMHUB
# ============================================

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                                        ║${NC}"
echo -e "${BLUE}║   🏔️  KAMHUB DATABASE SETUP  🏔️        ║${NC}"
echo -e "${BLUE}║                                        ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

# Проверка DATABASE_URL
if [ -z "$DATABASE_URL" ]; then
  echo -e "${RED}❌ DATABASE_URL не установлена!${NC}"
  echo ""
  echo "Установите переменную окружения:"
  echo "  export DATABASE_URL='postgresql://user:pass@host:5432/dbname'"
  echo ""
  exit 1
fi

echo -e "${GREEN}✓${NC} DATABASE_URL найдена"
echo ""

# Проверка подключения
echo -e "${BLUE}▶${NC} Проверка подключения к PostgreSQL..."

if ! psql "$DATABASE_URL" -c "SELECT 1" > /dev/null 2>&1; then
  echo -e "${RED}❌ Не удалось подключиться к PostgreSQL!${NC}"
  exit 1
fi

echo -e "${GREEN}✓${NC} Подключение успешно"
echo ""

# Применение baseline-схемы (снята с прода воркфлоу db-baseline;
# init-postgresql.sql и apply-new-schemas.sql удалены давно — скрипт
# ссылался на несуществующие файлы, находка сквозного прогона 14.08)
echo -e "${BLUE}▶${NC} Восстановление схемы из baseline..."
node scripts/bootstrap-from-baseline.js

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓${NC} Схема восстановлена из baseline"
else
  echo -e "${RED}❌ Ошибка применения baseline${NC}"
  exit 1
fi

echo ""

# Новые миграции поверх baseline (в _migrations уже помечено применённое)
echo -e "${BLUE}▶${NC} Миграции поверх baseline..."
node scripts/migrate-standalone.js

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓${NC} Миграции применены"
else
  echo -e "${YELLOW}⚠${NC} Проверьте _migration_failures"
fi

echo ""

# Проверка таблиц
echo -e "${BLUE}▶${NC} Проверка созданных таблиц..."

TABLE_COUNT=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';")

echo -e "${GREEN}✓${NC} Создано таблиц: $TABLE_COUNT"
echo ""

echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                                        ║${NC}"
echo -e "${GREEN}║   ✅  БАЗА ДАННЫХ ГОТОВА!  ✅          ║${NC}"
echo -e "${GREEN}║                                        ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""

echo "Следующие шаги:"
echo "  1. npm run dev - запустить приложение"
echo "  2. Проверить работу всех модулей"
echo ""

