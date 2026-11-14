# Changelog

## [Não lançado]

### Corrigido — backup (QA em aparelho)
- **KDF e cifra nativos (B1/B4):** scrypt (N=2^14 / 2^16, r=8, p=1) e AES-256-GCM do backup agora rodam em código nativo (`react-native-quick-crypto`, OpenSSL; scrypt no thread pool do C++) e o base64 em `react-native-quick-base64`, em vez de JS puro no Hermes (antes ~49 s por senha, thread JS parada de 27 s a 106 s e ~1,5 GB de RSS com 36 MB). Chamada assíncrona (nunca `*Sync`), sem fallback para JS: sem o módulo no binário o backup falha com mensagem clara. O formato v2 do envelope não mudou (mesmo scrypt, AES-GCM e AAD): backups antigos abrem e os novos abrem no código antigo (teste com envelope gerado pelo código @noble).
- **Limite de 50 MB antes do KDF (B2):** o tamanho exato do envelope é calculado e comparado com o limite antes do scrypt e da cifra (export falhava só após 83 s); no restore, o tamanho do arquivo é checado antes de ler/derivar. Testes provam que o scrypt não é chamado quando o limite estoura.
- **Criptografia local (db-crypto) também nativa (B1 de ponta a ponta):** `encrypt()`/`decrypt()` dos campos do SQLite usam AES-256-GCM nativo por JSI síncrono (sem ponte assíncrona por campo) e base64 nativo; antes o `@noble/ciphers` em JS decifrava ~0,7 MB/s (export: 18 s de "build" com 12,5 MB, 68 s com 36 MB; restore recifrava em JS). Formato `enc1:<iv>:<ct||tag>`, chave do SecureStore e `KeyLostError` inalterados: dados existentes continuam abrindo (teste com valores cifrados pelo código @noble antigo). Módulo ausente lança erro claro em vez de virar `__DECRYPT_FAILED__`. Loader/cifra compartilhados em `src/services/native-crypto.ts`.
- **UTF-8 sem TextDecoder (F1):** a decifra de campos (`db-crypto.decrypt`) e do envelope (`decryptBackupText`) deixou de usar o `TextDecoder` do Expo (polyfill em JS, ~1,57 ms por campo de 4,5 KB no Hermes — dominava `buildBackup` e o restore) e converte bytes em string pelo `bufferToString`/`stringToBuffer` nativos do quick-crypto (JSI/C++). A validação continua ESTRITA: o conversor nativo é permissivo, então o texto é recodificado e comparado byte a byte com a entrada (UTF-8 inválido, overlong, surrogate e truncado são recusados; no db-crypto viram `__DECRYPT_FAILED_SENTINEL`, no backup "Conteúdo do backup corrompido."). Diferença: um BOM no início do texto agora é preservado (o `TextDecoder` o descartava). O envelope exportado é montado por concatenação (uma cópia a menos de ~48 MB) e `sealed`/`plain` são soltos antes do `JSON.parse`.
- **Sonda nativa:** a falha ao carregar o módulo agora registra `logWarn` com o nome do erro (antes o `catch` engolia a causa).
- **UI (QA em aparelho):** edição do nome em Gravações em linha própria (campo ≥ 120 dp de largura e ≥ 48 dp de altura, ✓/✕ de 48 dp; antes sobravam 47 × 33 dp em ~320 dp); modal de senha do backup sobe acima do teclado e rola até o campo focado (Confirmar senha não fica mais coberto); texto de tempo do modal atualizado para "alguns segundos (até cerca de 30 s em bancos grandes)".
- **Segurança:** senha em bytes zerada após o KDF; `@noble/hashes` e `@noble/ciphers` viraram dependências de desenvolvimento (só os testes usam, como implementação de referência).
- **Requer novo binário nativo** (`react-native-quick-crypto`, `react-native-nitro-modules`, `react-native-quick-base64`; plugin em `app.json`); não há OTA nem Expo Go.

### Segurança (mobile)
- Criptografia local agora é AES-256-GCM real (`@noble/ciphers` + `expo-crypto`): o runtime Hermes não tem `crypto.subtle`, então antes os dados sensíveis eram gravados em texto puro. `encrypt()` falha fechado; chave criada com single-flight; `KeyLostError` em vez de regenerar chave silenciosamente. Verificado em aparelho (campo sensível gravado como `enc1:`, 0 ocorrências de texto puro no SQLite).
- Migration v9 recifra linhas legadas em texto puro; `secure_delete` + VACUUM após migração; push de sync cifra campos sensíveis e aborta se falhar.
- Backup nunca mais cai para exportação sem cifra.
- Bird ID: chaves do SecureStore inválidas corrigidas; PDF só é compartilhado se tiver assinatura real (`/ByteRange` + `/Contents`).
- EvoPad: checagem de rede local estrita (`10.evil.com` não passa), URL guardada só como origem, sem fallback para localhost quando a URL configurada é remota.
- Mermaid: escape de `</script>`, script fixado em 10.9.8 com SRI, CSP com nonce, navegação bloqueada, sem janelas extras.
- **Requer novo binário nativo** (`expo-crypto`); não há OTA.

### Slice C — ciclo de vida de dados e motor de transcrição
- Exclusões: tombstones locais (`pending_deletions`, migration v10, triggers AFTER DELETE); sync faz flush verificado antes do pull e nunca ressuscita item excluído; mutex de sync com watchdog de 25 s; `professionalEnabled` faz round-trip com flag de alteração pendente.
- Backup v2 cifrado com passphrase (scrypt N=2^14 + AES-GCM, cabeçalho como AAD, limite 50 MB) e restore transacional via `expo-document-picker`; resumo da Config por `COUNT(*)` em SQL; exports em `cache/exports` com sweep. Backup v1 em texto puro não é mais aceito.
- Motor de transcrição (referência: FlowVoice): `TranscriptionError` tipado por status HTTP, retry com backoff e `Retry-After`, cadeia de recuo sempre no mesmo provedor, checagem de sanidade do texto. Fila por `fileName` com cooldown, para em rede/rate limit/chave/cota e nunca perde o áudio; drain único (store) também ao voltar ao primeiro plano.
- Gravação excluída durante transcrição/IA não é recriada (`updateFieldIfExists`).
- **Requer novo binário nativo** (`expo-document-picker`) e a migration Supabase com `doctor_profiles.professional_enabled`.

### Testes
- Suíte jest-expo (`npm test`): 196 testes de backup v2, banco/tombstones (SQL real via `node:sqlite`), sync, motor de transcrição e fila; 26 mutantes de produto detectados. Requer Node >= 22.

### Limpeza
- `tsc --noEmit` sem erros (declaração de `*.module.css`), lint sem erros; removidos `transcribeViaProxy` morto e código não usado em Config/Gravações; `Retry-After` não inteiro/negativo é ignorado (antes virava espera de 0 ms); README/TEST_REPORT/IMPLEMENTATION_STATUS corrigidos.

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
