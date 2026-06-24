-- Migration 696: Clean up garbage partner records imported from visitkamchatka.ru
-- Removes entries where name was incorrectly extracted (URLs, emails, license numbers, navigation text)

DELETE FROM partners
WHERE external_source = 'visitkamchatka'
  AND (
    -- Raw URLs
    name ~* '^https?://'
    -- Email addresses
    OR name LIKE '%@%'
    -- License/registry numbers (РТО 002954, РТО002954)
    OR name ~* '^РТО\s*\d'
    -- Bare domains without protocol (в-комфорте.рф, photoexpedition.pro)
    OR name ~ '^[^\s]{3,60}\.[a-zA-Z]{2,6}$'
    OR name ~ '^[^\s]{3,60}\.рф$'
    OR name ~ '^[^\s]{3,60}\.ру$'
    -- UI / navigation text
    OR name ~* '^(туристу|туроператорам?|каталог|контакты|поиск|главная|навигация|меню|подробнее|читать|назад|все операторы)'
    -- Phone-like (only digits, spaces, +, -, parens)
    OR name ~ '^[\d\s+\-()]{7,}$'
    -- Too short to be a company name
    OR length(trim(name)) < 3
  );
