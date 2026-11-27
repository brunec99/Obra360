-- Histórico por entidade, 27/11/2026: as leituras filtram por entity_id e ordenam por data (a gaveta
-- "Histórico" da Linha de Balanço, a Claudia lendo as últimas alterações e o /api/history dos vagões), e a
-- tabela só cresce. Sem índice, cada leitura varria a tabela inteira. Só cria índice: pode ser rodada de novo.
create index if not exists history_events_entity_occurred_idx on history_events (entity_id, occurred_at desc);
