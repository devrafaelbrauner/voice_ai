# Changelog

## [Não lançado]

### Corrigido
- Edge Functions `openai-chat` e `openai-transcribe`: `json()` referenciava `corsHeaders` fora de escopo (ReferenceError em toda resposta de erro).
- `gpt-5.4-mini` aceito no proxy (`max_completion_tokens`, sem `temperature`); custo reportado 0 até o preço ser confirmado.
- Teto de `max_tokens` (4000) e `temperature` [0,2]; mensagens reduzidas a `{role, content}`; bodies inválidos retornam 400 com CORS; 502 genérico.
- Rate limit agora falha fechado (503 + `Retry-After`).
- Upload de transcrição: teto de 25 MB aplicado por contagem de bytes em streaming (cobre upload chunked).

### Segurança
- Migration `20260613000000_harden_rate_limit.sql`: `search_path=''`, REVOKE de `PUBLIC/anon/authenticated` em `increment_rate_limit` e `cleanup_old_rate_limit_windows`, cleanup horário via pg_cron quando disponível.

### Adicionado
- `supabase/functions/_shared/handlers_test.ts` (22 testes Deno).
