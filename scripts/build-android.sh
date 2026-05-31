#!/bin/bash
# Build APK de release do VoiceAI para instalação direta no Android
# Uso: ./scripts/build-android.sh

set -e

ROOT="$(dirname "$0")/.."
ANDROID="$ROOT/android"
OUTPUT="$ANDROID/app/build/outputs/apk/release/app-release.apk"

echo ""
echo "=== Build APK VoiceAI (release) ==="
echo ""

# Verificar keystore
if ! grep -q "^VOICEAI_STORE_FILE=" "$ANDROID/gradle.properties" 2>/dev/null; then
  echo "Keystore não configurada. Execute primeiro:"
  echo "  ./scripts/generate-keystore.sh"
  echo ""
  echo "Ou, para teste rápido sem keystore, use a keystore de debug (NÃO use no Google Play):"
  read -rp "Continuar com keystore de debug? [s/N] " resp
  if [[ "$resp" != "s" && "$resp" != "S" ]]; then
    exit 1
  fi
fi

echo "Limpando build anterior..."
cd "$ANDROID"
./gradlew clean

echo ""
echo "Compilando APK de release..."
./gradlew assembleRelease

if [ -f "$OUTPUT" ]; then
  echo ""
  echo "✅ APK gerado com sucesso!"
  echo "   Arquivo: $OUTPUT"
  echo ""
  echo "Para instalar via cabo USB (com adb instalado):"
  echo "   adb install -r $OUTPUT"
  echo ""
  echo "Para transferir manualmente: copie o arquivo acima para o celular."
else
  echo "❌ Build falhou — arquivo APK não encontrado."
  exit 1
fi
