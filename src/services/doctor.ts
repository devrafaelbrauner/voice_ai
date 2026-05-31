import * as SecureStore from 'expo-secure-store';

const KEYS = {
  name: 'doctor_name',
  title: 'doctor_title',
  crmNumber: 'doctor_crm_number',
  crmUF: 'doctor_crm_uf',
  address: 'doctor_address',
  phone: 'doctor_phone',
  city: 'doctor_city',
  professionalEnabled: 'profile_professional_enabled',
};

let changeListener: (() => void) | null = null;

export function setDoctorChangeListener(cb: (() => void) | null) {
  changeListener = cb;
}

function notifyChange() {
  try {
    changeListener?.();
  } catch {}
}

export interface DoctorProfile {
  name: string;
  title: string;
  crmNumber: string;
  crmUF: string;
  address: string;
  phone: string;
  city: string;
  professionalEnabled: boolean;
}

export async function getDoctorProfile(): Promise<DoctorProfile> {
  const [name, title, crmNumber, crmUF, address, phone, city, professionalEnabled] = await Promise.all([
    SecureStore.getItemAsync(KEYS.name),
    SecureStore.getItemAsync(KEYS.title),
    SecureStore.getItemAsync(KEYS.crmNumber),
    SecureStore.getItemAsync(KEYS.crmUF),
    SecureStore.getItemAsync(KEYS.address),
    SecureStore.getItemAsync(KEYS.phone),
    SecureStore.getItemAsync(KEYS.city),
    SecureStore.getItemAsync(KEYS.professionalEnabled),
  ]);

  let resolvedCRMNumber = crmNumber ?? '';
  let resolvedCRMUF = crmUF ?? '';

  // Migração one-time: se não há crmNumber mas existe registration antigo, parsear
  if (!resolvedCRMNumber) {
    const oldReg = await SecureStore.getItemAsync('doctor_registration');
    if (oldReg) {
      const m = oldReg.match(/(\d+)\s*([A-Z]{2})?/i);
      if (m) {
        resolvedCRMNumber = m[1];
        resolvedCRMUF = (m[2] ?? '').toUpperCase();
        if (!resolvedCRMUF) {
          const upper = oldReg.toUpperCase();
          if (upper.includes('CREMEC')) resolvedCRMUF = 'CE';
          else if (upper.includes('CREMESP')) resolvedCRMUF = 'SP';
          else if (upper.includes('CREMERJ')) resolvedCRMUF = 'RJ';
          else if (upper.includes('CREMEPE')) resolvedCRMUF = 'PE';
          else if (upper.includes('CREMERS')) resolvedCRMUF = 'RS';
          else if (upper.includes('CRMMG')) resolvedCRMUF = 'MG';
        }
        // Persiste pra próxima execução
        await SecureStore.setItemAsync(KEYS.crmNumber, resolvedCRMNumber);
        if (resolvedCRMUF) await SecureStore.setItemAsync(KEYS.crmUF, resolvedCRMUF);
      }
    }
  }

  // Migração: se professionalEnabled nunca foi definido mas já existem dados profissionais,
  // assume que o perfil profissional está ativo (preserva comportamento anterior).
  let resolvedProfessional = professionalEnabled === 'true';
  if (professionalEnabled === null) {
    const hasProfessionalData = Boolean(
      resolvedCRMNumber || title || address || city
    );
    resolvedProfessional = hasProfessionalData;
    if (hasProfessionalData) {
      await SecureStore.setItemAsync(KEYS.professionalEnabled, 'true');
    }
  }

  return {
    name: name ?? '',
    title: title ?? '',
    crmNumber: resolvedCRMNumber,
    crmUF: resolvedCRMUF,
    address: address ?? '',
    phone: phone ?? '',
    city: city ?? '',
    professionalEnabled: resolvedProfessional,
  };
}

export async function setDoctorProfile(profile: Partial<DoctorProfile>): Promise<void> {
  if (profile.name !== undefined)
    await SecureStore.setItemAsync(KEYS.name, profile.name);
  if (profile.title !== undefined)
    await SecureStore.setItemAsync(KEYS.title, profile.title);
  if (profile.crmNumber !== undefined)
    await SecureStore.setItemAsync(KEYS.crmNumber, profile.crmNumber);
  if (profile.crmUF !== undefined)
    await SecureStore.setItemAsync(KEYS.crmUF, profile.crmUF.toUpperCase());
  if (profile.address !== undefined)
    await SecureStore.setItemAsync(KEYS.address, profile.address);
  if (profile.phone !== undefined)
    await SecureStore.setItemAsync(KEYS.phone, profile.phone);
  if (profile.city !== undefined)
    await SecureStore.setItemAsync(KEYS.city, profile.city);
  if (profile.professionalEnabled !== undefined)
    await SecureStore.setItemAsync(
      KEYS.professionalEnabled,
      profile.professionalEnabled ? 'true' : 'false'
    );
  notifyChange();
}

export function formatCRM(p: DoctorProfile): string {
  if (!p.crmNumber || !p.professionalEnabled) return '';
  return `CRM: ${p.crmNumber}${p.crmUF}`;
}

export function formatDoctorHeader(p: DoctorProfile): string {
  const parts = p.professionalEnabled
    ? [p.name, p.title, formatCRM(p)].filter(Boolean)
    : [p.name].filter(Boolean);
  return parts.join(' | ');
}
