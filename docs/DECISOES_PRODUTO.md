# Decisões de produto e LGPD pendentes (slice S)

Cada item é decisão do dono do produto; a coluna "Padrão" é o que a equipe aplicaria se nada for dito.
Nada aqui foi implementado.

| # | Decisão | Opções | Padrão | Por quê importa |
|---|---|---|---|---|
| 1 | Chave de criptografia perdida (`KeyLostError`) | (a) tela de recuperação com backup v2 + limpar dados; (b) só aviso e limpar dados | (a) | Hoje o app para de salvar gravações até limpar os dados |
| 2 | Cadastro aberto e gasto por conta | (a) orçamento mensal por conta + convite; (b) manter aberto | (a) | Sem teto, uma conta pode gerar custo ilimitado de API |
| 3 | Preço do `gpt-5.4-mini` (`cost_usd=0` hoje) e espelho em `api_usage.ts` | informar o preço real | informar | Painel de custo está errado |
| 4 | Fallback de transcrição entre provedores | (a) nunca (atual); (b) opt-in explícito do usuário | (a) | Áudio clínico não pode mudar de provedor sem consentimento |
| 5 | Troca de conta | (a) descarta tombstones (atual); (b) tombstones por conta | (b) | Exclusões da conta A voltam ao reentrar nela (LGPD, direito de eliminação) |
| 6 | Modelo de transcrição padrão | manter `whisper-1` ou migrar para `gpt-transcribe` após medição no corpus clínico do FlowVoice | manter | Medição FLEURS isolada não justifica; `gpt-transcribe` foi o melhor clínico no FlowVoice |
| 7 | Backup: KDF | (a) N=2^14 em JS (atual); (b) módulo nativo de KDF/AES | (b) em release futuro | scrypt/AES-GCM em JS trava a thread por dezenas de segundos em 12–50 MB (não medido em aparelho) |
| 8 | Supabase: texto puro legado | `CHECK (col IS NULL OR col LIKE 'enc1:%')`, versão mínima do app, purge em backups/PITR | aplicar após a versão mínima | Evita novos dados em texto puro |
| 9 | Tabela `evolutions` | definir retenção, escopo e política de exclusão | definir | Fora do ciclo de vida de dados da slice C |

Ações de ambiente (não são decisões): aplicar migrations do Supabase (`professional_enabled`, rate limit), gerar nova dev build (`expo-crypto`, `expo-document-picker`), QA em aparelho dos itens NOT_TESTED em `MELHORIAS.md`.
