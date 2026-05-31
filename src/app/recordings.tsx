import { useEffect, useState, useCallback, useMemo, useRef, memo } from 'react';
import {
  FlatList,
  Pressable,
  Alert,
  ActivityIndicator,
  TextInput,
  Modal,
  StyleSheet,
  View,
  ScrollView,
} from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { YStack, XStack, Text } from 'tamagui';
import {
  Play,
  Pause,
  Trash2,
  ArrowLeft,
  FileText,
  FileCode,
  Sparkles,
  BookOpen,
  Pencil,
  Check,
  X,
  Copy,
  Share2,
  RefreshCw,
  Search,
  FileDown,
  User,
  Upload,
  CloudOff,
} from 'lucide-react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import * as Clipboard from 'expo-clipboard';
import { Link, useFocusEffect, useLocalSearchParams } from 'expo-router';
import {
  transcribeAudio,
  BUILTIN_TEMPLATES,
  getAllTemplates,
  PromptTemplate,
} from '../services/openai';
import {
  getAllRecordingsMeta,
  deleteRecordingMeta,
  setField,
  clearField,
} from '../services/db';
import {
  useProcessingStore,
} from '../services/processing-store';
import { formatDefaultName } from '../services/recordings';
import { openShareMenu, exportToMarkdown } from '../services/share';
import { exportRecordingToPDF } from '../services/pdf';
import { getDoctorProfile } from '../services/doctor';
import { MermaidView } from '../components/MermaidView';
import { AudioPlayerBar } from '../components/AudioPlayerBar';
import { exportToEvoPad } from '../services/evopad-export';
import { useColors } from '../context/ThemeContext';
import { logError, logWarn } from '../services/log';
import {
  dequeueTranscription,
  getQueueCount,
  getFailedCount,
  getFailedItems,
  clearFailedItems,
  processQueue,
} from '../services/transcription-queue';


const stripMarkers = (s: string) =>
  s.replace(/\s*\[(C[1-5]|RDC\s*20|SIMPLES)\]/g, '');

// Limite de linhas exibidas no card antes de oferecer "Ver completa".
const TRANSCRIPT_PREVIEW_LINES = 10;

/**
 * Heurística leve: a transcrição é "longa" o bastante para truncar quando
 * tem muitas quebras de linha OU muitos caracteres (≈ 10 linhas de tela).
 */
function isTranscriptLong(text: string | null | undefined): boolean {
  if (!text) return false;
  const newlines = (text.match(/\n/g)?.length ?? 0) + 1;
  return newlines > TRANSCRIPT_PREVIEW_LINES || text.length > 480;
}

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

const swipeStyles = StyleSheet.create({
  deleteAction: {
    backgroundColor: '#c0392b',
    justifyContent: 'center',
    alignItems: 'center',
    width: 80,
    borderRadius: 12,
    gap: 4,
    marginLeft: 6,
  },
  renameAction: {
    backgroundColor: '#495057',
    justifyContent: 'center',
    alignItems: 'center',
    width: 80,
    borderRadius: 12,
    gap: 4,
    marginRight: 6,
  },
  actionText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  pickerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  pickerSheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    maxHeight: '80%',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: 'hidden',
  },
});

interface Recording {
  fileName: string;
  uri: string;
  createdAt: string;
  customName: string | null;
  transcript: string | null;
  summary: string | null;
  templateId: string | null;
  patientName: string | null;
  durationSecs: number | null;
  localFileExists: boolean;
}

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

/**
 * Parse DD/MM/AAAA into Date (start of day) or null if invalid.
 * Also accepts auto-formatted input like "31/12/2024".
 */
function parseDateBR(input: string): Date | null {
  const m = input.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2100) return null;
  const d = new Date(year, month - 1, day);
  // Validate roll-over (e.g. 31/02 \u2192 03/03)
  if (d.getDate() !== day || d.getMonth() !== month - 1) return null;
  return d;
}

/**
 * Auto-format raw digits into DD/MM/AAAA as user types.
 * Strips non-digits and inserts slashes at positions 2 and 4.
 */
function autoFormatDateBR(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

/**
 * Extracts a short snippet of `text` around the first occurrence of `query`.
 * Returns null if query is not found in text.
 */
function getSearchSnippet(text: string | null | undefined, query: string): string | null {
  if (!query || !text) return null;
  const normText = normalize(text);
  const normQuery = normalize(query);
  const idx = normText.indexOf(normQuery);
  if (idx === -1) return null;
  const start = Math.max(0, idx - 35);
  const end = Math.min(text.length, idx + query.length + 65);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

export default function RecordingsScreen() {
  const c = useColors();
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [playingUri, setPlayingUri] = useState<string | null>(null);
  const [exportingUri, setExportingUri] = useState<string | null>(null);

  // Store global — transcrição e processamento correm em background,
  // independente do ciclo de vida deste componente.
  const {
    transcribingFiles,
    processingFiles,
    completionCount,
    startTranscription,
    startProcessing,
  } = useProcessingStore();
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editingTranscriptFile, setEditingTranscriptFile] = useState<string | null>(null);
  const [editTranscriptValue, setEditTranscriptValue] = useState('');
  const [editTranscriptOriginal, setEditTranscriptOriginal] = useState('');
  // Tela cheia de leitura da transcrição completa (somente leitura)
  const [viewingTranscriptFile, setViewingTranscriptFile] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [allTemplates, setAllTemplates] =
    useState<PromptTemplate[]>(BUILTIN_TEMPLATES);
  const [showFilters, setShowFilters] = useState(false);
  const [selectedTemplates, setSelectedTemplates] = useState<Set<string>>(new Set());
  const [selectedStatuses, setSelectedStatuses] = useState<Set<string>>(new Set());
  const [dateRange, setDateRange] = useState<'all' | 'today' | 'week' | 'month' | 'custom'>('all');
  const [customDateStart, setCustomDateStart] = useState(''); // DD/MM/AAAA
  const [customDateEnd, setCustomDateEnd] = useState(''); // DD/MM/AAAA
  const [queueCount, setQueueCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [isProcessingQueue, setIsProcessingQueue] = useState(false);

  // Template picker modal (replaces ActionSheet for "Processar com IA")
  const [templatePickerVisible, setTemplatePickerVisible] = useState(false);
  const [templatePickerCallback, setTemplatePickerCallback] = useState<((templateId: string) => void) | null>(null);
  const [previewTemplateId, setPreviewTemplateId] = useState<string | null>(null);

  // Swipeable refs — track the currently-open swipeable so we can close it
  const swipeableRefs = useRef<Map<string, Swipeable | null>>(new Map());
  const lastOpenSwipeable = useRef<Swipeable | null>(null);

  const refreshQueueCount = useCallback(async () => {
    const [n, f] = await Promise.all([getQueueCount(), getFailedCount()]);
    setQueueCount(n);
    setFailedCount(f);
  }, []);

  const processOfflineQueue = useCallback(async () => {
    if (isProcessingQueue) return;
    setIsProcessingQueue(true);
    try {
      const { processed, failed, permanentlyFailed, remaining } = await processQueue(
        async (uri) => ({ text: await transcribeAudio(uri) }),
        async (item, transcript) => {
          await setField(item.fileName, 'transcript', transcript);
          setRecordings((prev) =>
            prev.map((r) =>
              r.fileName === item.fileName ? { ...r, transcript } : r
            )
          );
        }
      );

      const parts: string[] = [];
      if (processed > 0) parts.push(`✅ ${processed} transcrita(s) com sucesso`);
      if (failed > 0) parts.push(`⚠️ ${failed} falhou (tentará novamente depois)`);
      if (permanentlyFailed > 0) parts.push(`❌ ${permanentlyFailed} com erro permanente (arquivo ausente ou muitas tentativas)`);
      if (remaining > 0) parts.push(`${remaining} ainda na fila`);

      if (processed > 0 || failed > 0 || permanentlyFailed > 0) {
        Alert.alert('Fila offline', parts.join('\n'));
      }
    } catch (err) {
      logWarn('queue', err);
      Alert.alert('Erro na fila', 'Não foi possível processar a fila offline.');
    } finally {
      setIsProcessingQueue(false);
      await refreshQueueCount();
    }
  }, [isProcessingQueue, refreshQueueCount]);

  const handleClearFailedItems = useCallback(async () => {
    const items = await getFailedItems();
    if (items.length === 0) return;
    Alert.alert(
      'Limpar erros permanentes',
      `Remover ${items.length} gravação(ões) com falha permanente da fila? As gravações em si não serão apagadas.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Limpar',
          style: 'destructive',
          onPress: async () => {
            await clearFailedItems();
            await refreshQueueCount();
          },
        },
      ]
    );
  }, [refreshQueueCount]);
  const params = useLocalSearchParams();
  const patientFilter =
    typeof params.patient === 'string' ? params.patient : null;
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);

  useEffect(() => {
    if (status?.didJustFinish) setPlayingUri(null);
  }, [status?.didJustFinish]);

  // Libera o player ao desmontar a tela (evita travar a sessao de audio
  // e impedir a gravacao subsequente)
  useEffect(() => {
    return () => {
      try {
        player.pause();
        player.replace(null);
      } catch {}
    };
  }, [player]);

  const loadRecordings = async () => {
    try {
      const dir = FileSystem.documentDirectory;
      if (!dir) return;
      const files = await FileSystem.readDirectoryAsync(dir);
      const audioFiles = files.filter((f) => f.endsWith('.m4a'));
      const localAudioNames = new Set(audioFiles);

      const metaMap = await getAllRecordingsMeta();

      const items: Recording[] = audioFiles.map((fileName) => {
        const uri = `${dir}${fileName}`;
        const match = fileName.match(/recording_(\d+)\.m4a/);
        const createdAt = match
          ? new Date(parseInt(match[1])).toISOString()
          : new Date().toISOString();
        const meta = metaMap.get(fileName);
        return {
          fileName,
          uri,
          createdAt,
          customName: meta?.customName ?? null,
          transcript: meta?.transcript ?? null,
          summary: meta?.summary ?? null,
          templateId: meta?.templateId ?? null,
          patientName: meta?.patientName ?? null,
          durationSecs: meta?.durationSecs ?? null,
          localFileExists: true,
        };
      });

      for (const [fileName, meta] of metaMap.entries()) {
        if (localAudioNames.has(fileName)) continue;
        const match = fileName.match(/recording_(\d+)\.m4a/);
        const createdAt = match
          ? new Date(parseInt(match[1])).toISOString()
          : meta.updatedAt ?? new Date().toISOString();
        items.push({
          fileName,
          uri: `${dir}${fileName}`,
          createdAt,
          customName: meta.customName,
          transcript: meta.transcript,
          summary: meta.summary,
          templateId: meta.templateId,
          patientName: meta.patientName,
          durationSecs: meta.durationSecs,
          localFileExists: false,
        });
      }

      items.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      setRecordings(items);
    } catch (err: any) {
      logError('recordings', err);
      Alert.alert(
        'Erro ao carregar gravações',
        'Não foi possível ler a lista de gravações. Tente fechar e reabrir o app.\n\nDetalhe: ' +
          (err?.message ?? String(err))
      );
    }
  };

  useFocusEffect(
    useCallback(() => {
      loadRecordings();
      getAllTemplates()
        .then((templates) => setAllTemplates(templates))
        .catch(() => {});
      // Refresh queue badge + auto-process pending items when screen opens
      refreshQueueCount().then(() => {
        // Slight delay so the UI renders first
        setTimeout(() => processOfflineQueue(), 800);
      });
    }, [refreshQueueCount, processOfflineQueue])
  );

  // Recarrega a lista sempre que uma transcrição ou processamento terminar
  // (o store incrementa completionCount independente de qual tela está aberta).
  useEffect(() => {
    if (completionCount === 0) return; // ignora a montagem inicial
    loadRecordings();
    refreshQueueCount();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completionCount]);

  const filteredRecordings = useMemo(() => {
    let list = recordings;

    // Patient filter
    if (patientFilter) {
      const pf = normalize(patientFilter);
      list = list.filter((r) => r.patientName && normalize(r.patientName) === pf);
    }

    // Template filter
    if (selectedTemplates.size > 0) {
      list = list.filter((r) => r.templateId && selectedTemplates.has(r.templateId));
    }

    // Status filter
    if (selectedStatuses.size > 0) {
      list = list.filter((r) => {
        const recordingStatus = r.summary ? (r.transcript ? 'finalized' : 'processed') : 'draft';
        return selectedStatuses.has(recordingStatus);
      });
    }

    // Date range filter
    if (dateRange !== 'all') {
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

      if (dateRange === 'custom') {
        const start = parseDateBR(customDateStart);
        const end = parseDateBR(customDateEnd);
        // Only apply if at least one bound is valid
        if (start || end) {
          const startTs = start ? start.getTime() : -Infinity;
          // End-of-day for end date (inclusive)
          const endTs = end ? end.getTime() + 24 * 60 * 60 * 1000 - 1 : Infinity;
          list = list.filter((r) => {
            const t = new Date(r.createdAt).getTime();
            return t >= startTs && t <= endTs;
          });
        }
      } else {
        const cutoff =
          dateRange === 'today'
            ? startOfToday
            : dateRange === 'week'
            ? startOfToday - 6 * 24 * 60 * 60 * 1000
            : startOfToday - 29 * 24 * 60 * 60 * 1000;
        list = list.filter((r) => new Date(r.createdAt).getTime() >= cutoff);
      }
    }

    // Text search
    const q = normalize(searchQuery.trim());
    if (q) {
      list = list.filter((r) => {
        const haystack = normalize(
          [
            r.customName ?? formatDefaultName(r.createdAt),
            r.fileName,
            r.transcript ?? '',
            r.summary ?? '',
          ].join(' ')
        );
        return haystack.includes(q);
      });
    }

    return list;
  }, [recordings, searchQuery, patientFilter, selectedTemplates, selectedStatuses, dateRange, customDateStart, customDateEnd]);

  const togglePlay = (uri: string) => {
    try {
      if (playingUri === uri) {
        if (status?.playing) player.pause();
        else player.play();
      } else {
        player.replace({ uri });
        setPlayingUri(uri);
        player.play();
      }
    } catch (err) {
      logError('recordings', err);
    }
  };

  const handleTranscribe = (item: Recording) => {
    // Delega ao store global — a transcrição roda em background e sobrevive
    // à navegação para outras telas ou ao desmonte deste componente.
    startTranscription({
      fileName: item.fileName,
      uri: item.uri,
      createdAt: item.createdAt,
      localFileExists: item.localFileExists,
    });
  };

  const openTemplatePicker = (callback: (templateId: string) => void) => {
    setPreviewTemplateId(null);
    setTemplatePickerCallback(() => callback);
    setTemplatePickerVisible(true);
  };

  const pickTemplateAndProcess = (item: Recording) => {
    if (!item.transcript) return;
    openTemplatePicker((templateId) => runProcessing(item, templateId));
  };

  const runProcessing = (item: Recording, templateId: string) => {
    if (!item.transcript) return;
    // Delega ao store global — o processamento roda em background e sobrevive
    // à navegação para outras telas ou ao desmonte deste componente.
    startProcessing(
      { fileName: item.fileName, transcript: item.transcript, createdAt: item.createdAt },
      templateId,
    );
  };

  const handleDeleteRecording = async (item: Recording) => {
    try {
      if (playingUri === item.uri) {
        player.pause();
        setPlayingUri(null);
      }
      await FileSystem.deleteAsync(item.uri, { idempotent: true });
      await deleteRecordingMeta(item.fileName);
      // Remove from offline queue — file no longer exists
      await dequeueTranscription(item.fileName);
      await refreshQueueCount();
      loadRecordings();
    } catch (err: any) {
      logError('recordings', err);
      Alert.alert('Erro ao deletar', 'Não foi possível remover a gravação.\n\nDetalhe: ' + (err?.message ?? String(err)));
    }
  };

  const startEdit = (item: Recording) => {
    setEditingFile(item.fileName);
    setEditValue(item.customName ?? formatDefaultName(item.createdAt));
  };

  const cancelEdit = () => {
    setEditingFile(null);
    setEditValue('');
  };

  const saveEdit = async (item: Recording) => {
    const trimmed = editValue.trim();
    if (!trimmed) {
      await clearField(item.fileName, 'customName');
      setRecordings((prev) =>
        prev.map((r) =>
          r.fileName === item.fileName ? { ...r, customName: null } : r
        )
      );
    } else {
      await setField(item.fileName, 'customName', trimmed);
      setRecordings((prev) =>
        prev.map((r) =>
          r.fileName === item.fileName ? { ...r, customName: trimmed } : r
        )
      );
    }
    cancelEdit();
  };

  const copyToClipboard = async (text: string, key: string) => {
    try {
      await Clipboard.setStringAsync(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    } catch (err) {
      logError('recordings', err);
    }
  };

  const shareText = (text: string, title: string) => {
    openShareMenu(text, title);
  };

  const handleExportPDF = async (item: Recording) => {
    const displayName = item.customName ?? formatDefaultName(item.createdAt);
    const doctor = await getDoctorProfile();

    // Warn when the doctor profile is not configured — only for prescription types
    const isPrescription =
      item.templateId === 'medical_prescription' ||
      item.templateId === 'medical_controlled_prescription';

    if (isPrescription && !doctor.name?.trim() && !doctor.crmNumber?.trim()) {
      await new Promise<void>((resolve) => {
        Alert.alert(
          'Perfil não configurado',
          'Seus dados profissionais (nome e CRM) não estão preenchidos. ' +
            'A receita será gerada sem o cabeçalho do médico.\n\n' +
            'Configure em Ajustes → Perfil Profissional.',
          [
            { text: 'Exportar assim mesmo', style: 'default', onPress: () => resolve() },
          ],
          { cancelable: true, onDismiss: () => resolve() }
        );
      });
    }

    await exportRecordingToPDF({
      name: displayName,
      createdAt: item.createdAt,
      transcript: item.transcript,
      summary: item.summary,
      templateName: getTemplateName(item.templateId),
      isMindmap: item.templateId === 'mindmap',
      doctor,
    });
  };

  const handleExportMarkdown = async (item: Recording) => {
    const displayName = item.customName ?? formatDefaultName(item.createdAt);
    const content = item.summary ?? item.transcript ?? '';
    if (!content.trim()) {
      Alert.alert('Atenção', 'Não há conteúdo para exportar. Transcreva ou processe a gravação primeiro.');
      return;
    }
    await exportToMarkdown({
      name: displayName,
      createdAt: item.createdAt,
      templateName: getTemplateName(item.templateId),
      content,
      // include raw transcript as appendix only when there's also a processed summary
      transcript: item.summary ? item.transcript : null,
    });
  };

  const handleExportToEvoPad = async (item: Recording) => {
    if (!item.summary) {
      Alert.alert('Atenção', 'Você precisa processar a gravação com IA antes de exportar.');
      return;
    }

    setExportingUri(item.uri);
    try {
      const doctor = await getDoctorProfile();
      const displayName = item.customName ?? formatDefaultName(item.createdAt);

      const result = await exportToEvoPad({
        patientName: item.patientName ?? 'Paciente sem nome',
        content: item.summary,
        markdown: item.summary,
        cid10: '',
        admissionDate: item.createdAt,
        doctorName: doctor.name,
        doctorCrm: doctor.crmNumber
          ? `${doctor.crmNumber}${doctor.crmUF}`
          : '',
        templateUsed: item.templateId ?? 'summary',
      });

      if (!result.success) {
        Alert.alert('Erro ao exportar para EvoPad', result.error ?? 'Falha desconhecida.');
        return;
      }

      const patientNote = result.patientCreated
        ? '\nPaciente criado automaticamente no EvoPad.'
        : '';
      Alert.alert(
        'Exportado para EvoPad ✓',
        `Evolução registrada com sucesso em ${result.evoPadUrl}.${patientNote}`
      );
    } catch (err: any) {
      logError('handleExportToEvoPad', err);
      Alert.alert('Erro ao exportar', err?.message ?? String(err));
    } finally {
      setExportingUri(null);
    }
  };

  const openEditTranscriptModal = (item: Recording) => {
    setEditingTranscriptFile(item.fileName);
    setEditTranscriptValue(item.transcript ?? '');
    setEditTranscriptOriginal(item.transcript ?? '');
  };

  const closeEditTranscriptModal = () => {
    setEditingTranscriptFile(null);
    setEditTranscriptValue('');
    setEditTranscriptOriginal('');
  };

  const saveEditedTranscript = async (item: Recording) => {
    const trimmed = editTranscriptValue.trim();
    if (!trimmed) {
      Alert.alert('Erro', 'A transcrição não pode estar vazia.');
      return;
    }

    try {
      await setField(item.fileName, 'transcript', trimmed);
      setRecordings((prev) =>
        prev.map((r) =>
          r.fileName === item.fileName ? { ...r, transcript: trimmed } : r
        )
      );
      closeEditTranscriptModal();
      Alert.alert('Sucesso', 'Transcrição atualizada. Você pode reprocessá-la com IA.');
    } catch {
      Alert.alert('Erro', 'Falha ao salvar transcrição editada.');
    }
  };

  const reprocessEditedTranscript = (item: Recording) => {
    // Captura o valor ANTES de fechar o modal — `editTranscriptValue` é zerado em closeEditTranscriptModal
    const editedText = editTranscriptValue.trim();
    if (!editedText) {
      Alert.alert('Erro', 'A transcrição não pode estar vazia.');
      return;
    }
    closeEditTranscriptModal();
    // Slight delay so the transcript modal animates out before the template picker opens
    setTimeout(() => {
      openTemplatePicker((templateId) =>
        runProcessingWithEditedTranscript(item, editedText, templateId)
      );
    }, 350);
  };

  const runProcessingWithEditedTranscript = (
    item: Recording,
    editedText: string,
    templateId: string
  ) => {
    // Usa o store global — roda em background e sobrevive à navegação.
    // A lista é atualizada automaticamente via completionCount quando terminar.
    startProcessing(
      { fileName: item.fileName, transcript: editedText, createdAt: item.createdAt },
      templateId,
    );
  };

  const formatDate = (iso: string) => new Date(iso).toLocaleString('pt-BR');

  const getTemplateName = (id: string | null): string => {
    if (!id) return 'RESUMO';
    const t = allTemplates.find((t) => t.id === id);
    return t ? t.name.toUpperCase() : 'RESUMO';
  };

  // extraData da FlatList — calculado no topo do componente (NUNCA dentro do JSX).
  // Chamar useMemo dentro do JSX viola as Rules of Hooks e, com o React Compiler
  // ativado, pode quebrar a ordem dos hooks e crashar a tela em release.
  const listExtraData = useMemo(
    () => ({
      playingUri,
      transcribingFiles,
      processingFiles,
      exportingUri,
      editingFile,
      copiedKey,
      editValue,
    }),
    [playingUri, transcribingFiles, processingFiles, exportingUri, editingFile, copiedKey, editValue]
  );

  return (
    <YStack f={1} bg={c.bgScreen} p="$4" gap="$3">
      <XStack alignItems="center" gap="$3" mt="$6">
        <Link href="/" asChild>
          <Pressable accessibilityRole="button" accessibilityLabel="Voltar para gravação">
            <ArrowLeft size={28} color={c.primary} />
          </Pressable>
        </Link>
        <Text fontSize={24} fontWeight="800" color={c.primary}>
          Minhas Gravações
        </Text>
      </XStack>

      {(queueCount > 0 || failedCount > 0) && (
        <YStack gap="$2">
          {queueCount > 0 && (
            <XStack
              bg={c.bgYellowSoft}
              borderWidth={1}
              borderColor={c.borderYellow}
              p="$3"
              borderRadius="$3"
              alignItems="center"
              gap="$2"
            >
              <CloudOff size={18} color={c.accentOrange} />
              <YStack f={1}>
                <Text fontSize={13} fontWeight="700" color={c.accentYellow}>
                  {queueCount} transcrição(ões) na fila offline
                </Text>
                <Text fontSize={11} color={c.textSecondary}>
                  {isProcessingQueue
                    ? 'Processando agora…'
                    : 'Tentaremos processar quando a conexão retornar.'}
                </Text>
              </YStack>
              {!isProcessingQueue && (
                <Pressable
                  onPress={processOfflineQueue}
                  accessibilityRole="button"
                  accessibilityLabel="Tentar processar fila offline agora"
                >
                  <XStack
                    bg={c.accentOrange}
                    paddingHorizontal="$3"
                    paddingVertical="$2"
                    borderRadius="$3"
                    alignItems="center"
                    gap="$1"
                  >
                    {/* accentOrange é claro em ambos os temas → texto preto garante contraste */}
                    <RefreshCw size={14} color="#000000" />
                    <Text fontSize={12} color="#000000" fontWeight="700">
                      Tentar agora
                    </Text>
                  </XStack>
                </Pressable>
              )}
            </XStack>
          )}

          {failedCount > 0 && (
            <XStack
              bg="rgba(192,57,43,0.07)"
              borderWidth={1}
              borderColor="rgba(192,57,43,0.25)"
              p="$3"
              borderRadius="$3"
              alignItems="center"
              gap="$2"
            >
              <Trash2 size={18} color={c.accentRed} />
              <YStack f={1}>
                <Text fontSize={13} fontWeight="700" color={c.accentRed}>
                  {failedCount} transcrição(ões) com falha permanente
                </Text>
                <Text fontSize={11} color={c.textSecondary}>
                  Arquivo ausente ou muitas tentativas sem sucesso.
                </Text>
              </YStack>
              <Pressable
                onPress={handleClearFailedItems}
                accessibilityRole="button"
                accessibilityLabel="Limpar transcrições com falha permanente"
              >
                <XStack
                  bg={c.accentRed}
                  paddingHorizontal="$3"
                  paddingVertical="$2"
                  borderRadius="$3"
                  alignItems="center"
                  gap="$1"
                >
                  <X size={14} color={c.textOnAccent} />
                  <Text fontSize={12} color={c.textOnAccent} fontWeight="700">
                    Limpar
                  </Text>
                </XStack>
              </Pressable>
            </XStack>
          )}
        </YStack>
      )}

      {patientFilter && (
        <XStack
          bg={c.bgBlueSoft}
          borderWidth={1}
          borderColor={c.accentBlue}
          p="$3"
          borderRadius="$3"
          alignItems="center"
          gap="$2"
        >
          <User size={18} color={c.accentBlue} />
          <YStack f={1}>
            <Text fontSize={11} color={c.accentNavy} fontWeight="600">
              FILTRANDO POR PACIENTE
            </Text>
            <Text fontSize={14} color={c.accentBlue} fontWeight="700">
              {patientFilter}
            </Text>
          </YStack>
          <Link href="/recordings" asChild>
            <Pressable
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Remover filtro de paciente"
            >
              <X size={20} color={c.accentBlue} />
            </Pressable>
          </Link>
        </XStack>
      )}

      {recordings.length > 0 && (
        <XStack
          bg={c.bgCard}
          borderRadius="$4"
          alignItems="center"
          px="$3"
          gap="$2"
        >
          <Search size={18} color={c.textSecondary} />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Buscar por nome, transcrição ou resumo..."
            placeholderTextColor={c.textPlaceholder}
            autoCorrect={false}
            autoCapitalize="none"
            style={{
              flex: 1,
              paddingVertical: 10,
              fontSize: 14,
              color: c.text,
            }}
            accessibilityLabel="Buscar gravações"
            accessibilityHint="Filtra gravações por nome, transcrição ou resumo"
          />
          {searchQuery.length > 0 && (
            <Pressable
              onPress={() => setSearchQuery('')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Limpar busca"
            >
              <X size={18} color={c.textSecondary} />
            </Pressable>
          )}
        </XStack>
      )}

      {recordings.length > 0 && (
        <>
          {/* Filter Toggle */}
          <Pressable
            onPress={() => setShowFilters(!showFilters)}
            accessibilityRole="button"
            accessibilityLabel={showFilters ? 'Fechar filtros avançados' : 'Abrir filtros avançados'}
            accessibilityState={{ expanded: showFilters }}
          >
            <XStack
              bg={showFilters ? c.bgPurpleSoft : c.bgSubtle}
              borderWidth={showFilters ? 1 : 0}
              borderColor={c.borderPurple}
              p="$3"
              borderRadius="$3"
              alignItems="center"
              justifyContent="space-between"
              gap="$2"
            >
              <Text fontWeight="700" fontSize={13} color={c.secondary}>
                {showFilters ? '▼ Filtros Avançados' : '▶ Filtros Avançados'}
              </Text>
              {selectedTemplates.size > 0 || selectedStatuses.size > 0 || dateRange !== 'all' ? (
                <Text fontSize={11} color={c.primary} fontWeight="700">
                  {selectedTemplates.size + selectedStatuses.size + (dateRange !== 'all' ? 1 : 0)} filtro(s) ativo(s)
                </Text>
              ) : null}
            </XStack>
          </Pressable>

          {/* Filter Panel */}
          {showFilters && (
            <YStack bg={c.bgPurpleSoft} p="$3" borderRadius="$3" gap="$3" borderWidth={1} borderColor={c.borderPurple}>
              {/* Date Range Filter */}
              <YStack gap="$2">
                <Text fontWeight="700" fontSize={12} color={c.secondary}>
                  Período
                </Text>
                <XStack gap="$1" flexWrap="wrap">
                  {([
                    { id: 'all', label: 'Todas' },
                    { id: 'today', label: 'Hoje' },
                    { id: 'week', label: '7 dias' },
                    { id: 'month', label: '30 dias' },
                    { id: 'custom', label: 'Personalizado' },
                  ] as const).map((opt) => {
                    const active = dateRange === opt.id;
                    return (
                      <Pressable
                        key={opt.id}
                        onPress={() => setDateRange(opt.id)}
                        accessibilityRole="radio"
                        accessibilityLabel={opt.label}
                        accessibilityState={{ checked: active }}
                      >
                        <XStack
                          bg={active ? c.secondary : c.bgScreen}
                          borderWidth={1}
                          borderColor={active ? c.secondary : c.borderPurple}
                          paddingHorizontal="$3"
                          paddingVertical="$2"
                          borderRadius="$3"
                          alignItems="center"
                        >
                          <Text
                            fontSize={12}
                            fontWeight={active ? '700' : '500'}
                            color={active ? c.textOnAccent : c.textLabel}
                          >
                            {opt.label}
                          </Text>
                        </XStack>
                      </Pressable>
                    );
                  })}
                </XStack>

                {/* Custom date range inputs (only when "Personalizado" selected) */}
                {dateRange === 'custom' && (
                  <YStack gap="$2" mt="$2">
                    <XStack gap="$2" alignItems="center">
                      <YStack flex={1} gap="$1">
                        <Text fontSize={11} color={c.textSecondary}>De</Text>
                        <TextInput
                          value={customDateStart}
                          onChangeText={(t) => setCustomDateStart(autoFormatDateBR(t))}
                          placeholder="DD/MM/AAAA"
                          placeholderTextColor={c.textPlaceholder}
                          keyboardType="number-pad"
                          maxLength={10}
                          style={{
                            backgroundColor: c.bgInput,
                            borderWidth: 1,
                            borderColor: customDateStart && !parseDateBR(customDateStart) ? c.accentRed : c.borderInput,
                            borderRadius: 8,
                            padding: 10,
                            color: c.text,
                            fontSize: 13,
                          }}
                        />
                      </YStack>
                      <YStack flex={1} gap="$1">
                        <Text fontSize={11} color={c.textSecondary}>Até</Text>
                        <TextInput
                          value={customDateEnd}
                          onChangeText={(t) => setCustomDateEnd(autoFormatDateBR(t))}
                          placeholder="DD/MM/AAAA"
                          placeholderTextColor={c.textPlaceholder}
                          keyboardType="number-pad"
                          maxLength={10}
                          style={{
                            backgroundColor: c.bgInput,
                            borderWidth: 1,
                            borderColor: customDateEnd && !parseDateBR(customDateEnd) ? c.accentRed : c.borderInput,
                            borderRadius: 8,
                            padding: 10,
                            color: c.text,
                            fontSize: 13,
                          }}
                        />
                      </YStack>
                    </XStack>
                    {(customDateStart || customDateEnd) && (
                      <XStack gap="$2" alignItems="center" justifyContent="space-between">
                        <Text fontSize={11} color={c.textSecondary}>
                          {parseDateBR(customDateStart) && parseDateBR(customDateEnd)
                            ? `Filtrando entre ${customDateStart} e ${customDateEnd}`
                            : parseDateBR(customDateStart)
                            ? `A partir de ${customDateStart}`
                            : parseDateBR(customDateEnd)
                            ? `Até ${customDateEnd}`
                            : 'Digite datas válidas (DD/MM/AAAA)'}
                        </Text>
                        <Pressable
                          onPress={() => {
                            setCustomDateStart('');
                            setCustomDateEnd('');
                          }}
                          accessibilityRole="button"
                          accessibilityLabel="Limpar datas personalizadas"
                        >
                          <Text fontSize={11} color={c.secondary} fontWeight="700">
                            Limpar
                          </Text>
                        </Pressable>
                      </XStack>
                    )}
                  </YStack>
                )}
              </YStack>

              {/* Template Filter */}
              <YStack gap="$2">
                <Text fontWeight="700" fontSize={12} color={c.secondary}>
                  Templates
                </Text>
                <YStack gap="$1">
                  {allTemplates.map((t) => (
                    <Pressable
                      key={t.id}
                      onPress={() => {
                        const newSet = new Set(selectedTemplates);
                        if (newSet.has(t.id)) {
                          newSet.delete(t.id);
                        } else {
                          newSet.add(t.id);
                        }
                        setSelectedTemplates(newSet);
                      }}
                      accessibilityRole="checkbox"
                      accessibilityLabel={t.name}
                      accessibilityState={{ checked: selectedTemplates.has(t.id) }}
                    >
                      <XStack alignItems="center" gap="$2" p="$2">
                        <YStack
                          width={16}
                          height={16}
                          borderWidth={1}
                          borderColor={c.secondary}
                          borderRadius="$2"
                          alignItems="center"
                          justifyContent="center"
                          bg={selectedTemplates.has(t.id) ? c.secondary : 'transparent'}
                        >
                          {selectedTemplates.has(t.id) && (
                            <Text color={c.textOnAccent} fontSize={12} fontWeight="700">
                              ✓
                            </Text>
                          )}
                        </YStack>
                        <Text fontSize={12} color={c.textLabel}>
                          {t.name}
                        </Text>
                      </XStack>
                    </Pressable>
                  ))}
                </YStack>
              </YStack>

              {/* Status Filter */}
              <YStack gap="$2">
                <Text fontWeight="700" fontSize={12} color={c.secondary}>
                  Status
                </Text>
                <YStack gap="$1">
                  {['draft', 'processed', 'finalized'].map((s) => (
                    <Pressable
                      key={s}
                      onPress={() => {
                        const newSet = new Set(selectedStatuses);
                        if (newSet.has(s)) {
                          newSet.delete(s);
                        } else {
                          newSet.add(s);
                        }
                        setSelectedStatuses(newSet);
                      }}
                      accessibilityRole="checkbox"
                      accessibilityLabel={s === 'draft' ? 'Sem transcrição' : s === 'processed' ? 'Sem resumo' : 'Completo'}
                      accessibilityState={{ checked: selectedStatuses.has(s) }}
                    >
                      <XStack alignItems="center" gap="$2" p="$2">
                        <YStack
                          width={16}
                          height={16}
                          borderWidth={1}
                          borderColor={c.secondary}
                          borderRadius="$2"
                          alignItems="center"
                          justifyContent="center"
                          bg={selectedStatuses.has(s) ? c.secondary : 'transparent'}
                        >
                          {selectedStatuses.has(s) && (
                            <Text color={c.textOnAccent} fontSize={12} fontWeight="700">
                              ✓
                            </Text>
                          )}
                        </YStack>
                        <Text fontSize={12} color={c.textLabel} textTransform="capitalize">
                          {s === 'draft' ? 'Sem transcrição' : s === 'processed' ? 'Sem resumo' : 'Completo'}
                        </Text>
                      </XStack>
                    </Pressable>
                  ))}
                </YStack>
              </YStack>

              {/* Clear Filters */}
              {selectedTemplates.size > 0 || selectedStatuses.size > 0 || dateRange !== 'all' ? (
                <Pressable
                  onPress={() => {
                    setSelectedTemplates(new Set());
                    setSelectedStatuses(new Set());
                    setDateRange('all');
                    setCustomDateStart('');
                    setCustomDateEnd('');
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Limpar todos os filtros"
                >
                  <XStack
                    bg={c.bgScreen}
                    borderWidth={1}
                    borderColor={c.borderPurple}
                    p="$2"
                    borderRadius="$3"
                    alignItems="center"
                    justifyContent="center"
                    gap="$2"
                  >
                    <X size={14} color={c.secondary} />
                    <Text color={c.secondary} fontWeight="700" fontSize={12}>
                      Limpar filtros
                    </Text>
                  </XStack>
                </Pressable>
              ) : null}
            </YStack>
          )}
        </>
      )}

      {recordings.length === 0 ? (
        <YStack f={1} alignItems="center" justifyContent="center">
          <Text color={c.textMuted} fontSize={16}>
            Nenhuma gravação ainda.
          </Text>
        </YStack>
      ) : filteredRecordings.length === 0 ? (
        <YStack f={1} alignItems="center" justifyContent="center" gap="$2">
          <Search size={32} color={c.textPlaceholder} />
          <Text color={c.textMuted} fontSize={16} fontWeight="700">
            Nenhum resultado
          </Text>
          <Text color={c.textPlaceholder} fontSize={13}>
            Nada encontrado para &quot;{searchQuery}&quot;
          </Text>
        </YStack>
      ) : (
        <>
          {searchQuery.length > 0 && (
            <Text color={c.textSecondary} fontSize={12} px="$1">
              {filteredRecordings.length} resultado(s) para &quot;{searchQuery}&quot;
            </Text>
          )}
          <FlatList
            data={filteredRecordings}
            keyExtractor={(item) => item.fileName}
            contentContainerStyle={{ gap: 12, paddingVertical: 12 }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            removeClippedSubviews
            initialNumToRender={8}
            maxToRenderPerBatch={6}
            windowSize={11}
            updateCellsBatchingPeriod={50}
            extraData={listExtraData}
            renderItem={({ item }) => {
              const isThisPlaying = playingUri === item.uri && status?.playing;
              const isTranscribing = transcribingFiles.has(item.fileName);
              const isProcessing = processingFiles.has(item.fileName);
              const isEditing = editingFile === item.fileName;
              const displayName =
                item.customName ?? formatDefaultName(item.createdAt);
              const transcriptCopyKey = `transcript_${item.fileName}`;
              const summaryCopyKey = `summary_${item.fileName}`;

              // Search snippet — show where match was found if not in the title
              const q = searchQuery.trim();
              const nameMatches = q
                ? normalize(displayName + ' ' + item.fileName).includes(normalize(q))
                : false;
              const transcriptSnippet =
                q && !nameMatches ? getSearchSnippet(item.transcript, q) : null;
              const summarySnippet =
                q && !nameMatches && !transcriptSnippet
                  ? getSearchSnippet(item.summary, q)
                  : null;
              const matchSnippet = transcriptSnippet ?? summarySnippet;
              const matchLabel = transcriptSnippet
                ? 'na transcrição'
                : summarySnippet
                ? 'no resumo'
                : null;

              const renderRightActions = () => (
                <Pressable
                  style={swipeStyles.deleteAction}
                  onPress={() => {
                    swipeableRefs.current.get(item.fileName)?.close();
                    Alert.alert(
                      'Deletar gravação',
                      `Deletar "${displayName}"?`,
                      [
                        { text: 'Cancelar', style: 'cancel' },
                        {
                          text: 'Deletar',
                          style: 'destructive',
                          onPress: () => handleDeleteRecording(item),
                        },
                      ]
                    );
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Deletar gravação: ${displayName}`}
                >
                  <Trash2 size={22} color="#fff" />
                  <Text style={swipeStyles.actionText}>Deletar</Text>
                </Pressable>
              );

              const renderLeftActions = () => (
                <Pressable
                  style={swipeStyles.renameAction}
                  onPress={() => {
                    swipeableRefs.current.get(item.fileName)?.close();
                    startEdit(item);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Renomear gravação: ${displayName}`}
                >
                  <Pencil size={22} color="#fff" />
                  <Text style={swipeStyles.actionText}>Renomear</Text>
                </Pressable>
              );

              return (
                <Swipeable
                  ref={(ref) => { swipeableRefs.current.set(item.fileName, ref); }}
                  renderRightActions={renderRightActions}
                  renderLeftActions={renderLeftActions}
                  friction={2}
                  overshootLeft={false}
                  overshootRight={false}
                  onSwipeableOpen={() => {
                    // Close the previously open swipeable
                    if (
                      lastOpenSwipeable.current &&
                      lastOpenSwipeable.current !== swipeableRefs.current.get(item.fileName)
                    ) {
                      lastOpenSwipeable.current.close();
                    }
                    lastOpenSwipeable.current =
                      swipeableRefs.current.get(item.fileName) ?? null;
                  }}
                >
                <YStack
                  bg={c.bgCard}
                  p="$3"
                  borderRadius="$4"
                  gap="$3"
                  opacity={item.localFileExists ? 1 : 0.5}
                >
                  <XStack alignItems="center" gap="$3">
                    <Pressable
                      onPress={() => togglePlay(item.uri)}
                      disabled={!item.localFileExists}
                      accessibilityRole="button"
                      accessibilityLabel={
                        !item.localFileExists
                          ? 'Áudio indisponível neste dispositivo'
                          : isThisPlaying
                          ? `Pausar: ${displayName}`
                          : `Reproduzir: ${displayName}`
                      }
                      accessibilityState={{ disabled: !item.localFileExists }}
                    >
                      {!item.localFileExists ? (
                        <CloudOff size={32} color={c.textPlaceholder} />
                      ) : isThisPlaying ? (
                        <Pause size={32} color={c.primary} />
                      ) : (
                        <Play size={32} color={c.primary} />
                      )}
                    </Pressable>

                    <YStack f={1}>
                      {/* Patient chip */}
                      {item.patientName && !isEditing && (
                        <XStack
                          bg={c.bgBlueSoft}
                          px="$2"
                          py={2}
                          borderRadius={999}
                          alignSelf="flex-start"
                          mb="$1"
                        >
                          <Text fontSize={10} fontWeight="700" color={c.primaryDeep}>
                            {item.patientName}
                          </Text>
                        </XStack>
                      )}

                      {isEditing ? (
                        <XStack alignItems="center" gap="$2">
                          <TextInput
                            value={editValue}
                            onChangeText={setEditValue}
                            autoFocus
                            placeholder="Nome da gravação"
                            style={{
                              flex: 1,
                              borderWidth: 1,
                              borderColor: c.primary,
                              borderRadius: 6,
                              paddingHorizontal: 8,
                              paddingVertical: 6,
                              fontSize: 14,
                              backgroundColor: c.bgInput,
                              color: c.text,
                            }}
                            onSubmitEditing={() => saveEdit(item)}
                            returnKeyType="done"
                            accessibilityLabel="Nome da gravação"
                            accessibilityHint="Digite o novo nome para esta gravação"
                          />
                          <Pressable
                            onPress={() => saveEdit(item)}
                            accessibilityRole="button"
                            accessibilityLabel="Salvar nome"
                          >
                            <Check size={22} color={c.primary} />
                          </Pressable>
                          <Pressable
                            onPress={cancelEdit}
                            accessibilityRole="button"
                            accessibilityLabel="Cancelar renomeação"
                          >
                            <X size={22} color={c.accentRed} />
                          </Pressable>
                        </XStack>
                      ) : (
                        <XStack alignItems="center" gap="$2">
                          <Text
                            fontWeight="700"
                            fontSize={14}
                            f={1}
                            numberOfLines={1}
                          >
                            {displayName}
                          </Text>
                          <Pressable
                            onPress={() => startEdit(item)}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel={`Renomear: ${displayName}`}
                          >
                            <Pencil size={16} color={c.textSecondary} />
                          </Pressable>
                        </XStack>
                      )}
                      <Text color={c.textMuted} fontSize={12} mt="$1">
                        {formatDate(item.createdAt)}
                        {item.durationSecs
                          ? ` · ${formatDuration(item.durationSecs)}`
                          : ''}
                      </Text>
                      {matchSnippet && matchLabel && (
                        <XStack gap="$1" alignItems="flex-start" mt="$1">
                          <Search size={11} color={c.accentBlue} style={{ marginTop: 2 }} />
                          <Text fontSize={11} color={c.textSecondary} flex={1} numberOfLines={2}>
                            <Text fontSize={11} fontWeight="700" color={c.accentBlue}>
                              {matchLabel}:{' '}
                            </Text>
                            {matchSnippet}
                          </Text>
                        </XStack>
                      )}
                      {!item.localFileExists && (
                        <Text color={c.textPlaceholder} fontSize={11} mt="$1">
                          Áudio não está neste dispositivo
                        </Text>
                      )}
                    </YStack>

                    <Pressable
                      onPress={() => handleExportPDF(item)}
                      hitSlop={6}
                      accessibilityRole="button"
                      accessibilityLabel={`Exportar PDF: ${displayName}`}
                    >
                      <FileDown size={22} color={c.accentBlue} />
                    </Pressable>

                    <Pressable
                      onPress={() => handleExportMarkdown(item)}
                      hitSlop={6}
                      accessibilityRole="button"
                      accessibilityLabel={`Exportar Markdown: ${displayName}`}
                    >
                      <FileCode size={22} color={c.accentBlue} />
                    </Pressable>

                    <Pressable
                      onPress={() => {
                        Alert.alert(
                          'Excluir gravação',
                          `Tem certeza que deseja excluir "${displayName}"? Esta ação não pode ser desfeita.`,
                          [
                            { text: 'Cancelar', style: 'cancel' },
                            {
                              text: 'Excluir',
                              style: 'destructive',
                              onPress: () => handleDeleteRecording(item),
                            },
                          ]
                        );
                      }}
                      hitSlop={6}
                      accessibilityRole="button"
                      accessibilityLabel={`Excluir gravação: ${displayName}`}
                    >
                      <Trash2 size={22} color={c.accentRed} />
                    </Pressable>
                  </XStack>

                  {/* Template badge — shown when a summary exists */}
                  {item.summary && item.templateId && (
                    <XStack
                      bg={c.bgPurpleSoft}
                      px="$2"
                      py={2}
                      borderRadius={999}
                      alignSelf="flex-start"
                      borderWidth={1}
                      borderColor={c.borderPurple}
                    >
                      <Text fontSize={10} fontWeight="700" color={c.primaryDeep}>
                        {BUILTIN_TEMPLATES.find((t) => t.id === item.templateId)?.name
                          ?? item.templateId}
                      </Text>
                    </XStack>
                  )}

                  {/* Audio progress bar — only shown when this recording is active */}
                  {playingUri === item.uri && item.localFileExists && (
                    <AudioPlayerBar
                      currentTime={status?.currentTime ?? 0}
                      duration={status?.duration ?? 0}
                      isBuffering={status?.isBuffering}
                      onSeek={(ratio) => {
                        const d = status?.duration ?? 0;
                        if (d > 0) player.seekTo(ratio * d);
                      }}
                      onSpeedChange={(rate) => {
                        try { player.setPlaybackRate(rate); } catch {}
                      }}
                    />
                  )}

                  {item.summary && (
                    <YStack
                      bg={c.bgPurpleSoft}
                      p="$3"
                      borderRadius="$3"
                      borderWidth={1}
                      borderColor={c.borderPurple}
                      gap="$2"
                    >
                      <XStack alignItems="center" gap="$2">
                        <BookOpen size={16} color={c.secondary} />
                        <Text
                          fontWeight="700"
                          fontSize={12}
                          color={c.secondary}
                          f={1}
                        >
                          {getTemplateName(item.templateId)}
                        </Text>
                        {copiedKey === summaryCopyKey ? (
                          <Text fontSize={11} color={c.primary} fontWeight="700">
                            Copiado!
                          </Text>
                        ) : (
                          <Pressable
                            onPress={() =>
                              copyToClipboard(stripMarkers(item.summary!), summaryCopyKey)
                            }
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel="Copiar resumo"
                          >
                            <Copy size={16} color={c.secondary} />
                          </Pressable>
                        )}
                        <Pressable
                          onPress={() =>
                            shareText(stripMarkers(item.summary!),
                              `${getTemplateName(item.templateId)} - ${displayName}`
                            )
                          }
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel="Compartilhar resumo"
                        >
                          <Share2 size={16} color={c.secondary} />
                        </Pressable>
                      </XStack>

                      {item.templateId === 'mindmap' ? (
                        <MermaidView code={item.summary!} />
                      ) : (
                        <Text fontSize={14} color={c.accentGreenDark} lineHeight={20}>
                          {stripMarkers(item.summary!)}
                        </Text>
                      )}

                      <XStack gap="$2">
                        <Pressable
                          onPress={() => pickTemplateAndProcess(item)}
                          disabled={isProcessing}
                          style={{ flex: 1 }}
                          accessibilityRole="button"
                          accessibilityLabel={isProcessing ? 'Processando com IA…' : 'Reprocessar com IA'}
                          accessibilityState={{ busy: isProcessing, disabled: isProcessing }}
                        >
                          <XStack
                            bg={c.bgScreen}
                            borderWidth={1}
                            borderColor={c.borderPurple}
                            p="$2"
                            borderRadius="$3"
                            alignItems="center"
                            justifyContent="center"
                            gap="$2"
                            mt="$1"
                          >
                            {isProcessing ? (
                              <>
                                <ActivityIndicator color={c.secondary} size="small" />
                                <Text
                                  color={c.secondary}
                                  fontWeight="700"
                                  fontSize={12}
                                >
                                  Processando...
                                </Text>
                              </>
                            ) : (
                              <>
                                <RefreshCw size={14} color={c.secondary} />
                                <Text
                                  color={c.secondary}
                                  fontWeight="700"
                                  fontSize={12}
                                >
                                  Reprocessar
                                </Text>
                              </>
                            )}
                          </XStack>
                        </Pressable>

                        <Pressable
                          onPress={() => handleExportToEvoPad(item)}
                          disabled={isProcessing || exportingUri === item.uri}
                          style={{ flex: 1 }}
                          accessibilityRole="button"
                          accessibilityLabel={exportingUri === item.uri ? 'Exportando para EvoPad…' : 'Exportar para EvoPad'}
                          accessibilityState={{ busy: exportingUri === item.uri, disabled: isProcessing || exportingUri === item.uri }}
                        >
                          <XStack
                            bg={c.bgGreenSoft}
                            borderWidth={1}
                            borderColor={c.primary}
                            p="$2"
                            borderRadius="$3"
                            alignItems="center"
                            justifyContent="center"
                            gap="$2"
                            mt="$1"
                          >
                            {exportingUri === item.uri ? (
                              <>
                                <ActivityIndicator color={c.primary} size="small" />
                                <Text
                                  color={c.primary}
                                  fontWeight="700"
                                  fontSize={12}
                                >
                                  Exportando...
                                </Text>
                              </>
                            ) : (
                              <>
                                <Upload size={14} color={c.primary} />
                                <Text
                                  color={c.primary}
                                  fontWeight="700"
                                  fontSize={12}
                                >
                                  Exportar EvoPad
                                </Text>
                              </>
                            )}
                          </XStack>
                        </Pressable>
                      </XStack>
                    </YStack>
                  )}

                  {item.transcript ? (
                    <YStack
                      bg={c.bgScreen}
                      p="$3"
                      borderRadius="$3"
                      borderWidth={1}
                      borderColor={c.border}
                      gap="$2"
                    >
                      <XStack alignItems="center" gap="$2">
                        <FileText size={16} color={c.primary} />
                        <Text
                          fontWeight="700"
                          fontSize={12}
                          color={c.primary}
                          f={1}
                        >
                          TRANSCRIÇÃO
                        </Text>
                        {copiedKey === transcriptCopyKey ? (
                          <Text fontSize={11} color={c.primary} fontWeight="700">
                            Copiado!
                          </Text>
                        ) : (
                          <Pressable
                            onPress={() =>
                              copyToClipboard(
                                item.transcript!,
                                transcriptCopyKey
                              )
                            }
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel="Copiar transcrição"
                          >
                            <Copy size={16} color={c.primary} />
                          </Pressable>
                        )}
                        <Pressable
                          onPress={() =>
                            shareText(
                              item.transcript!,
                              `Transcrição - ${displayName}`
                            )
                          }
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel="Compartilhar transcrição"
                        >
                          <Share2 size={16} color={c.primary} />
                        </Pressable>
                        <Pressable
                          onPress={() => openEditTranscriptModal(item)}
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel="Editar transcrição"
                        >
                          <Pencil size={16} color={c.primary} />
                        </Pressable>
                      </XStack>
                      <Text
                        fontSize={14}
                        color={c.text}
                        lineHeight={20}
                        numberOfLines={
                          isTranscriptLong(item.transcript)
                            ? TRANSCRIPT_PREVIEW_LINES
                            : undefined
                        }
                      >
                        {item.transcript}
                      </Text>

                      {isTranscriptLong(item.transcript) && (
                        <Pressable
                          onPress={() => setViewingTranscriptFile(item.fileName)}
                          accessibilityRole="button"
                          accessibilityLabel="Ver transcrição completa"
                          accessibilityHint="Abre a transcrição inteira em tela cheia"
                        >
                          <XStack
                            bg={c.bgSubtle}
                            borderWidth={1}
                            borderColor={c.border}
                            p="$2"
                            borderRadius="$3"
                            alignItems="center"
                            justifyContent="center"
                            gap="$2"
                            mt="$1"
                          >
                            <BookOpen size={14} color={c.primary} />
                            <Text color={c.primary} fontWeight="700" fontSize={12}>
                              Ver transcrição completa
                            </Text>
                          </XStack>
                        </Pressable>
                      )}

                      {!item.summary && (
                        <Pressable
                          onPress={() => pickTemplateAndProcess(item)}
                          disabled={isProcessing}
                          accessibilityRole="button"
                          accessibilityLabel={isProcessing ? 'Processando com IA…' : 'Processar com IA'}
                          accessibilityHint="Escolhe um template e gera um resumo estruturado da transcrição"
                          accessibilityState={{ busy: isProcessing, disabled: isProcessing }}
                        >
                          <XStack
                            bg={isProcessing ? c.borderPurple : c.secondary}
                            p="$2"
                            borderRadius="$3"
                            alignItems="center"
                            justifyContent="center"
                            gap="$2"
                            mt="$2"
                          >
                            {isProcessing ? (
                              <>
                                <ActivityIndicator color={c.textOnAccent} size="small" />
                                <Text
                                  color={c.textOnAccent}
                                  fontWeight="700"
                                  fontSize={13}
                                >
                                  Processando...
                                </Text>
                              </>
                            ) : (
                              <>
                                <Sparkles size={16} color={c.textOnAccent} />
                                <Text
                                  color={c.textOnAccent}
                                  fontWeight="700"
                                  fontSize={13}
                                >
                                  Processar com IA
                                </Text>
                              </>
                            )}
                          </XStack>
                        </Pressable>
                      )}
                    </YStack>
                  ) : (
                    <Pressable
                      onPress={() => handleTranscribe(item)}
                      disabled={isTranscribing || !item.localFileExists}
                      accessibilityRole="button"
                      accessibilityLabel={
                        isTranscribing
                          ? 'Transcrevendo…'
                          : !item.localFileExists
                          ? 'Áudio indisponível — transcrição não possível'
                          : `Transcrever com IA: ${displayName}`
                      }
                      accessibilityState={{
                        busy: isTranscribing,
                        disabled: isTranscribing || !item.localFileExists,
                      }}
                    >
                      <XStack
                        bg={
                          isTranscribing || !item.localFileExists
                            ? c.textPlaceholder
                            : c.primary
                        }
                        p="$3"
                        borderRadius="$3"
                        alignItems="center"
                        justifyContent="center"
                        gap="$2"
                      >
                        {isTranscribing ? (
                          <>
                            <ActivityIndicator color={c.textOnAccent} size="small" />
                            <Text color={c.textOnAccent} fontWeight="700">
                              Transcrevendo...
                            </Text>
                          </>
                        ) : (
                          <>
                            {item.localFileExists ? (
                              <Sparkles size={20} color={c.textOnAccent} />
                            ) : (
                              <CloudOff size={20} color={c.textOnAccent} />
                            )}
                            <Text color={c.textOnAccent} fontWeight="700">
                              {item.localFileExists
                                ? 'Transcrever com IA'
                                : 'Áudio indisponível'}
                            </Text>
                          </>
                        )}
                      </XStack>
                    </Pressable>
                  )}
                </YStack>
                </Swipeable>
              );
            }}
          />
        </>
      )}

      {/* Template Picker Modal */}
      <Modal
        visible={templatePickerVisible}
        animationType="slide"
        transparent
        accessibilityViewIsModal
        onRequestClose={() => setTemplatePickerVisible(false)}
      >
        <Pressable
          style={swipeStyles.pickerBackdrop}
          onPress={() => setTemplatePickerVisible(false)}
          accessibilityRole="button"
          accessibilityLabel="Fechar seletor de templates"
        />
        <View style={[swipeStyles.pickerSheet, { backgroundColor: c.bgScreen }]}>
          <XStack
            alignItems="center"
            gap="$2"
            p="$4"
            borderBottomWidth={1}
            borderBottomColor={c.border}
          >
            <Sparkles size={20} color={c.secondary} />
            <Text fontSize={18} fontWeight="800" color={c.text} f={1}>
              Escolher Template
            </Text>
            <Pressable
              onPress={() => setTemplatePickerVisible(false)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Fechar"
            >
              <X size={24} color={c.textSecondary} />
            </Pressable>
          </XStack>

          <FlatList
            data={allTemplates}
            keyExtractor={(t) => t.id}
            contentContainerStyle={{ padding: 12, gap: 8 }}
            keyboardShouldPersistTaps="handled"
            removeClippedSubviews
            initialNumToRender={10}
            maxToRenderPerBatch={8}
            windowSize={7}
            renderItem={({ item: t }) => {
              const isExpanded = previewTemplateId === t.id;
              return (
                <Pressable
                  onPress={() => {
                    templatePickerCallback?.(t.id);
                    setTemplatePickerVisible(false);
                    setPreviewTemplateId(null);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Usar template: ${t.name}`}
                  accessibilityHint={t.description ?? undefined}
                >
                  <YStack
                    bg={c.bgCard}
                    p="$3"
                    borderRadius="$3"
                    gap="$2"
                    borderWidth={1}
                    borderColor={c.border}
                  >
                    <XStack alignItems="center" gap="$2">
                      <BookOpen size={15} color={c.primary} />
                      <Text fontWeight="700" fontSize={14} color={c.text} f={1}>
                        {t.name}
                      </Text>
                      <Pressable
                        onPress={(e) => {
                          e.stopPropagation();
                          setPreviewTemplateId(isExpanded ? null : t.id);
                        }}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel={isExpanded ? 'Fechar preview do template' : `Ver preview do template ${t.name}`}
                      >
                        <Text fontSize={11} color={c.secondary} fontWeight="600">
                          {isExpanded ? '▲ fechar' : '▼ preview'}
                        </Text>
                      </Pressable>
                    </XStack>

                    {t.description ? (
                      <Text fontSize={12} color={c.textSecondary}>
                        {t.description}
                      </Text>
                    ) : null}

                    {isExpanded && (
                      <YStack
                        bg={c.bgSubtle}
                        p="$2"
                        borderRadius="$2"
                        mt="$1"
                        borderWidth={1}
                        borderColor={c.borderInput}
                      >
                        <Text fontSize={10} color={c.textSecondary} fontWeight="700" mb="$1">
                          PROMPT DO SISTEMA
                        </Text>
                        <Text fontSize={11} color={c.textLabel} lineHeight={16} numberOfLines={6}>
                          {t.systemPrompt.slice(0, 320)}
                          {t.systemPrompt.length > 320 ? '…' : ''}
                        </Text>
                      </YStack>
                    )}
                  </YStack>
                </Pressable>
              );
            }}
          />
        </View>
      </Modal>

      {/* Edit Transcript Modal */}
      <Modal
        visible={editingTranscriptFile !== null}
        animationType="slide"
        transparent={false}
        accessibilityViewIsModal
        onRequestClose={closeEditTranscriptModal}
      >
        <YStack f={1} bg={c.bgScreen} p="$4">
          <XStack alignItems="center" gap="$3" mt="$6" mb="$4">
            <Pressable
              onPress={closeEditTranscriptModal}
              accessibilityRole="button"
              accessibilityLabel="Fechar edição de transcrição"
            >
              <X size={28} color={c.accentRed} />
            </Pressable>
            <Text fontSize={20} fontWeight="800" f={1} color={c.text}>
              Editar Transcrição
            </Text>
          </XStack>

          <Text color={c.textSecondary} fontSize={12} mb="$2">
            Você pode editar o texto da transcrição aqui. Depois, reprocesse com IA.
          </Text>

          <TextInput
            value={editTranscriptValue}
            onChangeText={setEditTranscriptValue}
            placeholder="Digite a transcrição..."
            multiline
            accessibilityLabel="Texto da transcrição"
            accessibilityHint="Edite o conteúdo da transcrição"
            style={{
              flex: 1,
              borderWidth: 1,
              borderColor: c.borderInput,
              borderRadius: 8,
              padding: 12,
              fontSize: 14,
              textAlignVertical: 'top',
              backgroundColor: c.bgSubtle,
              color: c.text,
              marginBottom: 16,
            }}
          />

          {editTranscriptOriginal !== editTranscriptValue && (
            <Pressable
              onPress={() => setEditTranscriptValue(editTranscriptOriginal)}
              style={{ marginBottom: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Restaurar transcrição original"
            >
              <XStack
                bg={c.bgCard}
                p="$2"
                borderRadius="$3"
                alignItems="center"
                gap="$2"
              >
                <RefreshCw size={14} color={c.textSecondary} />
                <Text fontSize={12} color={c.textSecondary}>
                  Ver versão original
                </Text>
              </XStack>
            </Pressable>
          )}

          <XStack gap="$2">
            <Pressable
              onPress={() => {
                const item = recordings.find((r) => r.fileName === editingTranscriptFile);
                if (item) saveEditedTranscript(item);
              }}
              style={{ flex: 1 }}
              accessibilityRole="button"
              accessibilityLabel="Salvar transcrição editada"
            >
              <XStack
                bg={c.primary}
                p="$3"
                borderRadius="$3"
                alignItems="center"
                justifyContent="center"
                gap="$2"
              >
                <Check size={16} color={c.textOnAccent} />
                <Text color={c.textOnAccent} fontWeight="700" fontSize={13}>
                  Salvar
                </Text>
              </XStack>
            </Pressable>

            <Pressable
              onPress={() => {
                const item = recordings.find((r) => r.fileName === editingTranscriptFile);
                if (item) reprocessEditedTranscript(item);
              }}
              style={{ flex: 1 }}
              accessibilityRole="button"
              accessibilityLabel="Salvar e reprocessar com IA"
              accessibilityHint="Salva as edições e escolhe um template para gerar novo resumo"
            >
              <XStack
                bg={c.secondary}
                p="$3"
                borderRadius="$3"
                alignItems="center"
                justifyContent="center"
                gap="$2"
              >
                <Sparkles size={16} color={c.textOnAccent} />
                <Text color={c.textOnAccent} fontWeight="700" fontSize={13}>
                  Reprocessar
                </Text>
              </XStack>
            </Pressable>
          </XStack>
        </YStack>
      </Modal>

      {/* View Transcript Modal — tela cheia somente leitura */}
      <Modal
        visible={viewingTranscriptFile !== null}
        animationType="slide"
        transparent={false}
        accessibilityViewIsModal
        onRequestClose={() => setViewingTranscriptFile(null)}
      >
        {(() => {
          const item = recordings.find((r) => r.fileName === viewingTranscriptFile);
          if (!item) return null;
          const displayName = item.customName ?? formatDefaultName(item.createdAt);
          const fullCopyKey = `view_transcript_${item.fileName}`;
          return (
            <YStack f={1} bg={c.bgScreen} p="$4">
              <XStack alignItems="center" gap="$3" mt="$6" mb="$3">
                <Pressable
                  onPress={() => setViewingTranscriptFile(null)}
                  accessibilityRole="button"
                  accessibilityLabel="Voltar para a lista de gravações"
                >
                  <ArrowLeft size={28} color={c.primary} />
                </Pressable>
                <YStack f={1}>
                  <Text fontSize={18} fontWeight="800" color={c.text} numberOfLines={1}>
                    Transcrição
                  </Text>
                  <Text fontSize={12} color={c.textMuted} numberOfLines={1}>
                    {displayName}
                  </Text>
                </YStack>
                {copiedKey === fullCopyKey ? (
                  <Text fontSize={12} color={c.primary} fontWeight="700">
                    Copiado!
                  </Text>
                ) : (
                  <Pressable
                    onPress={() => copyToClipboard(item.transcript ?? '', fullCopyKey)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="Copiar transcrição completa"
                  >
                    <Copy size={22} color={c.primary} />
                  </Pressable>
                )}
                <Pressable
                  onPress={() => shareText(item.transcript ?? '', `Transcrição - ${displayName}`)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Compartilhar transcrição completa"
                >
                  <Share2 size={22} color={c.primary} />
                </Pressable>
                <Pressable
                  onPress={() => {
                    setViewingTranscriptFile(null);
                    setTimeout(() => openEditTranscriptModal(item), 300);
                  }}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Editar transcrição"
                >
                  <Pencil size={22} color={c.primary} />
                </Pressable>
              </XStack>

              <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ paddingBottom: 40 }}
                showsVerticalScrollIndicator
              >
                <Text fontSize={15} color={c.text} lineHeight={23} selectable>
                  {item.transcript}
                </Text>
              </ScrollView>
            </YStack>
          );
        })()}
      </Modal>
    </YStack>
  );
}
