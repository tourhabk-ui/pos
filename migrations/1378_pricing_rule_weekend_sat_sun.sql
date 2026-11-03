-- 1378: новый род правила цены `weekend_sat_sun` — наценка оператора на
-- субботу и воскресенье (K.ai-план B1, решение владельца 03.11.2026:
-- «наценки оператору до 30%», «выходные = сб+вс»). Прежний `weekend`
-- (пт–вс, правила админа) не меняется. Только расширение CHECK; данных нет.
ALTER TABLE tour_pricing_rules DROP CONSTRAINT IF EXISTS tour_pricing_rules_rule_type_check;
ALTER TABLE tour_pricing_rules ADD CONSTRAINT tour_pricing_rules_rule_type_check CHECK (rule_type IN (
  'season_peak', 'season_low', 'early_bird', 'last_minute', 'occupancy_high', 'group_discount', 'weekend', 'weekend_sat_sun'
));
