# Relatório de Testes - voice-ai-recorder

## Estado atual (branch chore/cleanup)

| Verificação | Comando | Resultado |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | 0 erros |
| Lint | `npm run lint` | 0 erros (3 warnings `react-hooks/exhaustive-deps`) |
| Testes | `npm test` (jest-expo, `src/**/__tests__`) | 5 suítes, 197 testes passando |

Requer Node >= 22.

## O que é testado

Lógica de serviços em JS puro (sem rede, sem relógio real): motor de transcrição
(`openai.ts`: classificação de erros, Retry-After, retry, cadeia de provedores),
fila offline, backup v2 cifrado, entre outros em `src/services/__tests__/`.

## O que NÃO é testado

- Execução em Hermes e em aparelho/simulador (UI, gravação, módulos nativos).
- Supabase real (Auth, RLS, Edge Functions, rate limit) e APIs OpenAI/OpenRouter reais.
- Telas e componentes React Native (sem testes de renderização).

## Histórico

O relatório anterior citava 111 erros de TypeScript (Tamagui); não se aplicam mais.
