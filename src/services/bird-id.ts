// Bird ID — Assinatura Digital ICP-Brasil via cloud HSM
//
// Bird ID é um serviço de certificado digital em nuvem (Certisign/ITI) que
// permite assinar documentos usando um certificado ICP-Brasil armazenado
// em HSM remoto, autenticado por um token de sessão OAuth2.
//
// ── Tipo de token: signature_session ───────────────────────────────────────
// Um `signature_session` é um token OAuth específico do Bird ID que:
//   • Permite múltiplas assinaturas em múltiplas chamadas à API
//   • Permanece válido dentro do prazo de expiração configurado
//   • Pode ser revogado pelo app ou pelo próprio usuário
//   • É distinto de um access_token genérico — tem escopo "sign" implícito
//
// Fluxo de uso neste app:
//   1. Usuário obtém um signature_session no portal Bird ID ou via OAuth2
//      (grant_type=password + scope=signature_session).
//   2. Cola o token em Configurações → Assinatura Digital.
//   3. O app valida e exibe o nome do titular + data de expiração.
//   4. Ao exportar um PDF → "Exportar PDF assinado" no menu.
//   5. O PDF é enviado ao endpoint PAdES; Bird ID assina e retorna.
//   6. O arquivo assinado é compartilhado e o temporário é deletado.
//
// Referência de endpoints:
//   GET  /v0/oauth/userinfo   — valida o token e retorna dados do titular
//   POST /v0/pades/sign       — assina um PDF (PAdES) com o certificado
//
// NOTA: Se os endpoints mudarem, atualize BIRD_ID_BASE e os paths abaixo.

import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system/legacy';

// ── Constantes ──────────────────────────────────────────────────────────────
const TOKEN_KEY     = '@voice_ai/bird_id_session_token/v1';
const META_KEY      = '@voice_ai/bird_id_session_meta/v1';
export const BIRD_ID_BASE = 'https://api.birdid.com.br/v0';

// ── Tipos ────────────────────────────────────────────────────────────────────

export interface BirdIdUserInfo {
  /** Nome completo do titular do certificado. */
  name: string;
  /** CPF do titular (pode vir como `sub` no JWT). */
  cpf: string;
  /** E-mail opcional. */
  email?: string;
  /** Data/hora de expiração do signature_session (ISO 8601), se disponível. */
  expiresAt?: string;
}

interface SessionMeta {
  /** Quando o token foi salvo (ISO 8601). */
  savedAt: string;
  /** Nome do titular — cacheado para exibir sem nova chamada de rede. */
  holderName: string;
  /** CPF do titular — cacheado. */
  holderCpf: string;
  /** Expiração da sessão reportada pelo Bird ID, se disponível. */
  expiresAt?: string;
}

// ── Token storage ────────────────────────────────────────────────────────────

/**
 * Recupera o signature_session Bird ID salvo no SecureStore.
 * Retorna null se não estiver configurado.
 */
export async function getBirdIdToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

/**
 * Salva o signature_session Bearer do Bird ID no SecureStore
 * e registra o timestamp de quando foi armazenado.
 */
export async function setBirdIdToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token.trim());
}

/** Remove o signature_session e os metadados de sessão. */
export async function clearBirdIdToken(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(TOKEN_KEY),
    SecureStore.deleteItemAsync(META_KEY),
  ]);
}

// ── Session metadata ─────────────────────────────────────────────────────────

/** Persiste metadados de sessão (nome, CPF, expiração) após validação. */
async function saveSessionMeta(meta: SessionMeta): Promise<void> {
  await SecureStore.setItemAsync(META_KEY, JSON.stringify(meta));
}

/**
 * Recupera os metadados da sessão sem fazer chamada de rede.
 * Útil para exibir o nome do titular nas configurações na inicialização.
 */
export async function getSessionMeta(): Promise<SessionMeta | null> {
  try {
    const raw = await SecureStore.getItemAsync(META_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SessionMeta;
  } catch {
    return null;
  }
}

/**
 * Retorna true se a sessão salva está expirada (baseado em `expiresAt`).
 * Retorna false se não há informação de expiração (assume ainda válido).
 */
export function isSessionExpired(meta: SessionMeta): boolean {
  if (!meta.expiresAt) return false;
  return new Date(meta.expiresAt) < new Date();
}

// ── Validação do token ───────────────────────────────────────────────────────

/**
 * Valida um signature_session chamando o endpoint de userinfo do Bird ID.
 * Em caso de sucesso, persiste os metadados de sessão para uso offline.
 *
 * Lança um Error descritivo se o token for inválido, expirado ou revogado.
 */
export async function validateBirdIdToken(token: string): Promise<BirdIdUserInfo> {
  const res = await fetch(`${BIRD_ID_BASE}/oauth/userinfo`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error_description ?? body?.error ?? body?.message ?? '';
    } catch {
      detail = await res.text().catch(() => '');
    }
    if (res.status === 401) {
      throw new Error(
        'Signature session inválida ou expirada. Gere uma nova sessão no portal Bird ID.'
      );
    }
    throw new Error(
      `Erro ao validar signature_session (HTTP ${res.status})${detail ? `: ${detail}` : ''}.`
    );
  }

  const json = await res.json();

  // O Bird ID pode retornar o userinfo em diferentes formatos.
  // Campos comuns: sub (CPF), name, cpf, email, exp (unix timestamp).
  const name: string = json.name ?? json.nome ?? json.commonName ?? json.cn ?? '';
  const cpf: string  = json.cpf ?? json.document ?? json.sub ?? '';
  const email: string | undefined = json.email ?? undefined;

  // `exp` (seconds since epoch) ou `expires_at` (ISO string)
  let expiresAt: string | undefined;
  if (json.exp && typeof json.exp === 'number') {
    expiresAt = new Date(json.exp * 1000).toISOString();
  } else if (json.expires_at) {
    expiresAt = json.expires_at;
  } else if (json.expiration) {
    expiresAt = json.expiration;
  }

  // Persistir metadados para exibição offline
  await saveSessionMeta({
    savedAt: new Date().toISOString(),
    holderName: name,
    holderCpf: cpf,
    expiresAt,
  });

  return { name, cpf, email, expiresAt };
}

// ── Assinatura de PDF ────────────────────────────────────────────────────────

export interface SignPdfResult {
  /** URI local do PDF assinado (salvo no cacheDirectory do app). */
  uri: string;
}

/**
 * Assina um PDF usando o certificado ICP-Brasil via Bird ID signature_session.
 *
 * O PDF é enviado ao endpoint PAdES; Bird ID assina com o certificado em HSM
 * e retorna o documento assinado. O mesmo signature_session pode ser
 * reutilizado para múltiplas assinaturas enquanto estiver dentro do prazo.
 *
 * @param pdfUri  URI local do PDF gerado por expo-print.
 * @param token   signature_session Bearer do Bird ID (ainda válido).
 */
export async function signPdfWithBirdId(
  pdfUri: string,
  token: string
): Promise<SignPdfResult> {
  // 1. Montar o multipart/form-data com o arquivo PDF
  const formData = new FormData();
  formData.append('file', {
    uri: pdfUri,
    name: 'document.pdf',
    type: 'application/pdf',
  } as any);

  // 2. Enviar para o endpoint PAdES do Bird ID
  const res = await fetch(`${BIRD_ID_BASE}/pades/sign`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      // Content-Type NÃO deve ser definido manualmente com FormData —
      // o fetch injetará o boundary correto automaticamente.
    },
    body: formData,
  });

  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error_description ?? body?.error ?? body?.message ?? '';
    } catch {
      detail = await res.text().catch(() => '');
    }

    if (res.status === 401) {
      throw new Error(
        'Signature session expirada ou revogada. Gere uma nova sessão em Configurações → Assinatura Digital.'
      );
    }
    if (res.status === 403) {
      throw new Error(
        'Acesso negado pelo Bird ID. Verifique se a signature_session tem permissão para assinar.'
      );
    }
    throw new Error(
      `Falha na assinatura Bird ID (HTTP ${res.status})${detail ? `: ${detail}` : ''}.`
    );
  }

  // 3. O Bird ID pode retornar o PDF assinado de duas formas:
  //    a) application/pdf binário diretamente no body
  //    b) JSON com o conteúdo base64 em um campo como "signed_content"
  const contentType = res.headers.get('content-type') ?? '';
  let signedBase64: string;

  if (
    contentType.includes('application/pdf') ||
    contentType.includes('application/octet-stream')
  ) {
    // Resposta binária → converter para base64
    const arrayBuffer = await res.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    bytes.forEach((b) => { binary += String.fromCharCode(b); });
    signedBase64 = btoa(binary);
  } else {
    // JSON com conteúdo base64
    const json = await res.json();
    signedBase64 =
      json.signed_content ??
      json.signedContent ??
      json.content ??
      json.file ??
      json.data;
    if (!signedBase64) {
      throw new Error(
        'Resposta inesperada do Bird ID: campo "signed_content" não encontrado na resposta JSON.'
      );
    }
  }

  // 4. Gravar o PDF assinado no cacheDirectory do app
  const safeDir = FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? '';
  const outPath = `${safeDir}evopad_signed_${Date.now()}.pdf`;
  await FileSystem.writeAsStringAsync(outPath, signedBase64, {
    encoding: FileSystem.EncodingType.Base64,
  });

  return { uri: outPath };
}

// ── Utilitários ──────────────────────────────────────────────────────────────

/**
 * Exclui um arquivo PDF temporário do cache (best-effort).
 * Não lança erro se o arquivo já tiver sido removido.
 */
export async function cleanupTempPdf(uri: string): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists) await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // ignorar — arquivo temporário, sem impacto funcional
  }
}

/**
 * Formata a data de expiração para exibição humana.
 * Ex.: "31/05/2026 às 18:00"
 */
export function formatSessionExpiry(expiresAt: string): string {
  const d = new Date(expiresAt);
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
