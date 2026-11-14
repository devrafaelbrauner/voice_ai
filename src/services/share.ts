import { Linking, Share, Alert, AppState } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { showActionSheet } from '../components/ActionSheet';
import { Directory, File, Paths } from 'expo-file-system';

// ─── Text share menu ────────────────────────────────────────────────────────

export function openShareMenu(text: string, title: string, onCopied?: () => void) {
  showActionSheet(
    {
      title: 'Compartilhar',
      message: 'Escolha um destino',
      options: [
        'Cancelar',
        'Copiar texto',
        'Email',
        'Obsidian',
        'Outros apps (Notas, Notion, Drive...)',
      ],
      cancelButtonIndex: 0,
    },
    async (idx) => {
      try {
        if (idx === 1) {
          await Clipboard.setStringAsync(text);
          onCopied?.();
        } else if (idx === 2) {
          const url = `mailto:?subject=${encodeURIComponent(
            title
          )}&body=${encodeURIComponent(text)}`;
          const canOpen = await Linking.canOpenURL(url);
          if (!canOpen) {
            Alert.alert('Mail indisponível', 'Configure o app de e-mail primeiro.');
            return;
          }
          await Linking.openURL(url);
        } else if (idx === 3) {
          // obsidian://new?name=...&content=...
          const url = `obsidian://new?name=${encodeURIComponent(
            title
          )}&content=${encodeURIComponent(text)}`;
          const canOpen = await Linking.canOpenURL(url);
          if (!canOpen) {
            Alert.alert(
              'Obsidian não encontrado',
              'Instale o Obsidian para usar este atalho.'
            );
            return;
          }
          await Linking.openURL(url);
        } else if (idx === 4) {
          await Share.share({ message: text, title });
        }
      } catch (err: any) {
        Alert.alert('Erro', err?.message ?? String(err));
      }
    }
  );
}

// ─── Export files (cache/exports) ───────────────────────────────────────────
//
// Todo arquivo gerado para compartilhar (Markdown com PHI em texto puro, backups
// cifrados) vive em cache/exports/<token>/<nome>. Cada export ganha um subdiretório
// próprio (token = timestamp em base36 + sufixo aleatório): o nome visível do arquivo
// é preservado e nunca colide. O sweep apaga por idade, lida do token.

const EXPORTS_DIR = 'exports';
/** Janela para o app destino ler o arquivo compartilhado antes do sweep apagar. */
const EXPORT_MAX_AGE_MS = 15 * 60 * 1000;

/** Cria (vazio) o arquivo de export e devolve o handle; o chamador grava o conteúdo. */
export function createExportFile(fileName: string): File {
  const root = new Directory(Paths.cache, EXPORTS_DIR);
  root.create({ intermediates: true, idempotent: true });
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = new Directory(root, token);
  dir.create({ intermediates: true });
  const file = new File(dir, fileName);
  file.create();
  return file;
}

/**
 * Apaga exports antigos (e restos de versões anteriores que gravavam na raiz do cache).
 * Best-effort: nunca lança. Chamado ao abrir Config/Gravações e em AppState 'active'.
 */
export async function sweepOldExports(maxAgeMs: number = EXPORT_MAX_AGE_MS): Promise<void> {
  const cutoff = Date.now() - maxAgeMs;
  try {
    const root = new Directory(Paths.cache, EXPORTS_DIR);
    if (root.exists) {
      for (const entry of root.list()) {
        if (!(entry instanceof Directory)) {
          entry.delete(); // arquivo solto: não é criado por createExportFile
          continue;
        }
        const ts = parseInt(entry.name.split('-')[0], 36);
        if (!Number.isFinite(ts) || ts < cutoff) entry.delete();
      }
    }
  } catch {
    // sweep é oportunista
  }
  try {
    // Legado: versões anteriores gravavam .md e backups direto na raiz do cache.
    const base = FileSystem.cacheDirectory;
    if (!base) return;
    for (const name of await FileSystem.readDirectoryAsync(base)) {
      if (!/\.md$|^voice-ai-recorder-backup-.*\.enc\.json$/.test(name)) continue;
      const info = await FileSystem.getInfoAsync(`${base}${name}`);
      if (info.exists && !info.isDirectory && info.modificationTime * 1000 < cutoff) {
        await FileSystem.deleteAsync(`${base}${name}`, { idempotent: true });
      }
    }
  } catch {
    // idem
  }
}

// Único gatilho de sweep em segundo plano: ao voltar ao primeiro plano (o app destino já
// leu o arquivo). Markdown com PHI não fica no cache até o usuário abrir Config/Gravações.
// Registrado uma vez no carregamento do módulo (como os demais listeners de serviço).
AppState.addEventListener('change', (state) => {
  if (state === 'active') void sweepOldExports();
});

// ─── Markdown (.md) file export ─────────────────────────────────────────────

export interface MarkdownExportInput {
  /** Displayed name of the recording — used as filename and title */
  name: string;
  /** ISO date string of when the recording was created */
  createdAt?: string;
  /** Template name used to generate the content (optional) */
  templateName?: string | null;
  /** Main content: AI-processed summary or cleaned transcript */
  content: string;
  /** Raw transcript to append as appendix (optional) */
  transcript?: string | null;
}

/**
 * Writes `input.content` to a `.md` file and opens the system share sheet.
 * Includes YAML front-matter with recording metadata.
 */
export async function exportToMarkdown(input: MarkdownExportInput): Promise<void> {
  try {
    const { name, createdAt, templateName, content, transcript } = input;

    // Build YAML front-matter
    const dateStr = createdAt
      ? new Date(createdAt).toLocaleDateString('pt-BR')
      : new Date().toLocaleDateString('pt-BR');

    let md = '---\n';
    md += `título: "${name}"\n`;
    md += `data: ${dateStr}\n`;
    if (templateName) md += `template: "${templateName}"\n`;
    md += 'gerado_por: VoiceAI\n';
    md += '---\n\n';

    // Main content
    md += content.trim();

    // Optional raw transcript appendix
    if (transcript && transcript.trim()) {
      md += '\n\n---\n\n## Transcrição bruta\n\n';
      md += transcript.trim();
    }

    // Sanitize filename: replace spaces and special chars
    const safeName = name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // remove accents
      .replace(/[^a-zA-Z0-9_\- ]/g, '')
      .trim()
      .replace(/\s+/g, '_');

    const fileName = `${safeName || 'transcricao'}.md`;
    const file = createExportFile(fileName);
    const fileUri = file.uri;

    file.write(md);

    const isAvailable = await Sharing.isAvailableAsync();
    if (isAvailable) {
      await Sharing.shareAsync(fileUri, {
        mimeType: 'text/markdown',
        dialogTitle: `Salvar ${fileName}`,
        UTI: 'net.daringfireball.markdown',
      });
    } else {
      Alert.alert(
        'Arquivo gerado',
        `Arquivo salvo em:\n${fileUri}`
      );
    }
  } catch (err: any) {
    Alert.alert('Erro ao exportar Markdown', err?.message ?? String(err));
  }
}
