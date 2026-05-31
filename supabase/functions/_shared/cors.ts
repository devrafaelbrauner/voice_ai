// CORS headers used by all edge functions.
//
// Seg #4: substituímos '*' por origens explícitas.
// - Apps React Native não enviam Origin (sem browser CORS), então esta lista
//   afeta apenas clientes web (EvoPad web, localhost dev).
// - Mantemos '*' apenas para OPTIONS preflight, pois o payload
//   real é protegido por JWT (auth.getUser() valida o token).
//
// Para adicionar origens novas: edite ALLOWED_ORIGINS abaixo e faça deploy.
const ALLOWED_ORIGINS = [
  'https://evopad.app',          // produção web
  'http://localhost:8081',        // expo web dev
  'http://localhost:3000',        // next.js dev
];

function getAllowOrigin(requestOrigin: string | null): string {
  if (!requestOrigin) return ALLOWED_ORIGINS[0]; // sem Origin → cliente mobile/server
  return ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : '';
}

/** Retorna os headers CORS corretos para uma dada requisição. */
export function buildCorsHeaders(requestOrigin: string | null): Record<string, string> {
  const allowOrigin = getAllowOrigin(requestOrigin);
  return {
    'Access-Control-Allow-Origin': allowOrigin || ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type, x-audio-bytes',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    ...(allowOrigin ? { 'Vary': 'Origin' } : {}),
  };
}

// Compatibilidade retroativa: header fixo para preflight (sem Origin de cliente mobile)
export const corsHeaders = buildCorsHeaders(null);
