# Changelog

## [Não lançado]

### Segurança (mobile)
- Criptografia local agora é AES-256-GCM real (`@noble/ciphers` + `expo-crypto`): o runtime Hermes não tem `crypto.subtle`, então antes os dados sensíveis eram gravados em texto puro. `encrypt()` falha fechado; chave criada com single-flight; `KeyLostError` em vez de regenerar chave silenciosamente. Verificado em aparelho (campo sensível gravado como `enc1:`, 0 ocorrências de texto puro no SQLite).
- Migration v9 recifra linhas legadas em texto puro; `secure_delete` + VACUUM após migração; push de sync cifra campos sensíveis e aborta se falhar.
- Backup nunca mais cai para exportação sem cifra.
- Bird ID: chaves do SecureStore inválidas corrigidas; PDF só é compartilhado se tiver assinatura real (`/ByteRange` + `/Contents`).
- EvoPad: checagem de rede local estrita (`10.evil.com` não passa), URL guardada só como origem, sem fallback para localhost quando a URL configurada é remota.
- Mermaid: escape de `</script>`, script fixado em 10.9.8 com SRI, CSP com nonce, navegação bloqueada, sem janelas extras.
- **Requer novo binário nativo** (`expo-crypto`); não há OTA.

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
