/**
 * openai-shared.ts — Constantes e utilitários compartilhados entre
 * openai.ts (chamadas diretas) e openai-proxy.ts (Edge Functions Supabase).
 *
 * Centraliza aqui para evitar drift entre as duas cópias:
 *   - WHISPER_MEDICAL_PROMPT  (#8)
 *   - isReasoningModel        (#10)
 *   - needsCompletionTokens   (#10)
 *   - buildChatBody           (#10)
 */

// ─── Prompt Whisper (≤ 224 tokens) ────────────────────────────────────────────
//
// Texto no formato de consulta médica real para guiar a grafia correta de
// nomes comerciais e princípios ativos — reduz erros fonéticos do STT antes
// do LLM. Mapeamentos marca→princípio ativo são EXATOS.
export const WHISPER_MEDICAL_PROMPT =
  'Receita médica: Clavulin BD (Amoxicilina + Clavulanato), Amoxil, Novamox, Clavomax. ' +
  'Zitromax (Azitromicina), Keflex (Cefalexina), Cipro (Ciprofloxacino), ' +
  'Bactrim (Sulfametoxazol + Trimetoprima), Flagyl (Metronidazol), Doxiciclina. ' +
  'Profenid (Cetoprofeno), Voltaren (Diclofenaco), Cataflan (Diclofenaco Potássico), ' +
  'Nimesil (Nimesulida), Arcoxia (Etoricoxibe), Feldene (Piroxicam), Toragesic (Cetorolaco). ' +
  'Novalgina (Dipirona Sódica), Tylenol (Paracetamol), Advil (Ibuprofeno), Alivium. ' +
  'Dorflex (Orfenadrina + Cafeína + Dipirona). ' +
  'Decadron (Dexametasona), Predsim (Prednisona), Bentelan (Betametasona), Medrol (Metilprednisolona). ' +
  'Losec (Omeprazol), Pantozol (Pantoprazol), Nexium (Esomeprazol), Lanzol (Lansoprazol). ' +
  'Plasil (Metoclopramida), Buscopan (Escopolamina), Vonau (Ondansetrona). ' +
  'Rivotril (Clonazepam), Frontal (Alprazolam), Valium (Diazepam), Lexotan (Bromazepam), ' +
  'Lorax (Lorazepam), Stilnox (Zolpidem), Lyrica (Pregabalina), Gardenal (Fenobarbital). ' +
  'Ritalina (Metilfenidato), Concerta, Vyvanse (Lisdexanfetamina). ' +
  'Tramal (Tramadol), Morfina, Dimorf, Fentanil, Durogesic, Oxycontin (Oxicodona). ' +
  'Allegra (Fexofenadina), Loratamed (Loratadina), Zyrtec (Cetirizina), Hixizine (Hidroxizina). ' +
  'Glifage (Metformina), Januvia (Sitagliptina), Ozempic (Semaglutida), Jardiance (Empagliflozina). ' +
  'Crestor (Rosuvastatina), Ator (Atorvastatina), Zocor (Sinvastatina). ' +
  'Losartana, Cozaar, Diovan (Valsartana), Captopril, Enalapril, Amlodipina, Norvasc. ' +
  'Furosemida, Lasix, Hidroclorotiazida, Espironolactona, Aldactone, Carvedilol, Bisoprolol. ' +
  'Pulmicort (Budesonida), Symbicort, Seretide (Salmeterol + Fluticasona), Berotec (Fenoterol), ' +
  'Atrovent (Ipratrópio), Aerolin (Salbutamol), Spiriva (Tiotrópio). ' +
  'Puran T4 (Levotiroxina), Tapazol (Metimazol). ' +
  'Xarelto (Rivaroxabana), Eliquis (Apixabana), Pradaxa (Dabigatrana), Marevan (Warfarina). ' +
  'CID-10. Via oral, sublingual, intravenosa, intramuscular, subcutânea, tópica, inalatória. ' +
  'Comprimido, cápsula, ampola, frasco, bisnaga, sachê, supositório, adesivo transdérmico.';

// ─── Compatibilidade de parâmetros entre modelos OpenAI ──────────────────────
//
// Modelos mais novos (gpt-5.x, o1, o3, o4) usam max_completion_tokens em vez
// de max_tokens. Modelos o1 não suportam temperature (fixo em 1).

/** True para modelos "reasoning" da série o1/o3/o4. */
export function isReasoningModel(apiModelId: string): boolean {
  return /^o[1-9][\-.]/.test(apiModelId) || /^o[1-9]$/.test(apiModelId);
}

/** True para modelos que exigem max_completion_tokens em vez de max_tokens. */
export function needsCompletionTokens(apiModelId: string): boolean {
  if (isReasoningModel(apiModelId)) return true;
  if (/^gpt-5/.test(apiModelId)) return true;
  return false;
}

/**
 * Monta o corpo JSON para chat/completions de forma compatível com o modelo.
 * - max_tokens              → modelos clássicos (gpt-4o, gpt-4o-mini, gpt-4…)
 * - max_completion_tokens   → modelos novos (o1, o3, o4, gpt-5.x)
 * - temperature omitido     → modelos o1 (não suportam o parâmetro)
 */
export function buildChatBody(
  apiModelId: string,
  messages: { role: string; content: string }[],
  temperature: number,
  maxTokens: number,
): Record<string, unknown> {
  const reasoning = isReasoningModel(apiModelId);
  const completionTokens = needsCompletionTokens(apiModelId);

  return {
    model: apiModelId,
    messages,
    ...(reasoning ? {} : { temperature }),
    ...(completionTokens
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens }),
  };
}
