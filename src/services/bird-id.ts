// Bird ID — Assinatura Digital ICP-Brasil via cloud HSM
//
// Bird ID é um serviço de certificado digital em nuvem (Certisign) que
// permite assinar documentos usando um certificado ICP-Brasil armazenado
// em HSM remoto, autenticado por Bearer token OAuth2.
//
// Fluxo de uso neste app:
//   1. Usuário obtém um Bearer token na plataforma Bird ID (portal web ou
//      app Bird ID) com scope "sign".
//   2. Cola o token em Configurações → Assinatura Digital.
//   3. O app valida o token e exibe o nome do titular do certificado.
//   4. Ao exportar um PDF, aparece a opção "Assinar com Bird ID".
//   5. O PDF é enviado ao endpoint de assinatura PAdES do Bird ID.
//   6. O arquivo assinado é retornado e compartilhado.
//
// Referência de endpoints:
//   https://api.birdid.com.br/v0/oauth/userinfo  (GET — valida o token)
//   https://api.birdid.com.br/v0/pades/sign       (POST — assina um PDF)
//
// NOTA: Se os endpoints mudarem, atualize BIRD_ID_BASE e os paths abaixo.

import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system/legacy';

// ── Constantes ──────────────────────────────────────────────────────────────
const TOKEN_KEY = '@voice_ai/bird_id_token/v1';
export const BIRD_ID_BASE = 'https://api.birdid.com.br/v0';

// ── Token storage ────────────────────────────────────────────────────────────

/** Recupera o token Bird ID salvo no SecureStore (null se não configurado). */
export async function getBirdIdToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

/** Salva o token Bearer do Bird ID no SecureStore. */
export async function setBirdIdToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token.trim());
}

/** Remove o token Bird ID do SecureStore. */
export async function clearBirdIdToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

// ── User info ────────────────────────────────────────────────────────────────

export interface BirdIdUserInfo {
  /** Nome completo do titular do certificado. */
  name: string;
  /** CPF do titular (pode vir como `sub` no JWT). */
  cpf: string;
  /** E-mail opcional. */
  email?: string;
}

/**
 * Valida um token Bearer chamando o endpoint de userinfo do Bird ID.
 * Lança um Error descritivo se o token for inválido ou expirado.
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
      throw new Error('Token inválido ou expirado. Obtenha um novo token no portal Bird ID.');
    }
    throw new Error(
      `Erro ao validar token Bird ID (HTTP ${res.status})${detail ? `: ${detail}` : ''}.`
    );
  }

  const json = await res.json();

  // O Bird ID pode retornar diferentes formatos dependendo do grant type usado.
  // Normalmente: { sub, name, cpf, email, ... }
  const name: string =
    json.name ?? json.nome ?? json.commonName ?? json.cn ?? '';
  const cpf: string =
    json.cpf ?? json.document ?? json.sub ?? '';
  const email: string | undefined = json.email ?? undefined;

  return { name, cpf, email };
}

// ── PDF signing ──────────────────────────────────────────────────────────────

export interface SignPdfResult {
  /** URI local do PDF assinado (salvo no cacheDirectory do app). */
  uri: string;
}

/**
 * Assina um PDF usando o certificado ICP-Brasil armazenado no Bird ID.
 *
 * O PDF é lido do dispositivo, enviado ao endpoint PAdES do Bird ID e o
 * arquivo assinado é gravado no cacheDirectory, retornando o URI final.
 *
 * @param pdfUri  URI local do PDF gerado por expo-print.
 * @param token   Bearer token Bird ID com scope "sign".
 */
export async function signPdfWithBirdId(
  pdfUri: string,
  token: string
): Promise<SignPdfResult> {
  // 1. Ler o PDF como base64
  const pdfBase64 = await FileSystem.readAsStringAsync(pdfUri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  // 2. Enviar para o endpoint PAdES do Bird ID
  //    O Bird ID espera multipart/form-data com o campo "file".
  //    A resposta é o PDF assinado em base64 ou binário.
  const formData = new FormData();
  formData.append('file', {
    uri: pdfUri,
    name: 'document.pdf',
    type: 'application/pdf',
  } as any);

  const res = await fetch(`${BIRD_ID_BASE}/pades/sign`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      // Não definir Content-Type manualmente — o fetch injeta o boundary correto
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
        'Token Bird ID inválido ou expirado. Atualize o token em Configurações → Assinatura Digital.'
      );
    }
    if (res.status === 403) {
      throw new Error(
        'Sem permissão para assinar com este token. Verifique se ele tem o scope "sign".'
      );
    }
    throw new Error(
      `Falha na assinatura Bird ID (HTTP ${res.status})${detail ? `: ${detail}` : ''}.`
    );
  }

  // 3. O Bird ID pode retornar o PDF assinado de duas formas:
  //    a) application/pdf binário (direto no body)
  //    b) JSON com campo "signed_content" em base64
  const contentType = res.headers.get('content-type') ?? '';

  let signedBase64: string;

  if (contentType.includes('application/pdf') || contentType.includes('application/octet-stream')) {
    // Resposta binária — converter para base64
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
        'Resposta inesperada do Bird ID: campo signed_content não encontrado.'
      );
    }
  }

  // 4. Salvar o PDF assinado em cache
  const safeDir = FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? '';
  const outPath = `${safeDir}evopad_signed_${Date.now()}.pdf`;
  await FileSystem.writeAsStringAsync(outPath, signedBase64, {
    encoding: FileSystem.EncodingType.Base64,
  });

  return { uri: outPath };
}

/**
 * Limpa um arquivo PDF temporário do cache (best-effort).
 * Não lança erro se o arquivo já foi removido.
 */
export async function cleanupTempPdf(uri: string): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists) await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // ignorar — arquivo temporário, sem impacto funcional
  }
}
