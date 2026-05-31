import { Linking, Share, Alert } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { showActionSheet } from '../components/ActionSheet';

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
    const fileUri = `${FileSystem.cacheDirectory}${fileName}`;

    await FileSystem.writeAsStringAsync(fileUri, md, {
      encoding: FileSystem.EncodingType.UTF8,
    });

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
