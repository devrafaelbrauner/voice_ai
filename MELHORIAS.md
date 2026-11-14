# Melhorias fora do raio

## Run slice-a (edge functions)
- Orçamento de gasto por conta, bloqueio de cadastro aberto e preço do `gpt-5.4-mini` (+ espelhar `cost_usd=0` em `src/services/api_usage.ts`) — dono: Produto.
- Validar o campo `model` do multipart em `openai-transcribe` (exige parse do stream) — dono: backend.
- Aplicar a migration em staging, confirmar grants e pg_cron; deploy e teste real de upload > 25 MB — dono: DevOps/DB.
- Próximas fatias (verify-1/Reality.md): B mobile (db-crypto, Bird ID, EvoPad, Mermaid), C ciclo de vida de dados, D testes jest-expo, E limpeza/docs, S decisões LGPD.
