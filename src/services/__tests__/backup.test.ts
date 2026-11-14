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

declare global {
  var __fakeFs: Map<string, string | { size: number }>;
}
// share.ts puxa componentes de UI; só createExportFile importa aqui (grava no FS em memória).
jest.mock('../share', () => ({
  __esModule: true,
  createExportFile: (name: string) => {
    const { File } = jest.requireMock('expo-file-system');
    const file = new File(`file:///cache/exports/tok/${name}`);
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

    const payload = await A.backup.buildBackup();

    expect(payload.unreadableItems).toBe(2);
    const byName = new Map(payload.recordings.map((r) => [r.fileName, r]));
    expect(byName.get('r1.m4a')).toMatchObject({ transcript: null, summary: 'resumo-1' });
    expect(byName.get('r2.m4a')).toMatchObject({ transcript: null, summary: null });
    expect(JSON.stringify(payload)).not.toContain('__DECRYPT_FAILED__');
    expect(payload.stats).toMatchObject({ transcribed: 0, processed: 1, finalized: 0 });
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
}
const nativeMock = (): QuickCryptoMock => jest.requireMock('react-native-quick-crypto');

/** Decifra um envelope v2 com a implementação de referência (@noble, JS puro), independente do código do app. */
async function nobleOpen(text: string, pass: string): Promise<any> {
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
  return JSON.parse(new TextDecoder().decode(plain));
}

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

describe('UTF-8 estrito no decode do envelope (conversor nativo, sem TextDecoder)', () => {
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
