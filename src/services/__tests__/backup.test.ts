// Backup cifrado v2: scrypt + AES-GCM NATIVOS (react-native-quick-crypto), aqui substituído
// por node:crypto real (jest.setup.js); o @noble é usado só como implementação de REFERÊNCIA
// independente (compatibilidade de formato nos dois sentidos). SQL real (node:sqlite) e dois
// "aparelhos" (registries de módulo separados, cada um com seu banco e sua chave).
import nodeCrypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { gcm } from '@noble/ciphers/aes.js';
import * as DocumentPicker from 'expo-document-picker';
import type * as SharingModule from 'expo-sharing';
import {
  BackupPassphraseError,
  decryptBackupText,
  encryptBackupPayload,
  pickBackupFile,
  restoreBackup,
  validatePassphrase,
  type BackupPayload,
} from '../backup';
import * as BackupModule from '../backup';
import type * as DbModule from '../db';
import type * as DoctorModule from '../doctor';
import type * as DbCryptoModule from '../db-crypto';

declare global {
  var __fakeFs: Map<string, string | { size: number }>;
}
// share.ts puxa componentes de UI; só createExportFile importa aqui (grava no FS em memória). Como o
// real, cada chamada ganha um diretório próprio (token), então o nome do arquivo nunca colide pelo caminho.
let mockExportSeq = 0;
jest.mock('../share', () => ({
  __esModule: true,
  createExportFile: (name: string) => {
    const { File } = jest.requireMock('expo-file-system');
    const file = new File(`file:///cache/exports/tok${++mockExportSeq}/${name}`);
    file.create();
    return file;
  },
}));

const PASS = 'cavalo-grampo-lua-1987';
const MB = 1024 * 1024;
const fakeFs = (): Map<string, string | { size: number }> => globalThis.__fakeFs;

const TRANSCRIPT = 'Paciente Maria Aparecida relata cefaleia há três dias.';
const SUMMARY = 'Resumo clínico: cefaleia tensional, conduta dipirona.';
const PATIENT = 'Maria Aparecida';
const CUSTOM = 'Consulta da Maria';
const TEMPLATE_PROMPT = 'Prompt confidencial do consultório Dr. Silva';
const DOCTOR_NAME = 'Dr. Roberto Silva';
const SECRETS = [TRANSCRIPT, SUMMARY, PATIENT, CUSTOM, TEMPLATE_PROMPT, DOCTOR_NAME, 'cefaleia', 'dipirona'];

function samplePayload(): BackupPayload {
  return {
    version: 2,
    exportedAt: '2025-06-01T12:00:00.000Z',
    app: 'voice-ai-recorder',
    doctor: null,
    recordings: [
      {
        fileName: 'recording_1717243200000.m4a',
        customName: CUSTOM,
        transcript: TRANSCRIPT,
        summary: SUMMARY,
        templateId: null,
        patientName: PATIENT,
        durationSecs: 30,
        updatedAt: '2025-06-01T12:00:00.000Z',
        createdAt: '2024-06-01T12:00:00.000Z',
      },
    ],
    customTemplates: [],
    stats: { totalRecordings: 1, transcribed: 1, processed: 1, finalized: 1, uniquePatients: 1 },
    unreadableItems: 0,
  };
}

interface Device {
  backup: typeof BackupModule;
  db: typeof DbModule;
  doctor: typeof DoctorModule;
  sharing: typeof SharingModule;
}

/** Um aparelho novo: banco :memory: vazio, chave AES própria, SecureStore vazio. */
function newDevice(): Device {
  jest.resetModules();
  return {
    backup: jest.requireActual<typeof BackupModule>('../backup'),
    db: jest.requireActual<typeof DbModule>('../db'),
    doctor: jest.requireActual<typeof DoctorModule>('../doctor'),
    // Mesmo registry do backup.ts: é nesta instância que o shareAsync é chamado.
    sharing: jest.requireMock('expo-sharing'),
  };
}

const rawSqlite = async (d: Device) => ((await d.db.getDb()) as unknown as { raw: DatabaseSync }).raw;

function putFile(uri: string, text: string) {
  fakeFs().set(uri, text);
}

function mutate(text: string, fn: (env: Record<string, any>) => void): string {
  const env = JSON.parse(text);
  fn(env);
  return JSON.stringify(env);
}

const REC = 'recording_1717243200000.m4a';
async function seed(d: Device) {
  await d.db.setField(REC, 'transcript', TRANSCRIPT);
  await d.db.updateFieldIfExists(REC, 'summary', SUMMARY);
  await d.db.updateFieldIfExists(REC, 'patientName', PATIENT);
  await d.db.updateFieldIfExists(REC, 'customName', CUSTOM);
  await d.db.updateFieldIfExists(REC, 'durationSecs', '30');
  await d.db.createCustomTemplate('Meu modelo', 'descrição', TEMPLATE_PROMPT);
  await d.doctor.setDoctorProfile({ name: DOCTOR_NAME, crmNumber: '12345', crmUF: 'sp', professionalEnabled: true });
}

describe('senha', () => {
  test.each([
    ['curta (<12)', 'Ab1!xyz'],
    ['11 caracteres bons mas curtos', 'cavalo-lua-'],
    ['blocklist exata', 'backupvoiceai'],
    ['blocklist + dígitos finais', 'Brasil123456'],
    ['blocklist com acento/símbolos', 'Senha-Segura!!'],
    ['poucos caracteres distintos', 'aaaaaaaaaaaaaa'],
    ['sequência numérica', '123456789012'],
    ['bloco repetido', 'abcabcabcabc'],
    ['bloco repetido com acento/caixa', 'MÉDICO médico'],
  ])('recusa senha fraca: %s', (_label, pass) => {
    expect(validatePassphrase(pass)).toEqual(expect.any(String));
  });

  test('aceita frase longa e incomum', () => {
    expect(validatePassphrase(PASS)).toBeNull();
    expect(validatePassphrase('o cavalo comeu a bateria às 3h')).toBeNull();
  });

  test('exportBackup com senha fraca falha antes de ler/gravar qualquer coisa', async () => {
    const d = newDevice();
    await seed(d);
    const before = fakeFs().size;
    await expect(d.backup.exportBackup('backupvoiceai')).rejects.toThrow(/fraca/);
    expect(fakeFs().size).toBe(before);
    expect(d.sharing.shareAsync).not.toHaveBeenCalled();
  });

  test('a mesma frase digitada decomposta (NFD) e composta (NFC) abre o mesmo backup', async () => {
    const composed = 'ação-segura-até-amanhã';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);
    const file = await encryptBackupPayload(samplePayload(), composed);
    await expect(decryptBackupText(file, decomposed)).resolves.toMatchObject({ app: 'voice-ai-recorder' });
  });
});

describe('envelope cifrado: integridade', () => {
  let file: string;
  beforeAll(async () => {
    file = await encryptBackupPayload(samplePayload(), PASS);
  });

  test('senha certa devolve o payload original', async () => {
    const out = (await decryptBackupText(file, PASS)) as BackupPayload;
    expect(out.recordings[0]).toMatchObject({ fileName: REC, transcript: TRANSCRIPT, patientName: PATIENT });
  });

  test('senha errada é rejeitada com BackupPassphraseError sem vazar a senha', async () => {
    const err = await decryptBackupText(file, `${PASS}x`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackupPassphraseError);
    expect((err as Error).message).not.toContain(PASS);
  });

  test('byte adulterado no ciphertext é rejeitado', async () => {
    const bad = mutate(file, (env) => {
      const bytes = Buffer.from(env.data_b64, 'base64');
      bytes[Math.floor(bytes.length / 2)] ^= 0x01;
      env.data_b64 = bytes.toString('base64');
    });
    await expect(decryptBackupText(bad, PASS)).rejects.toBeInstanceOf(BackupPassphraseError);
  });

  test('truncar o ciphertext (tag GCM cortada) é rejeitado', async () => {
    const bad = mutate(file, (env) => {
      env.data_b64 = Buffer.from(env.data_b64, 'base64').subarray(0, -4).toString('base64');
    });
    await expect(decryptBackupText(bad, PASS)).rejects.toBeInstanceOf(BackupPassphraseError);
  });

  test.each([
    ['exportedAt', (env: Record<string, any>) => { env.exportedAt = '2025-06-02T12:00:00.000Z'; }],
    ['stats.totalRecordings', (env: Record<string, any>) => { env.stats.totalRecordings = 999; }],
    ['stats.uniquePatients', (env: Record<string, any>) => { env.stats.uniquePatients = 0; }],
  ])('cabeçalho adulterado (%s, só AAD) é rejeitado', async (_name, tweak) => {
    await expect(decryptBackupText(mutate(file, tweak), PASS)).rejects.toBeInstanceOf(BackupPassphraseError);
  });

  test('nonce adulterado é rejeitado', async () => {
    const bad = mutate(file, (env) => {
      const n = Buffer.from(env.cipher.nonce_b64, 'base64');
      n[0] ^= 0xff;
      env.cipher.nonce_b64 = n.toString('base64');
    });
    await expect(decryptBackupText(bad, PASS)).rejects.toBeInstanceOf(BackupPassphraseError);
  });

  test.each([
    ['N=2^20 (1 GiB de memória)', (env: Record<string, any>) => { env.kdf.N = 2 ** 20; }],
    ['N=2^15 (fora da allow-list)', (env: Record<string, any>) => { env.kdf.N = 2 ** 15; }],
    ['N=2^10 (barato demais)', (env: Record<string, any>) => { env.kdf.N = 2 ** 10; }],
    ['r=16', (env: Record<string, any>) => { env.kdf.r = 16; }],
    ['p=4', (env: Record<string, any>) => { env.kdf.p = 4; }],
    ['KDF desconhecido', (env: Record<string, any>) => { env.kdf.name = 'pbkdf2'; }],
    ['N como string', (env: Record<string, any>) => { env.kdf.N = '16384'; }],
    ['cifra desconhecida', (env: Record<string, any>) => { env.cipher.name = 'aes-128-cbc'; }],
  ])('KDF/cifra fora da allow-list é rejeitado ANTES de derivar chave: %s', async (_name, tweak) => {
    const err = await decryptBackupText(mutate(file, tweak), PASS).catch((e: unknown) => e);
    // Não é "senha errada": o parâmetro é recusado antes de gastar CPU/memória (N=2^20 = 1 GiB).
    expect(err).not.toBeInstanceOf(BackupPassphraseError);
    expect((err as Error).message).toMatch(/não suportados/);
  });

  test('N=2^16 (permitido, custo maior) abre normalmente', async () => {
    // Arquivo montado "à mão" como o de um app com custo maior (formato do cabeçalho: ver AAD em backup.ts).
    const salt = Buffer.alloc(16, 7);
    const nonce = Buffer.alloc(12, 9);
    const stats = samplePayload().stats;
    const kdf = { name: 'scrypt', N: 2 ** 16, r: 8, p: 1, salt_b64: salt.toString('base64') };
    const nonceB64 = nonce.toString('base64');
    const aad = new TextEncoder().encode(
      JSON.stringify(['voiceai-backup', 2, '2025-06-01T12:00:00.000Z', stats, 'scrypt', kdf.N, 8, 1, kdf.salt_b64, nonceB64])
    );
    const key = await scryptAsync(PASS, salt, { N: kdf.N, r: 8, p: 1, dkLen: 32 });
    const { doctor, recordings, customTemplates, version, app, exportedAt } = samplePayload();
    const plain = new TextEncoder().encode(JSON.stringify({ version, app, exportedAt, doctor, recordings, customTemplates }));
    const env = {
      _voiceai: 'encrypted-backup-v2',
      version: 2,
      exportedAt,
      stats,
      kdf,
      cipher: { name: 'aes-256-gcm', nonce_b64: nonceB64 },
      data_b64: Buffer.from(gcm(key, nonce, aad).encrypt(plain)).toString('base64'),
    };
    const out = (await decryptBackupText(JSON.stringify(env), PASS)) as BackupPayload;
    expect(out.recordings).toHaveLength(1);
  });

  test('cada exportação usa salt e nonce novos (nonce repetido quebraria o GCM)', async () => {
    const other = await encryptBackupPayload(samplePayload(), PASS);
    const a = JSON.parse(file);
    const b = JSON.parse(other);
    expect(b.kdf.salt_b64).not.toBe(a.kdf.salt_b64);
    expect(b.cipher.nonce_b64).not.toBe(a.cipher.nonce_b64);
    expect(b.data_b64).not.toBe(a.data_b64);
  });

  test('o arquivo não contém nenhum texto sensível em claro (nem em base64 trivial)', () => {
    const base64OfPlain = Buffer.from(JSON.stringify(samplePayload().recordings)).toString('base64');
    for (const secret of SECRETS) expect(file).not.toContain(secret);
    expect(file).not.toContain(base64OfPlain.slice(0, 40));
    // Só metadados contáveis ficam visíveis no cabeçalho.
    expect(Object.keys(JSON.parse(file)).sort()).toEqual(
      ['_voiceai', 'cipher', 'data_b64', 'exportedAt', 'kdf', 'stats', 'version']
    );
  });
});

describe('formatos recusados na restauração', () => {
  const URI = 'file:///cache/picked/backup.json';

  test('backup v1 (formato antigo, sem senha) é recusado e nada é restaurado', async () => {
    const d = newDevice();
    const v1 = JSON.stringify({ _voiceai: 'encrypted-backup-v1', version: 1, data_b64: 'AAAA' });
    putFile(URI, v1);
    await expect(d.backup.restoreBackup(URI, PASS)).rejects.toThrow(/formato antigo/);
    expect((await d.db.getBackupCounts()).recordings).toBe(0);
  });

  test('JSON em texto puro (sem envelope) não é restaurado, mesmo com gravações dentro', async () => {
    const d = newDevice();
    putFile(
      URI,
      JSON.stringify({ version: 2, app: 'voice-ai-recorder', recordings: [{ fileName: REC, transcript: TRANSCRIPT }] })
    );
    await expect(d.backup.restoreBackup(URI, PASS)).rejects.toThrow(/não é um backup/);
    expect((await d.db.getBackupCounts()).recordings).toBe(0);
  });

  test('lixo / JSON inválido / vazio dão erro legível, sem travar', async () => {
    for (const text of ['', 'não sou json', '[]', 'null', '{"_voiceai":"encrypted-backup-v2","version":2}']) {
      putFile(URI, text);
      await expect(decryptBackupText(text, PASS)).rejects.toThrow(/inválido|incompleto|suportados/i);
    }
  });

  test('arquivo > 50 MB é recusado pelo tamanho, sem tentar ler o conteúdo', async () => {
    fakeFs().set(URI, { size: 50 * MB + 1 }); // text() lançaria outro erro se a checagem faltasse
    await expect(restoreBackup(URI, PASS)).rejects.toThrow(/mais de 50 MB/);
  });

  test('arquivo inexistente: erro claro', async () => {
    await expect(restoreBackup('file:///cache/nao-existe.json', PASS)).rejects.toThrow(/não encontrado/);
  });
});

describe('seletor de arquivo (limite de 50 MB)', () => {
  const picker = DocumentPicker.getDocumentAsync as jest.Mock;
  const CACHE_COPY = 'file:///cache/DocumentPicker/backup.enc.json';

  test('asset acima de 50 MB: erro e a cópia temporária é apagada do cache', async () => {
    fakeFs().set(CACHE_COPY, { size: 60 * MB });
    picker.mockResolvedValueOnce({ canceled: false, assets: [{ uri: CACHE_COPY, name: 'b.json', size: 60 * MB }] });
    await expect(pickBackupFile()).rejects.toThrow(/mais de 50 MB/);
    expect(fakeFs().has(CACHE_COPY)).toBe(false);
  });

  test('sem size no asset: usa o tamanho real da cópia (e apaga se passar de 50 MB)', async () => {
    fakeFs().set(CACHE_COPY, { size: 51 * MB });
    picker.mockResolvedValueOnce({ canceled: false, assets: [{ uri: CACHE_COPY, name: 'b.json' }] });
    await expect(pickBackupFile()).rejects.toThrow(/mais de 50 MB/);
    expect(fakeFs().has(CACHE_COPY)).toBe(false);
  });

  test('arquivo pequeno passa e a cópia é mantida; cancelar devolve null', async () => {
    putFile(CACHE_COPY, '{}');
    picker.mockResolvedValueOnce({ canceled: false, assets: [{ uri: CACHE_COPY, name: 'b.json' }] });
    await expect(pickBackupFile()).resolves.toEqual({ uri: CACHE_COPY, name: 'b.json' });
    expect(fakeFs().has(CACHE_COPY)).toBe(true);
    picker.mockResolvedValueOnce({ canceled: true, assets: null });
    await expect(pickBackupFile()).resolves.toBeNull();
  });

  test('arquivo grande fora do cache do app NÃO é apagado (não é cópia nossa)', async () => {
    const original = 'file:///doc/meu-arquivo-gigante.bin';
    fakeFs().set(original, { size: 60 * MB });
    picker.mockResolvedValueOnce({ canceled: false, assets: [{ uri: original, name: 'x', size: 60 * MB }] });
    await expect(pickBackupFile()).rejects.toThrow(/mais de 50 MB/);
    expect(fakeFs().has(original)).toBe(true);
  });
});

describe('exportar → restaurar em outro aparelho', () => {
  const PICKED = 'file:///cache/DocumentPicker/in.enc.json';

  async function exportFrom(d: Device): Promise<string> {
    await seed(d);
    const out = await d.backup.exportBackup(PASS);
    expect(out).toMatchObject({ status: 'shared', recordings: 1, templates: 1, unreadable: 0 });
    expect(d.sharing.shareAsync).toHaveBeenCalledWith(out.path, expect.any(Object));
    return fakeFs().get(out.path!) as string;
  }

  test('round-trip completo; o arquivo exportado não tem texto puro; a chave do aparelho B é recifrada', async () => {
    const A = newDevice();
    const text = await exportFrom(A);
    for (const secret of SECRETS) expect(text).not.toContain(secret);

    const B = newDevice();
    putFile(PICKED, text);
    const res = await B.backup.restoreBackup(PICKED, PASS);

    expect(res).toEqual({ restoredRecordings: 1, restoredTemplates: 1, alreadyPresent: 0, unreadable: 0, doctorRestored: true });
    const meta = (await B.db.getAllRecordingsMeta()).get(REC);
    expect(meta).toMatchObject({ transcript: TRANSCRIPT, summary: SUMMARY, patientName: PATIENT, customName: CUSTOM, durationSecs: 30 });
    const [tpl] = await B.db.getCustomTemplates();
    expect(tpl).toMatchObject({ name: 'Meu modelo', systemPrompt: TEMPLATE_PROMPT });
    expect(await B.doctor.getDoctorProfile()).toMatchObject({ name: DOCTOR_NAME, crmNumber: '12345', crmUF: 'SP', professionalEnabled: true });
    // No disco de B está cifrado com a chave de B.
    const raw = (await rawSqlite(B)).prepare('SELECT transcript, summary FROM recordings').get() as Record<string, string>;
    expect(raw.transcript).toMatch(/^enc1:/);
    expect(JSON.stringify(raw)).not.toContain('cefaleia');
    // Cópia temporária descartada após o sucesso (estava no cache do app).
    expect(fakeFs().has(PICKED)).toBe(false);
  });

  test('senha errada: rejeita, não restaura nada e mantém o arquivo para nova tentativa', async () => {
    const A = newDevice();
    const text = await exportFrom(A);
    const B = newDevice();
    putFile(PICKED, text);

    await expect(B.backup.restoreBackup(PICKED, 'outra-frase-qualquer-123')).rejects.toMatchObject({
      name: 'BackupPassphraseError',
    });
    expect(await B.db.getBackupCounts()).toEqual({ recordings: 0, transcribed: 0, finalized: 0, templates: 0 });
    expect(fakeFs().has(PICKED)).toBe(true);
    await expect(B.backup.restoreBackup(PICKED, PASS)).resolves.toMatchObject({ restoredRecordings: 1 });
  });

  test('restaurar duas vezes não duplica nem sobrescreve (alreadyPresent)', async () => {
    const A = newDevice();
    const text = await exportFrom(A);
    const B = newDevice();
    putFile(PICKED, text);
    await B.backup.restoreBackup(PICKED, PASS);
    await B.db.updateFieldIfExists(REC, 'transcript', 'edição local posterior');

    putFile(PICKED, text);
    const second = await B.backup.restoreBackup(PICKED, PASS);

    expect(second).toMatchObject({ restoredRecordings: 0, restoredTemplates: 0, alreadyPresent: 2 });
    expect(await B.db.getField(REC, 'transcript')).toBe('edição local posterior');
    expect((await B.db.getBackupCounts()).recordings).toBe(1);
  });

  test('linha local existente mas vazia não conta como "já existia": é preenchida', async () => {
    const A = newDevice();
    const text = await exportFrom(A);
    const B = newDevice();
    (await rawSqlite(B)).prepare("INSERT INTO recordings (fileName, updatedAt) VALUES (?, '2025-01-01')").run(REC);
    putFile(PICKED, text);
    const res = await B.backup.restoreBackup(PICKED, PASS);
    expect(res.restoredRecordings).toBe(1);
    expect(await B.db.getField(REC, 'transcript')).toBe(TRANSCRIPT);
  });

  test('restaurar item que o usuário excluiu limpa o tombstone (o sync não apaga o item restaurado do remoto)', async () => {
    const A = newDevice();
    const text = await exportFrom(A);
    const B = newDevice();
    await B.db.setField(REC, 'transcript', 'versão antiga');
    await B.db.deleteRecordingMeta(REC);
    expect(await B.db.getPendingDeletions()).toHaveLength(1);

    putFile(PICKED, text);
    await B.backup.restoreBackup(PICKED, PASS);

    expect(await B.db.getField(REC, 'transcript')).toBe(TRANSCRIPT);
    expect((await B.db.getPendingDeletions()).filter((p) => p.kind === 'recording')).toEqual([]);
  });

  test('perfil profissional local preenchido não é sobrescrito pelo do backup', async () => {
    const A = newDevice();
    const text = await exportFrom(A);
    const B = newDevice();
    await B.doctor.setDoctorProfile({ name: 'Dra. Local' });
    putFile(PICKED, text);
    const res = await B.backup.restoreBackup(PICKED, PASS);
    expect(res.doctorRestored).toBe(false);
    expect((await B.doctor.getDoctorProfile()).name).toBe('Dra. Local');
  });

  test('tudo-ou-nada: falha no meio da restauração desfaz as gravações já inseridas', async () => {
    const A = newDevice();
    const text = await exportFrom(A);
    const B = newDevice();
    (await rawSqlite(B)).exec(
      "CREATE TRIGGER boom BEFORE INSERT ON custom_templates BEGIN SELECT RAISE(ABORT, 'falha simulada'); END;"
    );
    putFile(PICKED, text);

    await expect(B.backup.restoreBackup(PICKED, PASS)).rejects.toThrow(/falha simulada/);
    expect((await B.db.getBackupCounts()).recordings).toBe(0);
    expect(fakeFs().has(PICKED)).toBe(true);
  });

  test('exportar banco vazio não gera arquivo nem abre o compartilhamento', async () => {
    const A = newDevice();
    const before = fakeFs().size;
    await expect(A.backup.exportBackup(PASS)).resolves.toMatchObject({ status: 'empty' });
    expect(fakeFs().size).toBe(before);
    expect(A.sharing.shareAsync).not.toHaveBeenCalled();
  });

  test('campos ilegíveis (chave perdida/dado corrompido) não vão para o backup e cada item conta uma vez', async () => {
    const A = newDevice();
    await A.db.setField('r1.m4a', 'transcript', 'ok-1');
    await A.db.updateFieldIfExists('r1.m4a', 'summary', 'resumo-1');
    await A.db.setField('r2.m4a', 'transcript', 'ok-2');
    await A.db.updateFieldIfExists('r2.m4a', 'summary', 'resumo-2');
    const raw = await rawSqlite(A);
    raw.exec("UPDATE recordings SET transcript = 'enc1:AAAA:BBBB' WHERE fileName = 'r1.m4a'");
    raw.exec("UPDATE recordings SET transcript = 'enc1:AAAA:BBBB', summary = 'enc1:AAAA:BBBB' WHERE fileName = 'r2.m4a'");

    const out = await A.backup.exportBackup(PASS);
    expect(out).toMatchObject({ status: 'shared', recordings: 2, templates: 0, unreadable: 2 });
    const file = fakeFs().get(out.path!) as string;
    const payload = (await decryptBackupText(file, PASS)) as BackupPayload;

    const byName = new Map(payload.recordings.map((r) => [r.fileName, r]));
    expect(byName.get('r1.m4a')).toMatchObject({ transcript: null, summary: 'resumo-1' });
    expect(byName.get('r2.m4a')).toMatchObject({ transcript: null, summary: null });
    expect(JSON.stringify(payload)).not.toContain('__DECRYPT_FAILED__');
    expect(JSON.parse(file).stats).toEqual({ totalRecordings: 2, transcribed: 0, processed: 1, finalized: 0, uniquePatients: 0 });
  });

  test('ordem (mais recentes primeiro; sem data no nome por último, empate na ordem de inserção) e stats no cabeçalho', async () => {
    const A = newDevice();
    for (const [name, patient] of [
      ['sem-data.m4a', 'Ana'],
      ['recording_100.m4a', 'Bia'],
      ['recording_300.m4a', 'Ana'],
      ['recording_200.m4a', ''],
      ['outro-sem-data.m4a', 'Caio'],
    ]) {
      await A.db.setField(name, 'transcript', `texto ${name}`);
      if (patient) await A.db.updateFieldIfExists(name, 'patientName', patient);
    }
    const out = await A.backup.exportBackup(PASS);
    const file = fakeFs().get(out.path!) as string;
    const payload = (await decryptBackupText(file, PASS)) as BackupPayload;
    expect(payload.recordings.map((r) => r.fileName)).toEqual([
      'recording_300.m4a', 'recording_200.m4a', 'recording_100.m4a', 'sem-data.m4a', 'outro-sem-data.m4a',
    ]);
    expect(payload.recordings[0].createdAt).toBe(new Date(300).toISOString());
    expect(payload.recordings[3].createdAt).toBeNull();
    expect(JSON.parse(file).stats).toEqual({ totalRecordings: 5, transcribed: 5, processed: 0, finalized: 0, uniquePatients: 3 });
  });

  test('getBackupSummary descreve só o que existe (contagem SQL)', async () => {
    const A = newDevice();
    expect(await A.backup.getBackupSummary()).toBe('0 gravação(ões)');
    await seed(A);
    expect(await A.backup.getBackupSummary()).toBe('1 gravação(ões), 1 transcrita(s), 1 finalizada(s), 1 template(s)');
  });
});

describe('arquivo de backup hostil (assinado com a senha certa, conteúdo malicioso)', () => {
  const PICKED = 'file:///cache/DocumentPicker/hostile.enc.json';

  test('nomes com path traversal, sentinelas de falha e tipos errados são descartados; o resto entra', async () => {
    const good = samplePayload().recordings[0];
    const evil = {
      ...samplePayload(),
      recordings: [
        good,
        { ...good, fileName: '../../etc/passwd' },
        { ...good, fileName: 'sub/dir.m4a' },
        { ...good, fileName: 'a'.repeat(300) },
        { fileName: 'so_sentinela.m4a', transcript: '__DECRYPT_FAILED__' },
        { fileName: 'sem_conteudo.m4a' },
        { fileName: 'tipo_errado.m4a', transcript: 12345 },
        'não sou objeto',
        null,
      ],
      customTemplates: [
        { id: 'tpl ruim com espaço', name: 'n', systemPrompt: 'p' },
        { id: 'tpl_sem_prompt', name: 'n', systemPrompt: '' },
        { id: 'tpl_ok', name: 'Modelo', systemPrompt: 'Prompt', description: null, createdAt: '2025-01-01T00:00:00.000Z' },
      ],
    } as unknown as BackupPayload;
    const B = newDevice();
    putFile(PICKED, await B.backup.encryptBackupPayload(evil, PASS));

    const res = await B.backup.restoreBackup(PICKED, PASS);

    // 8 gravações inválidas (traversal, subdir, nome longo, só sentinela, vazia, tipo errado, 2 não-objetos) + 2 templates.
    expect(res).toMatchObject({ restoredRecordings: 1, restoredTemplates: 1, unreadable: 10 });
    const names = [...(await B.db.getAllRecordingsMeta()).keys()];
    expect(names).toEqual([REC]);
    expect((await B.db.getCustomTemplates()).map((t) => t.id)).toEqual(['tpl_ok']);
  });
});

// ─── Cripto nativa: compatibilidade de formato com o @noble, limite de 50 MB, módulo ausente ──

interface QuickCryptoMock {
  scrypt: jest.Mock;
  createCipheriv: jest.Mock;
  createDecipheriv: jest.Mock;
  bufferToString: jest.Mock;
  stringToBuffer: jest.Mock;
}
const nativeMock = (): QuickCryptoMock => jest.requireMock('react-native-quick-crypto');

/** Decifra um envelope v2 com a implementação de referência (@noble, JS puro), independente do código do app. */
async function nobleOpenText(text: string, pass: string): Promise<string> {
  const env = JSON.parse(text);
  const aad = new TextEncoder().encode(
    JSON.stringify([
      'voiceai-backup', 2, env.exportedAt, env.stats,
      env.kdf.name, env.kdf.N, env.kdf.r, env.kdf.p, env.kdf.salt_b64, env.cipher.nonce_b64,
    ])
  );
  const key = await scryptAsync(pass.normalize('NFKC'), Buffer.from(env.kdf.salt_b64, 'base64'), {
    N: env.kdf.N, r: env.kdf.r, p: env.kdf.p, dkLen: 32,
  });
  const plain = gcm(key, Buffer.from(env.cipher.nonce_b64, 'base64'), aad).decrypt(Buffer.from(env.data_b64, 'base64'));
  return new TextDecoder().decode(plain);
}

const nobleOpen = async (text: string, pass: string): Promise<any> => JSON.parse(await nobleOpenText(text, pass));

describe('compatibilidade do envelope v2 (código antigo em @noble <-> código nativo)', () => {
  // Gerado pelo código ANTERIOR (encryptBackupPayload com @noble/hashes + @noble/ciphers), senha PASS.
  const OLD_ENVELOPE = fs.readFileSync(path.join(__dirname, 'fixtures', 'backup-v2-noble.json'), 'utf8');

  test('envelope gerado pelo código antigo (@noble) é restaurado pelo código nativo', async () => {
    const out = (await decryptBackupText(OLD_ENVELOPE, PASS)) as BackupPayload;
    expect(out.recordings).toHaveLength(1);
    expect(out.recordings[0]).toMatchObject({
      fileName: REC,
      customName: CUSTOM,
      summary: SUMMARY,
      patientName: PATIENT,
      transcript: `${TRANSCRIPT} Ação: não há — 😀`,
    });
  });

  test('o mesmo envelope antigo com senha errada ou adulterado continua sendo recusado', async () => {
    await expect(decryptBackupText(OLD_ENVELOPE, `${PASS}x`)).rejects.toBeInstanceOf(BackupPassphraseError);
    const bad = mutate(OLD_ENVELOPE, (env) => { env.stats.finalized = 0; });
    await expect(decryptBackupText(bad, PASS)).rejects.toBeInstanceOf(BackupPassphraseError);
  });

  test('envelope gerado pelo código nativo abre no código antigo (referência @noble)', async () => {
    const text = await encryptBackupPayload(samplePayload(), PASS);
    const opened = await nobleOpen(text, PASS);
    expect(opened.recordings[0]).toMatchObject({ fileName: REC, transcript: TRANSCRIPT, patientName: PATIENT });
    // O layout é o do @noble: data_b64 = ciphertext || tag de 16 bytes (decifrável sem nenhum ajuste).
    expect(JSON.parse(text).kdf).toMatchObject({ name: 'scrypt', N: 2 ** 14, r: 8, p: 1 });
  });

  test('o KDF nativo é chamado de forma assíncrona (callback) com N/r/p da allow-list, maxmem folgado e senha em bytes UTF-8', async () => {
    const { backup } = newDevice();
    const { scrypt } = nativeMock();
    let passwordAtCall = '';
    scrypt.mockImplementationOnce((pw: Uint8Array, ...rest: unknown[]) => {
      passwordAtCall = Buffer.from(pw).toString('utf8'); // o app zera a senha em bytes assim que o KDF termina
      return (nodeCrypto.scrypt as (...a: unknown[]) => void)(pw, ...rest);
    });
    await backup.decryptBackupText(OLD_ENVELOPE, PASS.normalize('NFD'));
    expect(scrypt).toHaveBeenCalledTimes(1);
    const [password, salt, keylen, opts, cb] = scrypt.mock.calls[0];
    expect(passwordAtCall).toBe(PASS); // senha em bytes UTF-8 (a normalização NFKC tem teste próprio acima)
    expect([...password].every((b) => b === 0)).toBe(true);
    expect(salt).toHaveLength(16);
    expect(keylen).toBe(32);
    expect(opts).toMatchObject({ N: 2 ** 14, r: 8, p: 1 });
    expect(opts.maxmem).toBeGreaterThanOrEqual(128 * 8 * 2 ** 16);
    expect(typeof cb).toBe('function'); // nunca a variante *Sync
  });

  test('arquivo grande (~30 MB de payload) faz round-trip pelo caminho nativo', async () => {
    const big = samplePayload();
    big.recordings[0].transcript = 'á'.repeat(15 * MB); // 2 bytes UTF-8 por caractere
    const text = await encryptBackupPayload(big, PASS);
    expect(text.length).toBeLessThan(50 * MB);
    const out = (await decryptBackupText(text, PASS)) as BackupPayload;
    expect(out.recordings[0].transcript).toHaveLength(15 * MB);
  });
});

/** Envelope v2 válido (senha PASS, N=2^14) cujo plaintext são BYTES arbitrários, cifrado por node:crypto. */
function envelopeFromBytes(plain: Uint8Array): string {
  const salt = Buffer.alloc(16, 5);
  const nonce = Buffer.alloc(12, 6);
  const stats = samplePayload().stats;
  const exportedAt = '2025-06-01T12:00:00.000Z';
  const kdf = { name: 'scrypt', N: 2 ** 14, r: 8, p: 1, salt_b64: salt.toString('base64') };
  const nonceB64 = nonce.toString('base64');
  const aad = Buffer.from(
    JSON.stringify(['voiceai-backup', 2, exportedAt, stats, 'scrypt', kdf.N, 8, 1, kdf.salt_b64, nonceB64])
  );
  const key = nodeCrypto.scryptSync(PASS.normalize('NFKC'), salt, 32, { N: kdf.N, r: 8, p: 1 });
  const c = nodeCrypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(aad);
  const sealed = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return JSON.stringify({
    _voiceai: 'encrypted-backup-v2',
    version: 2,
    exportedAt,
    stats,
    kdf,
    cipher: { name: 'aes-256-gcm', nonce_b64: nonceB64 },
    data_b64: sealed.toString('base64'),
  });
}

describe('UTF-8 estrito no decode do envelope (conversor nativo, sem TextDecoder)', () => {

  const json = (transcript: string) => Buffer.from(JSON.stringify({ ...samplePayload(), recordings: [{ transcript }] }), 'utf8');

  test('multibyte/emoji de 2, 3 e 4 bytes fazem round-trip; BOM e U+FFFD legítimos não são alterados', async () => {
    const decoder = jest.spyOn(globalThis, 'TextDecoder').mockImplementation(() => {
      throw new Error('TextDecoder não pode estar no caminho de decifra');
    });
    try {
      for (const t of ['ação', '€ 100', '😀👨‍⚕️', '中文', '\ufeffBOM', 'FFFD \ufffd', 'a\u0000b']) {
        const p = { ...samplePayload(), recordings: [{ ...samplePayload().recordings[0], transcript: t }] };
        const out = (await decryptBackupText(await encryptBackupPayload(p, PASS), PASS)) as BackupPayload;
        expect(out.recordings[0].transcript).toBe(t);
      }
    } finally {
      decoder.mockRestore();
    }
  });

  test('o decode cruza as fronteiras de pedaço de 1 MB sem partir caracteres de 3 e 4 bytes', async () => {
    for (const ch of ['€', '😀', 'á']) {
      const transcript = `x${ch.repeat(Math.ceil((1.3 * MB) / Buffer.byteLength(ch)))}`; // 1 byte de deslocamento
      const out = (await decryptBackupText(await encryptBackupPayload({ ...samplePayload(), recordings: [{ ...samplePayload().recordings[0], transcript }] }, PASS), PASS)) as BackupPayload;
      expect(out.recordings[0].transcript === transcript).toBe(true);
    }
  });

  test('plaintext com UTF-8 inválido (senha certa, GCM ok) é recusado como corrompido — não é "senha errada" nem vira U+FFFD', async () => {
    const bad: [string, (b: Buffer) => Buffer][] = [
      ['byte solto 0x80', (b) => Buffer.concat([b.subarray(0, 20), Buffer.from([0x80]), b.subarray(20)])],
      ['0xFF', (b) => Buffer.concat([b.subarray(0, 20), Buffer.from([0xff]), b.subarray(20)])],
      ['overlong C0 AF', (b) => Buffer.concat([b.subarray(0, 20), Buffer.from([0xc0, 0xaf]), b.subarray(20)])],
      ['surrogate ED A0 80', (b) => Buffer.concat([b.subarray(0, 20), Buffer.from([0xed, 0xa0, 0x80]), b.subarray(20)])],
      ['truncado no fim', (b) => b.subarray(0, b.length - 1)],
    ];
    for (const [label, mangle] of bad) {
      const err = await decryptBackupText(envelopeFromBytes(mangle(json('olá'))), PASS).catch((e: unknown) => e);
      expect([label, err instanceof BackupPassphraseError, (err as Error).message]).toEqual([label, false, 'Conteúdo do backup corrompido.']);
    }
    // controle: o mesmo envelope sem alteração abre
    const ok = (await decryptBackupText(envelopeFromBytes(json('olá')), PASS)) as BackupPayload;
    expect(ok.recordings[0].transcript).toBe('olá');
  });

  test('UTF-8 inválido depois da primeira fronteira de 1 MB também é recusado', async () => {
    const head = json('x'.repeat(1.5 * MB));
    const at = Math.floor(1.2 * MB);
    const mangled = Buffer.concat([head.subarray(0, at), Buffer.from([0xc3, 0x28]), head.subarray(at)]);
    await expect(decryptBackupText(envelopeFromBytes(mangled), PASS)).rejects.toThrow('Conteúdo do backup corrompido.');
  });
});

describe('limite de 50 MB: checado ANTES de qualquer KDF/cifra', () => {
  const URI = 'file:///cache/picked/arquivo.json';

  /** Registry novo: o módulo nativo mockado e o backup compartilham a MESMA instância dos spies. */
  function fresh() {
    const d = newDevice();
    return { d, native: nativeMock() };
  }
  /** Garante que o módulo nativo já foi carregado (sonda de cifra) antes de zerar os spies. */
  async function warmUp(d: Device, native: QuickCryptoMock) {
    await d.backup.encryptBackupPayload(samplePayload(), PASS);
    expect(native.scrypt).toHaveBeenCalledTimes(1); // o spy enxerga o backup deste registry (teste não é vácuo)
    native.scrypt.mockClear();
    native.createCipheriv.mockClear();
  }

  test('exportação: payload que estoura o limite falha na hora, sem scrypt nem cifra', async () => {
    const { d, native } = fresh();
    await warmUp(d, native);
    const huge = samplePayload();
    huge.recordings[0].transcript = 'a'.repeat(40 * MB); // 40 MB de payload -> ~53 MB em base64
    const t0 = Date.now();
    await expect(d.backup.encryptBackupPayload(huge, PASS)).rejects.toThrow(/passaria de 50 MB/);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(native.scrypt).not.toHaveBeenCalled();
    expect(native.createCipheriv).not.toHaveBeenCalled();
  });

  test('exportBackup: erro claro, nada é gravado nem compartilhado e o KDF não roda', async () => {
    const { d, native } = fresh();
    // Linha em texto puro (formato legado, lido como está): evita cifrar 40 MB em JS só para montar o cenário.
    (await rawSqlite(d)).prepare('INSERT INTO recordings (fileName, transcript) VALUES (?, ?)').run(REC, 'a'.repeat(40 * MB));
    await expect(d.backup.exportBackup(PASS)).rejects.toThrow(/passaria de 50 MB/);
    expect(native.scrypt).not.toHaveBeenCalled();
    expect(d.sharing.shareAsync).not.toHaveBeenCalled();
    expect([...fakeFs().keys()].filter((k) => k.includes('/exports/'))).toEqual([]);
  });

  test('restauração: arquivo > 50 MB é recusado pelo tamanho, sem ler nem derivar chave', async () => {
    const { d, native } = fresh();
    await warmUp(d, native);
    fakeFs().set(URI, { size: 50 * MB + 1 }); // text() lançaria outro erro se a checagem faltasse
    const t0 = Date.now();
    await expect(d.backup.restoreBackup(URI, PASS)).rejects.toThrow(/mais de 50 MB/);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(native.scrypt).not.toHaveBeenCalled();
  });

  test('decryptBackupText: texto > 50 MB é recusado antes de parsear e sem KDF', async () => {
    const { d, native } = fresh();
    await warmUp(d, native);
    await expect(d.backup.decryptBackupText('x'.repeat(50 * MB + 1), PASS)).rejects.toThrow(/mais de 50 MB/);
    expect(native.scrypt).not.toHaveBeenCalled();
  });

  test('ciphertext curto demais para conter a tag é recusado sem gastar o KDF', async () => {
    const { d, native } = fresh();
    const file = await d.backup.encryptBackupPayload(samplePayload(), PASS);
    native.scrypt.mockClear();
    const bad = mutate(file, (env) => { env.data_b64 = 'AAAA'; });
    await expect(d.backup.decryptBackupText(bad, PASS)).rejects.toThrow(/incompleto|corrompido/);
    expect(native.scrypt).not.toHaveBeenCalled();
  });

  test('base64 inválido (salt) é recusado sem KDF e sem virar "senha errada"', async () => {
    const { d, native } = fresh();
    const file = await d.backup.encryptBackupPayload(samplePayload(), PASS);
    native.scrypt.mockClear();
    const bad = mutate(file, (env) => { env.kdf.salt_b64 = '!!!!!!!!!!!!!!!!'; });
    const err = await d.backup.decryptBackupText(bad, PASS).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(d.backup.BackupPassphraseError);
    expect((err as Error).message).toMatch(/base64/);
    expect(native.scrypt).not.toHaveBeenCalled();
  });

  test('allow-list: parâmetro recusado antes do KDF também não chama o scrypt nativo', async () => {
    const { d, native } = fresh();
    const file = await d.backup.encryptBackupPayload(samplePayload(), PASS);
    native.scrypt.mockClear();
    const bad = mutate(file, (env) => { env.kdf.N = 2 ** 20; });
    await expect(d.backup.decryptBackupText(bad, PASS)).rejects.toThrow(/não suportados/);
    expect(native.scrypt).not.toHaveBeenCalled();
  });
});

describe('módulo nativo ausente (binário sem react-native-quick-crypto)', () => {
  test('exportar e restaurar falham com erro claro: sem JS puro e sem passar por "senha errada"', async () => {
    const file = await encryptBackupPayload(samplePayload(), PASS);
    const { backup } = newDevice();
    const mod = nativeMock();
    const missing = () => { throw new Error('Nitro: HybridObject CipherFactory not found'); };

    mod.createCipheriv.mockImplementationOnce(missing);
    await expect(backup.encryptBackupPayload(samplePayload(), PASS)).rejects.toThrow(/criptografia nativa/i);

    mod.createCipheriv.mockImplementationOnce(missing);
    const err = await backup.decryptBackupText(file, PASS).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(backup.BackupPassphraseError);
    expect((err as Error).message).toMatch(/criptografia nativa/i);
    expect(mod.scrypt).not.toHaveBeenCalled();
  });
});

// ─── Memória: exportar/restaurar em blocos (QA em aparelho: ~1,3–1,4 GB de pico com 36 MB) ───────────
//
// O jest não mede o RSS do Hermes; o que se prova aqui é a CAUSA do pico: nenhum buffer/string do
// tamanho do arquivo (nem do payload) existe em momento algum. Todo dado que cruza uma fronteira
// nativa (cifra, base64, conversor UTF-8, handle do arquivo) e toda fatia entregue ao JSON.parse é
// medido; com ~28 MB de payload o maior item tem de ficar na casa das centenas de KB.

const base64Mock = () => jest.requireMock('react-native-quick-base64') as { toByteArray: jest.Mock; fromByteArray: jest.Mock };
type FakeFileClass = { prototype: { text: () => Promise<string>; write: (...a: unknown[]) => void; open: () => any } };
const fileClass = (): FakeFileClass => jest.requireMock('expo-file-system').File;

const PLAIN_CHUNK = 3 * 65536; // bytes de plaintext por bloco de cifra (192 KiB)
const B64_CHUNK = 4 * 65536; // caracteres base64 por bloco no restore
const bulkName = (i: number) => `recording_${1_700_000_000_000 + i * 1000}.m4a`;
const BULK_TRANSCRIPT = 'Paciente relata cefaleia há três dias, sem febre; conduta: hidratação e dipirona. '.repeat(55);
const BULK_SUMMARY = 'Resumo clínico: cefaleia tensional — orientações dadas. '.repeat(22);

/** `count` gravações de ~5,7 KB de JSON (acentos = UTF-8 multibyte), já cifradas com a chave do aparelho. */
async function seedBulk(d: Device, count: number) {
  const { encrypt } = jest.requireActual<typeof DbCryptoModule>('../db-crypto');
  const [transcript, summary, customName, patientName] = await Promise.all([
    encrypt(BULK_TRANSCRIPT), encrypt(BULK_SUMMARY), encrypt('Consulta de rotina'), encrypt('Maria Aparecida'),
  ]);
  const raw = await rawSqlite(d);
  const insert = raw.prepare(
    'INSERT INTO recordings (fileName, customName, transcript, summary, patientName, durationSecs, updatedAt) VALUES (?, ?, ?, ?, ?, 60, ?)'
  );
  raw.exec('BEGIN');
  for (let i = 0; i < count; i++) insert.run(bulkName(i), customName, transcript, summary, patientName, '2025-06-01T12:00:00.000Z');
  raw.exec('COMMIT');
}

interface Boundaries {
  cipherUpdates: number[];
  decipherUpdates: number[];
  toBytes: number[];
  fromBytes: number[];
  textToBytes: number[];
  bytesToText: number[];
  handleReads: number[];
  handleWrites: number[];
  jsonParse: number[];
  restore(): void;
}

/** Mede o tamanho de tudo que cruza as fronteiras nativas e do que o JSON.parse recebe, a partir de agora. */
function watchBoundaries(): Boundaries {
  const native = nativeMock();
  const b64 = base64Mock();
  const w: Boundaries = {
    cipherUpdates: [], decipherUpdates: [], toBytes: [], fromBytes: [], textToBytes: [], bytesToText: [],
    handleReads: [], handleWrites: [], jsonParse: [], restore: () => {},
  };
  const wrapUpdate = (make: (...a: unknown[]) => any, sizes: number[]) => (...args: unknown[]) => {
    const c = make(...args);
    const update = c.update.bind(c);
    c.update = (data: Uint8Array, ...rest: unknown[]) => {
      sizes.push(data.length);
      return update(data, ...rest);
    };
    return c;
  };
  native.createCipheriv.mockImplementation(wrapUpdate(nodeCrypto.createCipheriv as any, w.cipherUpdates));
  native.createDecipheriv.mockImplementation(wrapUpdate(nodeCrypto.createDecipheriv as any, w.decipherUpdates));
  for (const m of [b64.toByteArray, b64.fromByteArray, native.bufferToString, native.stringToBuffer]) m.mockClear();

  const File = fileClass();
  const originalOpen = File.prototype.open;
  const open = jest.spyOn(File.prototype, 'open').mockImplementation(function (this: unknown) {
    const handle = originalOpen.call(this);
    const { readBytes, writeBytes } = handle;
    handle.readBytes = (length: number) => {
      const out = readBytes.call(handle, length);
      w.handleReads.push(out.length);
      return out;
    };
    handle.writeBytes = (bytes: Uint8Array) => {
      w.handleWrites.push(bytes.length);
      return writeBytes.call(handle, bytes);
    };
    return handle;
  });
  const parse = jest.spyOn(JSON, 'parse');

  w.restore = () => {
    w.toBytes.push(...b64.toByteArray.mock.calls.map(([s]) => (s as string).length));
    w.fromBytes.push(...b64.fromByteArray.mock.calls.map(([u8]) => (u8 as Uint8Array).length));
    w.textToBytes.push(...native.stringToBuffer.mock.calls.map(([s]) => (s as string).length));
    w.bytesToText.push(...native.bufferToString.mock.calls.map(([, , from, to]) => (to as number) - (from as number)));
    w.jsonParse.push(...parse.mock.calls.map(([s]) => String(s).length));
    parse.mockRestore();
    open.mockRestore();
    native.createCipheriv.mockImplementation((...a: unknown[]) => (nodeCrypto.createCipheriv as any)(...a));
    native.createDecipheriv.mockImplementation((...a: unknown[]) => (nodeCrypto.createDecipheriv as any)(...a));
  };
  return w;
}

const maxOf = (xs: number[]) => xs.reduce((a, b) => Math.max(a, b), 0);

describe('exportar e restaurar ~28 MB em blocos: nunca existe uma cópia inteira do arquivo/payload', () => {
  const COUNT = 4800;
  const PICKED = 'file:///cache/DocumentPicker/volume.enc.json';
  let bigFile = '';
  let exportSizes: Boundaries;
  let exportBlocked = { write: 0, text: 0 };

  beforeAll(async () => {
    const A = newDevice();
    await seedBulk(A, COUNT);
    exportSizes = watchBoundaries();
    const write = jest.spyOn(fileClass().prototype, 'write');
    const text = jest.spyOn(fileClass().prototype, 'text');
    try {
      const out = await A.backup.exportBackup(PASS);
      expect(out).toMatchObject({ status: 'shared', recordings: COUNT, unreadable: 0 });
      bigFile = fakeFs().get(out.path!) as string;
    } finally {
      exportSizes.restore();
      exportBlocked = { write: write.mock.calls.length, text: text.mock.calls.length };
      write.mockRestore();
      text.mockRestore();
    }
  }, 120_000);

  test('exportação: payload de ~28 MB sai em blocos de 192 KiB; nada passa de ~256 KB por fronteira e o arquivo não é escrito de uma vez', () => {
    expect(bigFile.length).toBeGreaterThan(35 * MB); // base64 de ~28 MB de JSON
    expect(bigFile.length).toBeLessThan(50 * MB);
    expect(exportSizes.cipherUpdates.length).toBeGreaterThan(140); // ≈ 28 MB / 192 KiB
    expect(maxOf(exportSizes.cipherUpdates)).toBeLessThanOrEqual(PLAIN_CHUNK);
    expect(maxOf(exportSizes.fromBytes)).toBeLessThanOrEqual(PLAIN_CHUNK + 16); // último bloco leva a tag
    expect(maxOf(exportSizes.textToBytes)).toBeLessThanOrEqual(B64_CHUNK + 24);
    expect(maxOf(exportSizes.handleWrites)).toBeLessThanOrEqual(B64_CHUNK + 24);
    expect(exportSizes.handleWrites.length).toBeGreaterThan(140);
    expect(exportBlocked).toEqual({ write: 0, text: 0 }); // File.write(string inteira) nunca é usado
  });

  test('o arquivo exportado em blocos tem o layout de sempre e o conteúdo completo e ordenado', async () => {
    const env = JSON.parse(bigFile);
    expect(Object.keys(env)).toEqual(['_voiceai', 'version', 'exportedAt', 'stats', 'kdf', 'cipher', 'data_b64']);
    expect(env.stats).toEqual({ totalRecordings: COUNT, transcribed: COUNT, processed: COUNT, finalized: COUNT, uniquePatients: 1 });
    expect(JSON.stringify(env)).toBe(bigFile); // compacto, `data_b64` por último
    const payload = (await decryptBackupText(bigFile, PASS)) as BackupPayload;
    expect(payload.recordings).toHaveLength(COUNT);
    expect(payload.recordings[0].fileName).toBe(bulkName(COUNT - 1)); // mais recente primeiro
    expect(payload.recordings[COUNT - 1].fileName).toBe(bulkName(0));
    expect(payload.recordings[1234]).toMatchObject({
      customName: 'Consulta de rotina',
      transcript: BULK_TRANSCRIPT,
      summary: BULK_SUMMARY,
      patientName: 'Maria Aparecida',
      durationSecs: 60,
      createdAt: new Date(1_700_000_000_000 + (COUNT - 1 - 1234) * 1000).toISOString(),
    });
  }, 60_000);

  test('restauração do mesmo arquivo: decifra, decodifica e fatia por registro; o JSON.parse só vê um registro por vez', async () => {
    const B = newDevice();
    putFile(PICKED, bigFile);
    const text = jest.spyOn(fileClass().prototype, 'text');
    const w = watchBoundaries();
    let res;
    try {
      res = await B.backup.restoreBackup(PICKED, PASS);
    } finally {
      w.restore();
    }
    expect(text).not.toHaveBeenCalled(); // o arquivo nunca é lido inteiro como texto
    expect(res).toEqual({ restoredRecordings: COUNT, restoredTemplates: 0, alreadyPresent: 0, unreadable: 0, doctorRestored: false });

    // dois passes de decifra (verificação + dados), cada um em blocos de 192 KiB
    expect(w.decipherUpdates.length).toBeGreaterThan(2 * 140);
    expect(maxOf(w.decipherUpdates)).toBeLessThanOrEqual(PLAIN_CHUNK);
    expect(maxOf(w.handleReads)).toBeLessThanOrEqual(B64_CHUNK);
    expect(maxOf(w.toBytes)).toBeLessThanOrEqual(B64_CHUNK); // base64 decodificado por janela de 256 KiB
    expect(maxOf(w.bytesToText)).toBeLessThanOrEqual(B64_CHUNK); // base64 (256 KiB) e UTF-8 (192 KiB) por bloco, nunca ~28–37 MB
    expect(maxOf(w.jsonParse)).toBeLessThan(64 * 1024); // um registro (~5,7 KB) ou o cabeçalho, não o documento
    expect(w.jsonParse.length).toBeGreaterThan(COUNT);

    expect((await B.db.getBackupCounts()).recordings).toBe(COUNT);
    const meta = (await B.db.getAllRecordingsMeta()).get(bulkName(4321));
    expect(meta).toMatchObject({ transcript: BULK_TRANSCRIPT, summary: BULK_SUMMARY, patientName: 'Maria Aparecida', customName: 'Consulta de rotina' });
    expect(fakeFs().has(PICKED)).toBe(false);
  }, 120_000);

  test('o mesmo arquivo (~37 MB) FORA do layout (JSON reformatado) é recusado: mensagem clara, sem file.text(), sem JSON.parse do arquivo e sem KDF', async () => {
    const B = newDevice();
    putFile(PICKED, JSON.stringify(JSON.parse(bigFile), null, 2)); // fora do layout do exportador
    const text = jest.spyOn(fileClass().prototype, 'text');
    const parse = jest.spyOn(JSON, 'parse');
    try {
      await expect(B.backup.restoreBackup(PICKED, PASS)).rejects.toThrow('Formato de backup não suportado ou arquivo corrompido.');
    } finally {
      expect(parse.mock.calls.reduce((m, [s]) => Math.max(m, String(s).length), 0)).toBeLessThan(64 * 1024);
      parse.mockRestore();
    }
    expect(text).not.toHaveBeenCalled();
    expect(nativeMock().scrypt).not.toHaveBeenCalled();
    expect(fakeFs().has(PICKED)).toBe(true);
  }, 120_000);
});

describe('compatibilidade nos dois sentidos pelo caminho em blocos (envelope idêntico ao do @noble)', () => {
  const PICKED = 'file:///cache/DocumentPicker/compat.enc.json';
  const OLD_ENVELOPE = fs.readFileSync(path.join(__dirname, 'fixtures', 'backup-v2-noble.json'), 'utf8');

  /** Gera o arquivo como o código ANTIGO: um único `gcm().encrypt` do @noble sobre o JSON inteiro. */
  async function nobleSeal(plain: string): Promise<string> {
    const salt = nodeCrypto.randomBytes(16);
    const nonce = nodeCrypto.randomBytes(12);
    const stats = samplePayload().stats;
    const exportedAt = '2025-06-01T12:00:00.000Z';
    const kdf = { name: 'scrypt', N: 2 ** 14, r: 8, p: 1, salt_b64: salt.toString('base64') };
    const nonceB64 = nonce.toString('base64');
    const aad = new TextEncoder().encode(
      JSON.stringify(['voiceai-backup', 2, exportedAt, stats, 'scrypt', kdf.N, 8, 1, kdf.salt_b64, nonceB64])
    );
    const key = await scryptAsync(PASS.normalize('NFKC'), salt, { N: kdf.N, r: 8, p: 1, dkLen: 32 });
    const sealed = gcm(key, nonce, aad).encrypt(new TextEncoder().encode(plain));
    return JSON.stringify({
      _voiceai: 'encrypted-backup-v2', version: 2, exportedAt, stats, kdf,
      cipher: { name: 'aes-256-gcm', nonce_b64: nonceB64 }, data_b64: Buffer.from(sealed).toString('base64'),
    });
  }

  test('fixture gerada pelo código antigo (@noble) restaura pelo caminho em blocos, sem ler o texto inteiro', async () => {
    const B = newDevice();
    putFile(PICKED, OLD_ENVELOPE);
    const text = jest.spyOn(fileClass().prototype, 'text');
    await expect(B.backup.restoreBackup(PICKED, PASS)).resolves.toMatchObject({ restoredRecordings: 1, unreadable: 0 });
    expect(text).not.toHaveBeenCalled();
    expect(await B.db.getField(REC, 'transcript')).toBe(`${TRANSCRIPT} Ação: não há — 😀`);
  });

  test('arquivo antigo com ~4 MB (vários blocos, cifrado de uma vez pelo @noble) restaura inteiro', async () => {
    const recordings = Array.from({ length: 700 }, (_, i) => ({
      fileName: bulkName(i), customName: `Consulta ${i}`, transcript: `${BULK_TRANSCRIPT}${i}`, summary: BULK_SUMMARY,
      templateId: null, patientName: 'Maria', durationSecs: i, updatedAt: '2025-06-01T12:00:00.000Z', createdAt: null,
    }));
    const plain = JSON.stringify({ version: 2, app: 'voice-ai-recorder', exportedAt: '2025-06-01T12:00:00.000Z', doctor: null, recordings, customTemplates: [] });
    expect(plain.length).toBeGreaterThan(3 * 196_608);
    const B = newDevice();
    putFile(PICKED, await nobleSeal(plain));
    const text = jest.spyOn(fileClass().prototype, 'text');
    await expect(B.backup.restoreBackup(PICKED, PASS)).resolves.toMatchObject({ restoredRecordings: 700, unreadable: 0 });
    expect(text).not.toHaveBeenCalled();
    expect(await B.db.getField(bulkName(699), 'transcript')).toBe(`${BULK_TRANSCRIPT}699`);
  }, 60_000);

  test('arquivo exportado em blocos abre no código antigo (@noble) e o JSON é byte a byte o que o código antigo geraria', async () => {
    const A = newDevice();
    await seedBulk(A, 300);
    await A.db.createCustomTemplate('Modelo', 'desc', TEMPLATE_PROMPT);
    await A.doctor.setDoctorProfile({ name: DOCTOR_NAME, crmNumber: '1', crmUF: 'sp', professionalEnabled: true });
    const out = await A.backup.exportBackup(PASS);
    const file = fakeFs().get(out.path!) as string;

    // O que o código anterior serializava: JSON.stringify do payload inteiro montado em memória.
    const meta = [...(await A.db.getAllRecordingsMeta()).values()].map((m) => ({
      ...m,
      createdAt: new Date(parseInt(m.fileName.match(/recording_(\d+)\.m4a/)![1])).toISOString(),
    }));
    meta.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const expected = JSON.stringify({
      version: 2,
      app: 'voice-ai-recorder',
      exportedAt: JSON.parse(file).exportedAt,
      doctor: await A.doctor.getDoctorProfile(),
      recordings: meta,
      customTemplates: await A.db.getCustomTemplates(),
    });
    expect(expected.length).toBeGreaterThan(PLAIN_CHUNK); // atravessa pelo menos uma borda de bloco
    expect(await nobleOpenText(file, PASS)).toBe(expected);
  }, 60_000);

  test.each([
    PLAIN_CHUNK - 1, PLAIN_CHUNK, PLAIN_CHUNK + 1, 2 * PLAIN_CHUNK, 2 * PLAIN_CHUNK + 5, 3 * PLAIN_CHUNK - 1, 100,
  ])('encryptBackupPayload com JSON de exatamente %i bytes (bordas do bloco de cifra): igual ao código antigo e restaura', async (target) => {
    const base = samplePayload();
    base.recordings[0].transcript = '';
    const empty = JSON.stringify({ version: 2, app: base.app, exportedAt: base.exportedAt, doctor: base.doctor, recordings: base.recordings, customTemplates: base.customTemplates });
    const payload = samplePayload();
    if (target > Buffer.byteLength(empty)) payload.recordings[0].transcript = 'x'.repeat(target - Buffer.byteLength(empty));
    const expected = JSON.stringify({
      version: 2, app: payload.app, exportedAt: payload.exportedAt, doctor: payload.doctor,
      recordings: payload.recordings, customTemplates: payload.customTemplates,
    });
    if (target > Buffer.byteLength(empty)) expect(Buffer.byteLength(expected)).toBe(target);
    const file = await encryptBackupPayload(payload, PASS);
    expect(await nobleOpenText(file, PASS)).toBe(expected);
    expect(JSON.stringify(JSON.parse(file))).toBe(file);
    const B = newDevice();
    putFile(PICKED, file);
    await expect(B.backup.restoreBackup(PICKED, PASS)).resolves.toMatchObject({ restoredRecordings: 1, unreadable: 0 });
    expect((await B.db.getField(REC, 'transcript'))?.length ?? 0).toBe(payload.recordings[0].transcript!.length);
  });

  test('caracteres de 2, 3 e 4 bytes e pares substitutos exatamente na borda de 192 KiB: export e restore em blocos preservam tudo', async () => {
    for (const glyph of ['á', '€', '😀']) {
      const g = Buffer.byteLength(glyph);
      for (let shift = 1; shift < g; shift++) {
        const probe = JSON.stringify({ ...samplePayload(), recordings: [{ ...samplePayload().recordings[0], transcript: '' }] });
        const prefixBytes = Buffer.byteLength(probe.slice(0, probe.indexOf('"transcript":""') + '"transcript":"'.length));
        const pad = PLAIN_CHUNK - shift - prefixBytes; // o caractere começa `shift` bytes antes da borda
        const transcript = `${'x'.repeat(pad)}${glyph.repeat(3)}fim`;
        const payload = samplePayload();
        payload.recordings[0].transcript = transcript;
        const file = await encryptBackupPayload(payload, PASS);
        const B = newDevice();
        putFile(PICKED, file);
        await B.backup.restoreBackup(PICKED, PASS);
        expect([glyph, shift, (await B.db.getField(REC, 'transcript')) === transcript]).toEqual([glyph, shift, true]);
      }
    }
  }, 60_000);
});

describe('restauração em blocos: layouts, adulteração e limites', () => {
  const PICKED = 'file:///cache/DocumentPicker/layout.enc.json';
  let canonical = '';
  beforeAll(async () => {
    const A = newDevice();
    await seed(A);
    const out = await A.backup.exportBackup(PASS);
    canonical = fakeFs().get(out.path!) as string;
  });

  const restoreWith = async (text: string, pass = PASS) => {
    const B = newDevice();
    putFile(PICKED, text);
    const textSpy = jest.spyOn(fileClass().prototype, 'text');
    const result = await B.backup.restoreBackup(PICKED, pass).then((r) => ({ ok: r }), (e: unknown) => ({ err: e }));
    return { B, result, textCalls: textSpy.mock.calls.length };
  };

  test('layout do exportador, com ou sem quebra de linha no fim: caminho em blocos (nunca lê o texto inteiro)', async () => {
    for (const text of [canonical, `${canonical}\n`, `${canonical}\r\n  `]) {
      const { result, textCalls } = await restoreWith(text);
      expect(result).toMatchObject({ ok: { restoredRecordings: 1, restoredTemplates: 1 } });
      expect(textCalls).toBe(0);
    }
  });

  test.each([
    ['JSON reformatado (indentado)', (env: Record<string, any>) => JSON.stringify(env, null, 2)],
    ['data_b64 como primeira chave', (env: Record<string, any>) => JSON.stringify({ data_b64: env.data_b64, ...env })],
    ['outra chave depois do dado', (env: Record<string, any>) => { const { data_b64, ...rest } = env; return JSON.stringify({ ...rest, data_b64, extra: 1 }); }],
    ['cabeçalho maior que 4 KB antes do dado', (env: Record<string, any>) => { const { data_b64, ...rest } = env; return JSON.stringify({ ...rest, pad: 'p'.repeat(5000), data_b64 }); }],
  ])('fora do layout do exportador (%s): cai no caminho em memória e restaura igual', async (_name, rewrite) => {
    const { B, result, textCalls } = await restoreWith(rewrite(JSON.parse(canonical)));
    expect(result).toMatchObject({ ok: { restoredRecordings: 1, restoredTemplates: 1, doctorRestored: true } });
    expect(textCalls).toBe(1);
    expect(await B.db.getField(REC, 'transcript')).toBe(TRANSCRIPT);
  });

  test('senha errada no caminho em memória continua sendo BackupPassphraseError', async () => {
    const { result, B } = await restoreWith(JSON.stringify(JSON.parse(canonical), null, 1), 'frase-errada-123456');
    expect(result).toMatchObject({ err: { name: 'BackupPassphraseError' } });
    expect((await B.db.getBackupCounts()).recordings).toBe(0);
  });

  test.each([
    ['senha errada', (t: string) => ({ text: t, pass: 'frase-errada-123456' })],
    ['byte do ciphertext alterado', (t: string) => ({ text: mutate(t, (e) => { const b = Buffer.from(e.data_b64, 'base64'); b[Math.floor(b.length / 2)] ^= 1; e.data_b64 = b.toString('base64'); }), pass: PASS })],
    ['tag alterada', (t: string) => ({ text: mutate(t, (e) => { const b = Buffer.from(e.data_b64, 'base64'); b[b.length - 1] ^= 1; e.data_b64 = b.toString('base64'); }), pass: PASS })],
    ['tag cortada', (t: string) => ({ text: mutate(t, (e) => { e.data_b64 = Buffer.from(e.data_b64, 'base64').subarray(0, -5).toString('base64'); }), pass: PASS })],
    ['cabeçalho (AAD) alterado', (t: string) => ({ text: mutate(t, (e) => { e.stats.totalRecordings = 99; }), pass: PASS })],
    ['nonce alterado', (t: string) => ({ text: mutate(t, (e) => { const n = Buffer.from(e.cipher.nonce_b64, 'base64'); n[0] ^= 1; e.cipher.nonce_b64 = n.toString('base64'); }), pass: PASS })],
  ])('%s: BackupPassphraseError no 1º passe, antes de abrir a transação e sem tocar no banco', async (_name, make) => {
    const B = newDevice();
    const { text, pass } = make(canonical);
    putFile(PICKED, text);
    const db = await B.db.getDb();
    const txn = jest.spyOn(db, 'withExclusiveTransactionAsync');
    const run = jest.spyOn(db, 'runAsync');
    await expect(B.backup.restoreBackup(PICKED, pass)).rejects.toBeInstanceOf(B.backup.BackupPassphraseError);
    expect(txn).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(fakeFs().has(PICKED)).toBe(true); // o arquivo fica para outra tentativa
  });

  test('erros de formato continuam iguais pelo caminho em blocos: v1, N fora da allow-list, ciphertext curto e base64 torto — todos sem KDF', async () => {
    const cases: [string, string, RegExp][] = [
      ['v1', JSON.stringify({ _voiceai: 'encrypted-backup-v1', version: 1, data_b64: 'AAAA' }), /formato antigo/],
      ['N=2^20', mutate(canonical, (e) => { e.kdf.N = 2 ** 20; }), /não suportados/],
      ['ciphertext curto', mutate(canonical, (e) => { e.data_b64 = 'AAAA'; }), /incompleto|corrompido/],
      ['ciphertext vazio', mutate(canonical, (e) => { e.data_b64 = ''; }), /incompleto|corrompido/],
      ['base64 com comprimento torto', mutate(canonical, (e) => { e.data_b64 = `${e.data_b64}A`; }), /base64/],
      ['base64 inválido no meio', mutate(canonical, (e) => { e.data_b64 = `${e.data_b64.slice(0, 100)}!!!!${e.data_b64.slice(104)}`; }), /base64/],
      ['salt inválido', mutate(canonical, (e) => { e.kdf.salt_b64 = '!!!!!!!!!!!!!!!!'; }), /base64/],
    ];
    for (const [label, text, expected] of cases) {
      const B = newDevice();
      putFile(PICKED, text);
      const err = await B.backup.restoreBackup(PICKED, PASS).catch((e: unknown) => e);
      expect([label, err instanceof B.backup.BackupPassphraseError, (err as Error).message]).toEqual([label, false, expect.stringMatching(expected)]);
      expect([label, nativeMock().scrypt.mock.calls.length]).toEqual([label, label === 'base64 inválido no meio' ? 1 : 0]);
    }
  });
});

describe('restauração em lotes: tudo-ou-nada e conteúdo hostil', () => {
  const PICKED = 'file:///cache/DocumentPicker/lotes.enc.json';
  const HEAD = '{"version":2,"app":"voice-ai-recorder","exportedAt":"2025-06-01T12:00:00.000Z","doctor":null,"recordings":[';
  const rec = (i: number) => JSON.stringify({ fileName: bulkName(i), transcript: `texto ${i} ação`, durationSecs: i });
  const recs = (n: number) => Array.from({ length: n }, (_, i) => rec(i)).join(',');
  const insertsOf = (run: jest.SpyInstance) =>
    run.mock.calls.filter(([sql]) => /INSERT OR REPLACE INTO recordings/.test(sql as string)).length;

  async function restoreBytes(plain: string) {
    const B = newDevice();
    putFile(PICKED, envelopeFromBytes(Buffer.from(plain)));
    const run = jest.spyOn(await B.db.getDb(), 'runAsync');
    const err = await B.backup.restoreBackup(PICKED, PASS).then(() => null, (e: unknown) => e as Error);
    return { B, err, run };
  }

  test('falha no meio do 3º lote: os 2 lotes já gravados são desfeitos, o arquivo fica e a nova tentativa restaura tudo', async () => {
    const A = newDevice();
    await seedBulk(A, 250);
    await A.doctor.setDoctorProfile({ name: DOCTOR_NAME, professionalEnabled: true });
    const out = await A.backup.exportBackup(PASS);
    const text = fakeFs().get(out.path!) as string;

    const B = newDevice();
    const raw = await rawSqlite(B);
    // ordem do arquivo: mais recente primeiro → bulkName(19) é o 231º registro (3º lote, perto do fim)
    raw.exec(`CREATE TRIGGER boom BEFORE INSERT ON recordings WHEN NEW.fileName = '${bulkName(19)}' BEGIN SELECT RAISE(ABORT, 'falha no lote'); END;`);
    const run = jest.spyOn(await B.db.getDb(), 'runAsync');
    putFile(PICKED, text);

    await expect(B.backup.restoreBackup(PICKED, PASS)).rejects.toThrow(/falha no lote/);
    expect(insertsOf(run)).toBeGreaterThanOrEqual(230); // os lotes anteriores chegaram a ser gravados na transação…
    expect((await B.db.getBackupCounts()).recordings).toBe(0); // …e foram desfeitos
    expect(fakeFs().has(PICKED)).toBe(true);

    raw.exec('DROP TRIGGER boom');
    await expect(B.backup.restoreBackup(PICKED, PASS)).resolves.toMatchObject({
      restoredRecordings: 250, alreadyPresent: 0, unreadable: 0, doctorRestored: true, // perfil não foi gravado na tentativa que falhou
    });
    expect((await B.db.getBackupCounts()).recordings).toBe(250);
  }, 60_000);

  test('JSON truncado depois de 250 registros válidos: "Conteúdo do backup corrompido." e nada gravado', async () => {
    const { B, err, run } = await restoreBytes(`${HEAD}${recs(250)},{"fileName":"recording_9.m4a","transcript":"cortad`);
    expect(err?.message).toBe('Conteúdo do backup corrompido.');
    expect(insertsOf(run)).toBeGreaterThanOrEqual(200);
    expect((await B.db.getBackupCounts()).recordings).toBe(0);
    expect(fakeFs().has(PICKED)).toBe(true);
  });

  test('versão/app só depois dos registros (ordem de chaves livre) é aceita; app errado desfaz os 250 já gravados', async () => {
    const ok = await restoreBytes(`{"recordings":[${recs(250)}],"app":"voice-ai-recorder","version":2}`);
    expect(ok.err).toBeNull();
    expect((await ok.B.db.getBackupCounts()).recordings).toBe(250);

    const bad = await restoreBytes(`{"recordings":[${recs(250)}],"app":"outro-app","version":2}`);
    expect(bad.err?.message).toBe('Conteúdo do backup não reconhecido.');
    expect(insertsOf(bad.run)).toBeGreaterThanOrEqual(250);
    expect((await bad.B.db.getBackupCounts()).recordings).toBe(0);
  });

  test.each([
    ['array de gravações repetido', `{"version":2,"app":"voice-ai-recorder","recordings":[${rec(1)}],"recordings":[${rec(2)}]}`, 'Conteúdo do backup corrompido.'],
    ['vírgula sobrando', `{"version":2,"app":"voice-ai-recorder","recordings":[${rec(1)},]}`, 'Conteúdo do backup corrompido.'],
    ['lixo depois do objeto', `{"version":2,"app":"voice-ai-recorder","recordings":[]} {}`, 'Conteúdo do backup corrompido.'],
    ['JSON que não é objeto', '[1,2,3]', 'Conteúdo do backup não reconhecido.'],
    ['sem versão', '{"app":"voice-ai-recorder","recordings":[]}', 'Conteúdo do backup não reconhecido.'],
    ['vazio', '', 'Conteúdo do backup corrompido.'],
  ])('payload autenticado porém inválido: %s', async (_name, plain, message) => {
    const { B, err } = await restoreBytes(plain);
    expect(err?.message).toBe(message);
    expect((await B.db.getBackupCounts()).recordings).toBe(0);
  });

  test('"recordings" que não é array é ignorado (como antes); elementos inválidos contam como ilegíveis', async () => {
    const { B, err } = await restoreBytes(`{"version":2,"app":"voice-ai-recorder","recordings":{"a":1},"customTemplates":[1,"x",null]}`);
    expect(err).toBeNull();
    expect((await B.db.getBackupCounts())).toEqual({ recordings: 0, transcribed: 0, finalized: 0, templates: 0 });
  });

  test('UTF-8 inválido em qualquer ponto da borda do 1º bloco (192 KiB) é recusado como corrompido, nunca como senha errada nem U+FFFD', async () => {
    const body = Buffer.from(`${HEAD}{"fileName":"${bulkName(1)}","transcript":"${'x'.repeat(PLAIN_CHUNK + 50)}"}]}`);
    const mangles: number[][] = [[0xc3, 0x28], [0x80], [0xff], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf0, 0x9f, 0x98]];
    for (const at of [PLAIN_CHUNK - 3, PLAIN_CHUNK - 1, PLAIN_CHUNK, PLAIN_CHUNK + 2]) {
      for (const bytes of mangles) {
        const plain = Buffer.concat([body.subarray(0, at), Buffer.from(bytes), body.subarray(at)]);
        const B = newDevice();
        putFile(PICKED, envelopeFromBytes(plain));
        const err = await B.backup.restoreBackup(PICKED, PASS).catch((e: unknown) => e as Error);
        expect([at, bytes, err instanceof B.backup.BackupPassphraseError, (err as Error).message]).toEqual([at, bytes, false, 'Conteúdo do backup corrompido.']);
      }
    }
    const truncated = body.subarray(0, body.length - 1); // termina no meio do JSON (só ASCII) → sintaxe
    const B = newDevice();
    putFile(PICKED, envelopeFromBytes(truncated));
    await expect(B.backup.restoreBackup(PICKED, PASS)).rejects.toThrow('Conteúdo do backup corrompido.');
  }, 60_000);

  test('UTF-8 truncado no fim do plaintext (sequência multibyte cortada) é corrompido', async () => {
    const plain = Buffer.concat([Buffer.from(`${HEAD}{"fileName":"${bulkName(1)}","transcript":"`), Buffer.from('€').subarray(0, 2)]);
    const B = newDevice();
    putFile(PICKED, envelopeFromBytes(plain));
    await expect(B.backup.restoreBackup(PICKED, PASS)).rejects.toThrow('Conteúdo do backup corrompido.');
  });
});

describe('exportação: coerência entre os dois passes sobre o banco', () => {
  test('dados que mudam entre a contagem (cabeçalho autenticado) e a escrita abortam a exportação sem deixar arquivo parcial', async () => {
    const A = newDevice();
    await seedBulk(A, 50);
    const raw = await rawSqlite(A);
    // o scrypt roda DEPOIS do passe 1 e ANTES do passe 2: é o ponto em que o usuário "salvaria" algo
    nativeMock().scrypt.mockImplementationOnce((...args: unknown[]) => {
      raw.exec("DELETE FROM recordings WHERE fileName = '" + bulkName(7) + "'");
      return (nodeCrypto.scrypt as (...a: unknown[]) => void)(...args);
    });
    await expect(A.backup.exportBackup(PASS)).rejects.toThrow(/mudaram durante a exportação/);
    expect([...fakeFs().keys()].filter((k) => k.includes('/exports/'))).toEqual([]);
    expect(A.sharing.shareAsync).not.toHaveBeenCalled();
  });

  test('o limite de 50 MB é checado no passe de contagem: sem scrypt e sem arquivo (banco em lotes, nada montado)', async () => {
    const A = newDevice();
    const raw = await rawSqlite(A);
    // 3 linhas de ~17 MB em texto puro (legado, lido como está): 51 MB de JSON, nunca em memória de uma vez
    for (let i = 0; i < 3; i++) raw.prepare('INSERT INTO recordings (fileName, transcript) VALUES (?, ?)').run(bulkName(i), 'a'.repeat(17 * MB));
    const w = watchBoundaries();
    try {
      await expect(A.backup.exportBackup(PASS)).rejects.toThrow(/passaria de 50 MB/);
    } finally {
      w.restore();
    }
    expect(nativeMock().scrypt).not.toHaveBeenCalled();
    expect(w.cipherUpdates).toEqual([]);
    expect([...fakeFs().keys()].filter((k) => k.includes('/exports/'))).toEqual([]);
  });
});

// ─── Revisão G: teto do fallback, teto de itens, erro de tag persistente, nome de export único ───────

describe('restauração: fallback em memória com teto (M1) e teto de itens (M2)', () => {
  const PICKED = 'file:///cache/DocumentPicker/teto.enc.json';
  const HEAD = '{"version":2,"app":"voice-ai-recorder","exportedAt":"2025-06-01T12:00:00.000Z","doctor":null,';
  const ones = (n: number) => `[${'1,'.repeat(n - 1)}1]`;
  const pretty = (envelopeJson: string) => JSON.stringify(JSON.parse(envelopeJson), null, 1); // fora do layout do exportador

  async function restoreText(text: string) {
    const B = newDevice();
    putFile(PICKED, text);
    const textSpy = jest.spyOn(fileClass().prototype, 'text');
    const parse = jest.spyOn(JSON, 'parse');
    const err = await B.backup.restoreBackup(PICKED, PASS).then(() => null, (e: unknown) => e as Error);
    const biggestParse = parse.mock.calls.reduce((m, [s]) => Math.max(m, String(s).length), 0);
    parse.mockRestore();
    return { B, err, textCalls: textSpy.mock.calls.length, biggestParse };
  }

  test('fora do layout e acima de 8 MB (lixo ou envelope reformatado): erro claro, sem file.text(), sem JSON.parse do arquivo e sem KDF', async () => {
    for (const text of ['x'.repeat(9 * MB), `{"a":"${'y'.repeat(9 * MB)}"}`, pretty(envelopeFromBytes(Buffer.from(`${HEAD}"recordings":[{"fileName":"a.m4a","transcript":"${'t'.repeat(7 * MB)}"}]}`)))]) {
      expect(text.length).toBeGreaterThan(8 * MB);
      const { B, err, textCalls, biggestParse } = await restoreText(text);
      expect(err?.message).toBe('Formato de backup não suportado ou arquivo corrompido.');
      expect(err).not.toBeInstanceOf(B.backup.BackupPassphraseError);
      expect(textCalls).toBe(0);
      expect(biggestParse).toBeLessThan(64 * 1024);
      expect(nativeMock().scrypt).not.toHaveBeenCalled();
      expect(fakeFs().has(PICKED)).toBe(true);
    }
  });

  test('fora do layout e abaixo do teto (~6 MB reformatado) continua restaurando pelo caminho em memória', async () => {
    const plain = `${HEAD}"recordings":[{"fileName":"a.m4a","transcript":"${'t'.repeat(5 * MB)}"}]}`;
    const text = pretty(envelopeFromBytes(Buffer.from(plain)));
    expect(text.length).toBeGreaterThan(6 * MB);
    expect(text.length).toBeLessThan(8 * MB);
    const { B, err, textCalls } = await restoreText(text);
    expect(err).toBeNull();
    expect(textCalls).toBe(1);
    expect((await B.db.getField('a.m4a', 'transcript'))?.length).toBe(5 * MB);
  }, 60_000);

  test('200 000 itens por array passam; 200 001 viram "conteúdo corrompido" e nada é gravado (gravações e templates)', async () => {
    const okRec = await restoreText(envelopeFromBytes(Buffer.from(`${HEAD}"recordings":${ones(200_000)}}`)));
    expect(okRec.err).toBeNull();

    for (const [key, n] of [['recordings', 200_001], ['customTemplates', 200_001]] as const) {
      const rec = key === 'recordings' ? `{"fileName":"ok.m4a","transcript":"t"},` : `{"id":"t1","name":"n","systemPrompt":"p"},`;
      const { B, err } = await restoreText(envelopeFromBytes(Buffer.from(`${HEAD}"${key}":[${rec}${ones(n - 1).slice(1)}}`)));
      expect([key, err?.message]).toEqual([key, 'Conteúdo do backup corrompido.']);
      expect(await B.db.getBackupCounts()).toEqual({ recordings: 0, transcribed: 0, finalized: 0, templates: 0 });
    }
  }, 60_000);

  test('o mesmo teto vale no caminho em memória (arquivo pequeno reformatado com 200 001 itens)', async () => {
    const { B, err, textCalls } = await restoreText(pretty(envelopeFromBytes(Buffer.from(`${HEAD}"recordings":${ones(200_001)}}`))));
    expect(textCalls).toBe(1);
    expect(err?.message).toBe('Conteúdo do backup corrompido.');
    expect((await B.db.getBackupCounts()).recordings).toBe(0);
  }, 60_000);

  test('campo de primeiro nível gigante (doctor ou chave desconhecida com > 1 MiB) é recusado sem parse', async () => {
    for (const extra of [`"doctor":{"name":"${'d'.repeat(MB)}"},"recordings":[]`, `"x":[${'1,'.repeat(MB)}1],"recordings":[]`]) {
      const { err, biggestParse } = await restoreText(envelopeFromBytes(Buffer.from(`{"version":2,"app":"voice-ai-recorder",${extra}}`)));
      expect(err?.message).toBe('Conteúdo do backup corrompido.');
      expect(biggestParse).toBeLessThan(64 * 1024);
    }
  });
});

describe('SealedReader: erro de tag é permanente (L2)', () => {
  const URI = 'file:///cache/DocumentPicker/reader.enc.json';

  function readerWith(key: Buffer) {
    const d = newDevice();
    putFile(URI, envelopeFromBytes(Buffer.from(JSON.stringify(samplePayload()))));
    const { File } = jest.requireMock('expo-file-system');
    const n = jest.requireActual<typeof import('../native-crypto')>('../native-crypto').loadNativeCrypto();
    const { openSealedFile, readSealedTail, SealedReader } = d.backup.backupInternals;
    const sealed = openSealedFile(new File(URI))!;
    const { env } = sealed;
    const aad = new TextEncoder().encode(
      JSON.stringify(['voiceai-backup', 2, env.exportedAt, env.stats, 'scrypt', env.kdf.N, env.kdf.r, env.kdf.p, env.kdf.salt_b64, env.cipher.nonce_b64])
    );
    const { tag, cipherBytes } = readSealedTail(n, sealed);
    const nonce = Buffer.from(env.cipher.nonce_b64, 'base64');
    return { reader: new SealedReader(n, sealed, key, nonce, aad, tag, cipherBytes), BackupPassphraseError: d.backup.BackupPassphraseError };
  }
  const drain = (r: { next(): Uint8Array | null }) => { while (r.next() !== null); };
  const rightKey = () => nodeCrypto.scryptSync(PASS.normalize('NFKC'), Buffer.alloc(16, 5), 32, { N: 2 ** 14, r: 8, p: 1 });

  test('controle: com a chave certa o fim do arquivo devolve null (e continua devolvendo null)', () => {
    const { reader } = readerWith(rightKey());
    drain(reader);
    expect(reader.next()).toBeNull();
  });

  test('tag que não confere: BackupPassphraseError no fim e em TODAS as chamadas seguintes (nunca null)', () => {
    const { reader, BackupPassphraseError: Err } = readerWith(Buffer.alloc(32, 1));
    expect(() => drain(reader)).toThrow(Err);
    for (let i = 0; i < 3; i++) expect(() => reader.next()).toThrow(Err);
  });
});

describe('arquivo de exportação: nome único e nunca apagar o de outra exportação (L4)', () => {
  const FROZEN = new Date('2025-06-01T12:00:00.123Z');
  const REAL_TIMERS_OFF = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
    'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] as const;
  beforeEach(() => { jest.useFakeTimers({ now: FROZEN, doNotFake: [...REAL_TIMERS_OFF] }); });
  afterEach(() => { jest.useRealTimers(); });

  const basename = (uri: string) => uri.split('/').pop()!;

  test('duas exportações no MESMO instante geram nomes diferentes (milissegundos + sufixo) e ambas continuam abrindo', async () => {
    const A = newDevice();
    await seed(A);
    const first = await A.backup.exportBackup(PASS);
    const second = await A.backup.exportBackup(PASS);
    expect(basename(first.path!)).not.toBe(basename(second.path!));
    expect(basename(first.path!)).toMatch(/^voice-ai-recorder-backup-2025-06-01T12-00-00-123-[a-z0-9]{4}\.enc\.json$/);
    expect(first.path).not.toBe(second.path);
    for (const out of [first, second]) {
      expect(((await decryptBackupText(fakeFs().get(out.path!) as string, PASS)) as BackupPayload).recordings).toHaveLength(1);
    }
  });

  test('2ª exportação que falha no meio apaga só o próprio arquivo parcial; a 1ª (mesmo instante) fica intacta', async () => {
    const A = newDevice();
    await seed(A);
    const first = await A.backup.exportBackup(PASS);
    const firstContent = fakeFs().get(first.path!);
    const del = jest.spyOn(fileClass().prototype as unknown as { delete: () => void }, 'delete');

    const raw = await rawSqlite(A);
    nativeMock().scrypt.mockImplementationOnce((...args: unknown[]) => {
      raw.exec("UPDATE recordings SET customName = customName || 'x'"); // muda o tamanho entre os passes
      return (nodeCrypto.scrypt as (...a: unknown[]) => void)(...args);
    });
    await expect(A.backup.exportBackup(PASS)).rejects.toThrow(/mudaram durante a exportação/);

    expect(fakeFs().get(first.path!)).toBe(firstContent);
    expect([...fakeFs().keys()].filter((k) => k.includes('/exports/'))).toEqual([first.path]);
    const deleted = del.mock.calls.length;
    expect(deleted).toBeLessThanOrEqual(1); // só o parcial da própria chamada (se o KDF terminou antes de criar o arquivo, nenhum)
  });
});
