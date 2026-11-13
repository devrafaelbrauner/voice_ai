// Backup cifrado v2: cripto real (scrypt + AES-GCM do @noble), SQL real (node:sqlite) e
// dois "aparelhos" (registries de módulo separados, cada um com seu banco e sua chave).
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
