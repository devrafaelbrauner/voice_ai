#!/bin/bash
# Gera a keystore de release para o VoiceAI e configura gradle.properties
# Execute uma única vez. Guarde o arquivo .keystore em local seguro.

set -e

KEYSTORE_NAME="voiceai-release.keystore"
KEY_ALIAS="voiceai"
DEST="$(dirname "$0")/../android/app/$KEYSTORE_NAME"
PROPS="$(dirname "$0")/../android/gradle.properties"

if [ -f "$DEST" ]; then
  echo "Keystore já existe em $DEST — nada a fazer."
  exit 0
fi

echo ""
echo "=== Geração de Keystore VoiceAI ==="
echo "Você será solicitado a definir uma senha para a keystore."
echo "Guarde essa senha — sem ela não é possível publicar atualizações."
echo ""

read -rsp "Digite a senha da keystore (min 6 chars): " KS_PASS
echo ""
read -rsp "Confirme a senha: " KS_PASS2
echo ""

if [ "$KS_PASS" != "$KS_PASS2" ]; then
  echo "Senhas não conferem. Tente novamente."
  exit 1
fi

keytool -genkey -v \
  -keystore "$DEST" \
  -alias "$KEY_ALIAS" \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -storepass "$KS_PASS" \
  -keypass "$KS_PASS" \
  -dname "CN=Rafael Brauner, OU=VoiceAI, O=RafaelBrauner, L=Fortaleza, ST=CE, C=BR"

echo ""
echo "Keystore gerada em: $DEST"
echo ""

# Descomentar e preencher gradle.properties
sed -i '' \
  -e "s|# VOICEAI_STORE_FILE=.*|VOICEAI_STORE_FILE=$KEYSTORE_NAME|" \
  -e "s|# VOICEAI_STORE_PASSWORD=.*|VOICEAI_STORE_PASSWORD=$KS_PASS|" \
  -e "s|# VOICEAI_KEY_ALIAS=.*|VOICEAI_KEY_ALIAS=$KEY_ALIAS|" \
  -e "s|# VOICEAI_KEY_PASSWORD=.*|VOICEAI_KEY_PASSWORD=$KS_PASS|" \
  "$PROPS"

echo "gradle.properties configurado com sucesso."
echo ""
echo "IMPORTANTE: Adicione voiceai-release.keystore ao .gitignore (nunca commite a keystore)."
