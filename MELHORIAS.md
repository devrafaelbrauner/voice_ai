# Melhorias fora do raio

## Run slice-a (edge functions)
- Orçamento de gasto por conta, bloqueio de cadastro aberto e preço do `gpt-5.4-mini` (+ espelhar `cost_usd=0` em `src/services/api_usage.ts`) — dono: Produto.
- Validar o campo `model` do multipart em `openai-transcribe` (exige parse do stream) — dono: backend.
- Aplicar a migration em staging, confirmar grants e pg_cron; deploy e teste real de upload > 25 MB — dono: DevOps/DB.
- Próximas fatias (verify-1/Reality.md): B mobile (db-crypto, Bird ID, EvoPad, Mermaid), C ciclo de vida de dados, D testes jest-expo, E limpeza/docs, S decisões LGPD.

## Run slice-b (mobile)
- Recuperação de chave perdida (`KeyLostError`): hoje o app não salva mais gravações até limpar os dados; falta tela de recuperação — dono: Produto/Mobile.
- Constraint no Supabase `CHECK (col IS NULL OR col LIKE 'enc1:%')`, versão mínima do app e purge de plaintext em backups/PITR (SBA-11) — dono: Backend.
- Teste em aparelho ainda pendente: decrypt após reiniciar, migration v9 em DB legado, render do Mermaid sob a CSP, backup, Bird ID, EvoPad LAN — dono: QA mobile.
- Restantes: SBA-05/06/07 (fallback localhost, `secure-fetch` por prefixo, AAD no AES-GCM), SB-06 (`saveEdit` sem try/catch), SB-07, R2-03/04/07, `allowBackup` Android — dono: Mobile.
- Observação de processo: `snapshot.py capture` da slice-b falhou em silêncio; raio comprovado só por `git diff` vs main.
