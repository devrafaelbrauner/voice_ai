// Backup/export utilities — produces a single JSON file with all recording
// metadata (custom names, transcripts, summaries, patient info) plus the
// user's doctor profile, custom templates, and timestamps.
//
// Audio files are NOT included in the JSON to keep size manageable; they
// remain in the device's documentDirectory. A future v2 could zip them via
// expo-asset-share + JSZip if needed.
//
// Use case: doctor wants a portable record before changing phones, syncing
// to a new account, or providing data export under LGPD Art. 18 (portability).
//
// Security: the sensitive part of the payload (recordings, doctor, templates)
// is AES-256-GCM encrypted using the same device key as the SQLite fields.
// The outer envelope keeps non-sensitive stats visible for inspection.
// File format: JSON envelope with "_voiceai": "encrypted-backup-v1".

import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Alert } from 'react-native';
import {
  getAllRecordingsMeta,
  getCustomTemplates,
  type RecordingMeta,
  type CustomTemplate,
} from './db';
import { getDoctorProfile, type DoctorProfile } from './doctor';
import { encrypt } from './db-crypto';

function isCryptoAvailable(): boolean {
  try {
    return (
      typeof globalThis !== 'undefined' &&
      typeof (globalThis as any).crypto !== 'undefined' &&
      typeof (globalThis as any).crypto.subtle !== 'undefined'
    );
  } catch {
    return false;
  }
}

const BACKUP_VERSION = 1;

/**
 * Encrypted envelope written to disk.
 * Non-sensitive stats remain readable; the sensitive payload is AES-256-GCM encrypted.
 */
export interface EncryptedBackupEnvelope {
  _voiceai: 'encrypted-backup-v1';
  exportedAt: string;
  /** Plaintext stats for quick inspection without decryption */
  stats: BackupPayload['stats'];
  /** AES-256-GCM ciphertext: "enc1:<iv_b64>:<ct_b64>" (same format as db-crypto) */
  data: string;
}

export interface BackupPayload {
  version: number;
  exportedAt: string;
  app: 'voice-ai-recorder';
  doctor: DoctorProfile | null;
  recordings: (RecordingMeta & { createdAt: string | null })[];
  customTemplates: CustomTemplate[];
  stats: {
    totalRecordings: number;
    transcribed: number;
    processed: number;
    finalized: number;
    uniquePatients: number;
  };
}

/**
 * Build the backup payload from local storage.
 */
export async function buildBackup(): Promise<BackupPayload> {
  const metaMap = await getAllRecordingsMeta();
  const doctor = await getDoctorProfile().catch(() => null);
  const customTemplates = await getCustomTemplates().catch(() => []);

  // Enumerate audio files in document directory to obtain createdAt
  // (encoded in the filename: recording_<timestamp>.m4a).
  const recordings: BackupPayload['recordings'] = [];
  const patientSet = new Set<string>();
  let transcribed = 0;
  let processed = 0;
  let finalized = 0;

  for (const [fileName, meta] of metaMap.entries()) {
    const match = fileName.match(/recording_(\d+)\.m4a/);
    const createdAt = match ? new Date(parseInt(match[1])).toISOString() : null;

    recordings.push({
      ...meta,
      createdAt,
    });

    if (meta.transcript) transcribed++;
    if (meta.summary) processed++;
    if (meta.summary && meta.transcript) finalized++;
    if (meta.patientName) patientSet.add(meta.patientName);
  }

  // Sort by createdAt descending (newest first) for readability
  recordings.sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });

  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    app: 'voice-ai-recorder',
    doctor,
    recordings,
    customTemplates,
    stats: {
      totalRecordings: recordings.length,
      transcribed,
      processed,
      finalized,
      uniquePatients: patientSet.size,
    },
  };
}

/**
 * Export the backup to an AES-256-GCM encrypted JSON file and open the share sheet.
 *
 * The file is an EncryptedBackupEnvelope: non-sensitive stats are readable,
 * while recordings/templates/doctor data is encrypted with the device's AES key.
 * If crypto.subtle is unavailable (rare), falls back to unencrypted export with a warning.
 */
export async function exportBackup(): Promise<void> {
  try {
    const payload = await buildBackup();

    if (payload.recordings.length === 0) {
      Alert.alert(
        'Nada para exportar',
        'Você ainda não tem gravações cadastradas no aplicativo.'
      );
      return;
    }

    const dir = FileSystem.cacheDirectory;
    if (!dir) {
      throw new Error('Diretório de cache indisponível');
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const encrypted = isCryptoAvailable();

    let fileContent: string;
    let fileName: string;
    let mimeType: string;
    let uti: string;
    let dialogSuffix: string;

    if (encrypted) {
      // Encrypt only the sensitive part of the payload
      const sensitiveData = {
        doctor: payload.doctor,
        recordings: payload.recordings,
        customTemplates: payload.customTemplates,
      };
      const encryptedData = await encrypt(JSON.stringify(sensitiveData));

      const envelope: EncryptedBackupEnvelope = {
        _voiceai: 'encrypted-backup-v1',
        exportedAt: payload.exportedAt,
        stats: payload.stats,
        data: encryptedData,
      };
      fileContent = JSON.stringify(envelope, null, 2);
      fileName = `voice-ai-recorder-backup-${stamp}.enc.json`;
      mimeType = 'application/json';
      uti = 'public.json';
      dialogSuffix = ' (cifrado AES-256)';
    } else {
      // Fallback: export plain JSON with a warning
      fileContent = JSON.stringify(payload, null, 2);
      fileName = `voice-ai-recorder-backup-${stamp}.json`;
      mimeType = 'application/json';
      uti = 'public.json';
      dialogSuffix = ' ⚠️ sem cifração';
    }

    const path = `${dir}${fileName}`;
    await FileSystem.writeAsStringAsync(path, fileContent, {
      encoding: FileSystem.EncodingType.UTF8,
    });

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(path, {
        mimeType,
        dialogTitle: `Backup com ${payload.recordings.length} gravação(ões)${dialogSuffix}`,
        UTI: uti,
      });
    } else {
      Alert.alert(
        encrypted ? 'Backup cifrado gerado' : 'Backup gerado (sem cifração)',
        `Arquivo salvo em:\n${path}\n\nNenhum app de compartilhamento disponível.`
      );
    }
  } catch (err: any) {
    Alert.alert(
      'Erro ao gerar backup',
      err?.message ?? String(err)
    );
  }
}

/**
 * Tiny summary for use in UI (e.g. "12 gravações, 8 transcritas, 5 finalizadas")
 */
export function describeBackup(payload: BackupPayload): string {
  const s = payload.stats;
  const parts: string[] = [`${s.totalRecordings} gravação(ões)`];
  if (s.transcribed > 0) parts.push(`${s.transcribed} transcrita(s)`);
  if (s.finalized > 0) parts.push(`${s.finalized} finalizada(s)`);
  if (s.uniquePatients > 0) parts.push(`${s.uniquePatients} paciente(s)`);
  return parts.join(', ');
}
