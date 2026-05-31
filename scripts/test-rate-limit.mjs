#!/usr/bin/env node
/**
 * Teste de rate limit no openai-chat.
 * Faz login com email/senha + dispara 25 requisições rápidas.
 *
 * Uso:
 *   node scripts/test-rate-limit.mjs <email> <senha>
 *
 * Esperado:
 *   ~20 primeiras = HTTP 200, resto = HTTP 429 (rate-limited).
 */

import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

// Configure via variáveis de ambiente (não versionar credenciais):
//   EXPO_PUBLIC_SUPABASE_URL e EXPO_PUBLIC_SUPABASE_ANON_KEY
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? 'https://your-project-ref.supabase.co';
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

async function prompt(question, { hidden = false } = {}) {
  if (hidden) {
    // Hide input for password by muting stdout writes during typing
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    process.stdout.write(question);
    // @ts-ignore - hack to hide input
    rl._writeToOutput = () => {};
    const answer = await new Promise((resolve) => rl.once('line', resolve));
    rl.close();
    process.stdout.write('\n');
    return answer.trim();
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

let [, , email, password] = process.argv;

if (!email) {
  email = await prompt('Email: ');
}
if (!password) {
  password = await prompt('Senha (não aparece ao digitar): ', { hidden: true });
}

if (!email || !password) {
  console.error('Email e senha são obrigatórios.');
  process.exit(1);
}

async function login() {
  const res = await fetch(
    `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: {
        apikey: ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    }
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Login falhou: ${res.status} ${t}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function callChat(jwt) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/openai-chat`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 5,
    }),
  });
  return res.status;
}

(async () => {
  console.log('────────────────────────────────────────────');
  console.log(`Fazendo login: ${email}...`);
  const jwt = await login();
  console.log('✓ Login OK');
  console.log('');
  console.log('Disparando 25 requisições rápidas em openai-chat...');
  console.log('Esperado: ~20 primeiras = 200, depois = 429');
  console.log('────────────────────────────────────────────');

  let pass = 0;
  let rate429 = 0;
  let other = 0;

  for (let i = 1; i <= 25; i++) {
    const status = await callChat(jwt);
    if (status === 200) {
      pass++;
      console.log(`  [${i.toString().padStart(2)}] HTTP ${status}  ✓`);
    } else if (status === 429) {
      rate429++;
      console.log(`  [${i.toString().padStart(2)}] HTTP ${status}  ⛔ rate-limited`);
    } else {
      other++;
      console.log(`  [${i.toString().padStart(2)}] HTTP ${status}  ⚠ unexpected`);
    }
  }

  console.log('────────────────────────────────────────────');
  console.log('Resultado:');
  console.log(`  ✓ Sucesso (200):       ${pass}`);
  console.log(`  ⛔ Rate-limited (429): ${rate429}`);
  console.log(`  ⚠ Outros erros:        ${other}`);
  console.log('────────────────────────────────────────────');

  if (rate429 > 0 && pass >= 15) {
    console.log('✅ Rate limit FUNCIONANDO — bloqueou após ~20 requests');
  } else if (rate429 === 0) {
    console.log('❌ Rate limit NÃO está funcionando (nenhum 429)');
  } else {
    console.log('⚠ Comportamento inesperado — investigar');
  }
})().catch((err) => {
  console.error('ERRO:', err.message);
  process.exit(1);
});
