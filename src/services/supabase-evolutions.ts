import { supabase } from './supabase';
import { logError } from './log';

export interface Evolution {
  id: string;
  doctor_id: string;
  patient_name: string;
  patient_birthdate?: string;
  patient_health_plan?: string;

  audio_uri: string;
  transcript: string;
  summary: string;

  template_used: string;
  cids?: string[];

  doctor_name: string;
  doctor_crm: string;
  doctor_rqe?: string;

  status: 'draft' | 'finalized' | 'exported';
  exported_to_evopad: boolean;
  exported_at?: string;

  created_at: string;
  updated_at: string;
}

/**
 * Salva uma evolução no Supabase após transcrição + processamento
 */
export async function saveEvolution(data: {
  patient_name: string;
  transcript: string;
  summary: string;
  template_used: string;
  audio_uri: string;
  doctor_name: string;
  doctor_crm: string;
  cids?: string[];
  patient_birthdate?: string;
  patient_health_plan?: string;
  doctor_rqe?: string;
}): Promise<Evolution | null> {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error('Usuário não autenticado');

    const evolution = {
      doctor_id: user.id,
      ...data,
      status: 'draft',
      exported_to_evopad: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data: result, error } = await supabase
      .from('evolutions')
      .insert([evolution])
      .select()
      .single();

    if (error) throw error;
    return result as Evolution;
  } catch (err) {
    logError('saveEvolution', err);
    return null;
  }
}

/**
 * Carrega evoluções de um paciente específico
 */
export async function getEvolutions(patientName: string): Promise<Evolution[]> {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return [];

    const { data, error } = await supabase
      .from('evolutions')
      .select('*')
      .eq('doctor_id', user.id)
      .eq('patient_name', patientName)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return (data || []) as Evolution[];
  } catch (err) {
    logError('getEvolutions', err);
    return [];
  }
}

/**
 * Marca uma evolução como exportada para EvoPad
 */
export async function markAsExportedToEvoPad(evolutionId: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('evolutions')
      .update({
        exported_to_evopad: true,
        exported_at: new Date().toISOString(),
        status: 'finalized',
        updated_at: new Date().toISOString(),
      })
      .eq('id', evolutionId);

    if (error) throw error;
    return true;
  } catch (err) {
    logError('markAsExportedToEvoPad', err);
    return false;
  }
}

/**
 * Atualiza uma evolução (ex: após editar transcrição)
 */
export async function updateEvolution(
  evolutionId: string,
  updates: Partial<Evolution>
): Promise<Evolution | null> {
  try {
    const { data, error } = await supabase
      .from('evolutions')
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq('id', evolutionId)
      .select()
      .single();

    if (error) throw error;
    return data as Evolution;
  } catch (err) {
    logError('updateEvolution', err);
    return null;
  }
}

/**
 * Deleta uma evolução
 */
export async function deleteEvolution(evolutionId: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('evolutions')
      .delete()
      .eq('id', evolutionId);

    if (error) throw error;
    return true;
  } catch (err) {
    logError('deleteEvolution', err);
    return false;
  }
}

/**
 * Obtém todas as evoluções não-exportadas
 */
export async function getUnexportedEvolutions(): Promise<Evolution[]> {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return [];

    const { data, error } = await supabase
      .from('evolutions')
      .select('*')
      .eq('doctor_id', user.id)
      .eq('exported_to_evopad', false)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return (data || []) as Evolution[];
  } catch (err) {
    logError('getUnexportedEvolutions', err);
    return [];
  }
}

/**
 * Formata evolução para enviar ao EvoPad web
 */
export function formatEvolutionForEvoPad(evo: Evolution): Record<string, any> {
  return {
    type: 'evolution',
    source: 'voice-ai-recorder',
    patient: {
      name: evo.patient_name,
      birthDate: evo.patient_birthdate,
      healthPlan: evo.patient_health_plan,
    },
    content: {
      transcript: evo.transcript,
      summary: evo.summary,
      template: evo.template_used,
      cids: evo.cids || [],
    },
    doctor: {
      name: evo.doctor_name,
      crm: evo.doctor_crm,
      rqe: evo.doctor_rqe,
    },
    metadata: {
      audioUri: evo.audio_uri,
      recordingSource: 'voice-ai-recorder',
      timestamp: evo.created_at,
      exportedAt: new Date().toISOString(),
    },
  };
}
