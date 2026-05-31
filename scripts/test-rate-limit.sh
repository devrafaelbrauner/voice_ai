#!/usr/bin/env bash
# Teste de rate limit: dispara 25 requisições rápidas no openai-chat
# Esperado: primeiras 20 = HTTP 200, da 21ª em diante = HTTP 429
#
# Como usar:
#   1. Pegue um JWT do app logado:
#      - No console do app, procure por logs ou execute no Settings
#      - Ou via SQL: SELECT auth.uid() (não funciona, precisa JWT real)
#      - Mais fácil: copiar `access_token` do AsyncStorage do app
#   2. Execute:
#      ./scripts/test-rate-limit.sh "eyJhbGciOi..."

set -e

SUPABASE_URL="https://your-project-ref.supabase.co"
ANON_KEY="<YOUR_SUPABASE_ANON_KEY>"

USER_JWT="${1:-}"

if [[ -z "$USER_JWT" ]]; then
  echo "Uso: $0 <USER_JWT>"
  echo ""
  echo "Como pegar o JWT:"
  echo "  1. No app, abra o console de logs do Expo"
  echo "  2. Execute no Settings: console.log(await supabase.auth.getSession())"
  echo "  3. Copie o 'access_token'"
  exit 1
fi

echo "──────────────────────────────────────────"
echo "Disparando 25 requisições rápidas em openai-chat..."
echo "Esperado: ~20 primeiras = 200, depois = 429"
echo "──────────────────────────────────────────"

PASS=0
FAIL_429=0
FAIL_OTHER=0

for i in $(seq 1 25); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "$SUPABASE_URL/functions/v1/openai-chat" \
    -H "apikey: $ANON_KEY" \
    -H "Authorization: Bearer $USER_JWT" \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}]}')

  if [[ "$STATUS" == "200" ]]; then
    PASS=$((PASS + 1))
    echo "  [$i] HTTP $STATUS  ✓"
  elif [[ "$STATUS" == "429" ]]; then
    FAIL_429=$((FAIL_429 + 1))
    echo "  [$i] HTTP $STATUS  ⛔ rate-limited"
  else
    FAIL_OTHER=$((FAIL_OTHER + 1))
    echo "  [$i] HTTP $STATUS  ⚠ unexpected"
  fi
done

echo "──────────────────────────────────────────"
echo "Resultado:"
echo "  ✓ Sucesso (200):       $PASS"
echo "  ⛔ Rate-limited (429): $FAIL_429"
echo "  ⚠ Outros erros:        $FAIL_OTHER"
echo "──────────────────────────────────────────"

if [[ $FAIL_429 -gt 0 && $PASS -ge 15 ]]; then
  echo "✅ Rate limit FUNCIONANDO — bloqueou após ~20 requests"
elif [[ $FAIL_429 -eq 0 ]]; then
  echo "❌ Rate limit NÃO está funcionando (nenhum 429 retornado)"
else
  echo "⚠  Comportamento inesperado — investigar"
fi
