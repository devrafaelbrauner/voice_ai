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

## Run slice-c (dados e transcrição)
- NÃO testado em aparelho/Hermes: tempo real do backup e do db-crypto com AES-GCM/scrypt nativos (`react-native-quick-crypto`; esperado scrypt < ~2 s e `buildBackup` de 12,5 MB ≲ 2 s; custo de criar um Cipheriv por campo a confirmar; dev build ainda não gerada), teto de memória no restore de ~36 MB, `\p{L}` no Hermes, exclusive transaction do expo-sqlite, TalkBack, Supabase real — dono: QA mobile.
- Edge function `openai-transcribe` esconde o `code` do 429 (quota via proxy aparece como rate_limit); `transcribeViaProxy` em `openai-proxy.ts` ficou sem uso — dono: backend.
- L-R3: erro de `flushDeletions` isolado por chunk não aparece no status de sync — dono: Mobile.
- Renomear/`durationSecs` ainda usam `setField` (protegido só por tombstone); `saveSummary/saveTranscript/saveSummaryTemplate` em openai.ts usam `setField` e não têm chamador — dono: Mobile.
- SC-08, C3-02 (push/pull sem paginação), C3-03, AS-C-18..23 (colisão de nomes legados, restore não exclusivo, `clearField`, blocklist leet), UI-07/09, TP-05/09, erros de chave perdida (SBA-12) — dono: Mobile; slice D/E.
- Troca de conta descarta tombstones (exclusões da conta A voltam ao reentrar) — dono: Mobile.
- Privacidade: fallback de cadeia só no mesmo provedor; opt-in cross-provider é decisão de Produto (slice S). Nenhuma tela de erro dedicada ainda lê `transcriptionErrors` fora do banner de Gravações.
- Pendentes de Produto/DevOps (não bloqueiam merge): aplicar migrations Supabase, nova dev build, `CHECK enc1:%`, orçamento de gasto por conta.
