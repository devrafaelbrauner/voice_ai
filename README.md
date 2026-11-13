# Voice AI Recorder

App Expo (SDK 55, expo-router) para gravar áudio, transcrever e resumir com IA.

## Executar

```bash
npm install
npx expo run:ios      # ou: npx expo run:android
npx expo start        # servidor Metro, para um development build já instalado
```

O app usa módulos nativos (ex.: `expo-crypto`, `expo-document-picker`) que não
estão no Expo Go: é preciso um [development build](https://docs.expo.dev/develop/development-builds/introduction/).

## Verificação

```bash
npx tsc --noEmit   # tipos
npm run lint       # ESLint
npm test           # jest-expo (requer Node >= 22)
```

## Backup

O backup exportado é o formato v2 cifrado com uma passphrase escolhida pelo
usuário (`src/services/backup.ts`). Arquivos de áudio não fazem parte do backup.

## Mais informações

- Backend Supabase (Edge Functions): `supabase/README.md`
- Estado da implementação: `IMPLEMENTATION_STATUS.md`; testes: `TEST_REPORT.md`
- [Documentação do Expo](https://docs.expo.dev/)
