# VoiceAI

Aplicativo Expo/React Native para gravação de áudio, transcrição e geração de evoluções clínicas. O projeto integra Supabase para autenticação/sincronização e Edge Functions que intermediam as chamadas à OpenAI.

## Requisitos

- Node.js 20.19 ou superior
- npm
- Expo/EAS CLI conforme a tarefa
- Conta e projeto Supabase para autenticação, sincronização e Edge Functions

## Configuração local

```bash
git clone https://github.com/devrafaelbrauner/voice_ai.git
cd voice_ai
cp .env.example .env
npm ci
npm start
```

Preencha `.env` com os valores do seu projeto Supabase:

```dotenv
EXPO_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJ...
```

Nunca inclua `.env`, chaves de assinatura ou `google-service-account.json` no Git.

## Comandos

```bash
npm start                 # Expo development server
npm run android           # Executa Android localmente
npm run ios               # Executa iOS localmente
npm run web               # Executa a versão web
npm run lint              # ESLint
npm run typecheck         # TypeScript sem emissão
npm run expo:check        # Resolve e valida o manifest Expo
npm run release:check     # Gates locais de release
```

## Backend Supabase

As Edge Functions `openai-chat` e `openai-transcribe` mantêm a chave OpenAI fora do dispositivo. Consulte [supabase/README.md](supabase/README.md) para configurar migrations, secrets e deploy das funções.

## Versionamento e releases

O projeto usa SemVer e tags anotadas no formato `vMAJOR.MINOR.PATCH`. A versão pública deve permanecer alinhada entre `app.json` e `package.json`.

- `expo.version`: versão exibida ao usuário.
- `android.versionCode` e `ios.buildNumber`: números de build monotonicamente crescentes, administrados pelo EAS em builds de produção.
- `CHANGELOG.md`: histórico das mudanças por release.
- `RELEASE.md`: procedimento operacional de release, build, distribuição e rollback.

A release atual de baseline é `1.0.1`. Antes de criar a primeira build remota, inicialize no EAS os números de build já distribuídos com `eas build:version:set`.

## Qualidade contínua

O workflow `.github/workflows/ci.yml` executa instalação reprodutível, validação de manifest, lint e TypeScript em pull requests e em pushes para `main`.

## Segurança e privacidade

Este aplicativo processa dados clínicos. Antes de qualquer distribuição de produção, valide a configuração implantada do Supabase (RLS, secrets, Auth e rate limits), as políticas de retenção e exclusão de dados e a documentação LGPD aplicável.
