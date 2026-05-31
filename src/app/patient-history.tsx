/**
 * Patient History Screen
 *
 * Shows a full chronological timeline of all recordings linked to a patient:
 *   • Stats header: total consultations, date range, templates used
 *   • Timeline entries: date, recording name, template badge, collapsible
 *     transcript / summary, per-entry copy + share actions
 *   • "Exportar histórico" — shares all summaries as a single text document
 */
import { useCallback, useState, useMemo } from 'react';
import {
  FlatList,
  Pressable,
  Alert,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { YStack, XStack, Text } from 'tamagui';
import {
  ArrowLeft,
  User,
  FileText,
  BookOpen,
  Copy,
  Share2,
  ChevronDown,
  ChevronUp,
  CalendarDays,
  Layers,
  Share,
} from 'lucide-react-native';
import { Link, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import { getAllRecordingsMeta } from '../services/db';
import { getAllTemplates, PromptTemplate } from '../services/openai';
import { formatDefaultName } from '../services/recordings';
import { openShareMenu } from '../services/share';
import { useColors } from '../context/ThemeContext';
import { BottomTabBar } from '../components/BottomTabBar';

// ─── Types ───────────────────────────────────────────────────────────────────

interface PatientRecording {
  fileName: string;
  uri: string;
  createdAt: string;
  customName: string | null;
  transcript: string | null;
  summary: string | null;
  templateId: string | null;
  localFileExists: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** 2-letter initials from a patient name */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/** Deterministic color from patient name */
function avatarColor(name: string): string {
  // Paleta quente — tons que contrastam com texto branco do avatar
  const colors = ['#000000', '#2e2b26', '#57534a', '#c2410c', '#ff3f00', '#8c8676'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function formatDateLong(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ─── Screen ──────────────────────────────────────────────────────────────────

export default function PatientHistoryScreen() {
  const c = useColors();
  const params = useLocalSearchParams();
  const patientName =
    typeof params.name === 'string' ? decodeURIComponent(params.name) : '';

  const [recordings, setRecordings] = useState<PatientRecording[]>([]);
  const [allTemplates, setAllTemplates] = useState<PromptTemplate[]>([]);
  const [expandedTranscripts, setExpandedTranscripts] = useState<Set<string>>(
    new Set()
  );
  const [expandedSummaries, setExpandedSummaries] = useState<Set<string>>(
    new Set()
  );
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const load = async () => {
    const [dir, metaMap, templates] = await Promise.all([
      Promise.resolve(FileSystem.documentDirectory ?? ''),
      getAllRecordingsMeta(),
      getAllTemplates(),
    ]);

    setAllTemplates(templates);

    const items: PatientRecording[] = [];
    const existingFiles = new Set(
      dir ? await FileSystem.readDirectoryAsync(dir).catch(() => []) : []
    );

    for (const [fileName, meta] of metaMap.entries()) {
      if (!meta.patientName) continue;
      if (meta.patientName.trim().toLowerCase() !== patientName.trim().toLowerCase())
        continue;

      const match = fileName.match(/recording_(\d+)\.m4a/);
      const createdAt = match
        ? new Date(parseInt(match[1])).toISOString()
        : meta.updatedAt ?? new Date().toISOString();

      items.push({
        fileName,
        uri: `${dir}${fileName}`,
        createdAt,
        customName: meta.customName ?? null,
        transcript: meta.transcript ?? null,
        summary: meta.summary ?? null,
        templateId: meta.templateId ?? null,
        localFileExists: existingFiles.has(fileName),
      });
    }

    items.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    setRecordings(items);
  };

  useFocusEffect(useCallback(() => { load(); }, []));

  // ── Derived stats ──────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    if (recordings.length === 0) return null;
    const dates = recordings.map((r) => new Date(r.createdAt).getTime());
    const oldest = new Date(Math.min(...dates));
    const newest = new Date(Math.max(...dates));

    const templateCount: Record<string, number> = {};
    for (const r of recordings) {
      if (r.templateId) {
        templateCount[r.templateId] = (templateCount[r.templateId] ?? 0) + 1;
      }
    }
    const topTemplates = Object.entries(templateCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id, count]) => ({
        id,
        name: allTemplates.find((t) => t.id === id)?.name ?? id,
        count,
      }));

    const withSummary = recordings.filter((r) => r.summary).length;
    const withTranscript = recordings.filter((r) => r.transcript).length;

    return { oldest, newest, topTemplates, withSummary, withTranscript };
  }, [recordings, allTemplates]);

  // ── Toggle helpers ─────────────────────────────────────────────────────────

  const toggleTranscript = (fileName: string) => {
    setExpandedTranscripts((prev) => {
      const next = new Set(prev);
      next.has(fileName) ? next.delete(fileName) : next.add(fileName);
      return next;
    });
  };

  const toggleSummary = (fileName: string) => {
    setExpandedSummaries((prev) => {
      const next = new Set(prev);
      next.has(fileName) ? next.delete(fileName) : next.add(fileName);
      return next;
    });
  };

  // ── Copy / Share ───────────────────────────────────────────────────────────

  const copyText = async (text: string, key: string) => {
    await Clipboard.setStringAsync(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  const getTemplateName = (id: string | null) => {
    if (!id) return null;
    return allTemplates.find((t) => t.id === id)?.name ?? null;
  };

  const exportAll = () => {
    const hasSummaries = recordings.some((r) => r.summary);
    if (!hasSummaries) {
      Alert.alert('Sem resumos', 'Nenhuma consulta deste paciente foi processada com IA ainda.');
      return;
    }
    const lines: string[] = [
      `HISTÓRICO — ${patientName}`,
      `Exportado em ${new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })}`,
      '─'.repeat(40),
      '',
    ];
    for (const r of recordings) {
      if (!r.summary) continue;
      const name = r.customName ?? formatDefaultName(r.createdAt);
      const tpl = getTemplateName(r.templateId);
      lines.push(`📅 ${formatDateLong(r.createdAt)}`);
      lines.push(`${name}${tpl ? `  [${tpl}]` : ''}`);
      lines.push('');
      lines.push(r.summary);
      lines.push('');
      lines.push('─'.repeat(40));
      lines.push('');
    }
    openShareMenu(lines.join('\n'), `Histórico — ${patientName}`);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const color = avatarColor(patientName);

  return (
    <View style={{ flex: 1, backgroundColor: c.bgScreen }}>
    <YStack f={1} bg={c.bgScreen}>
      {/* ── Header ── */}
      <YStack
        bg={c.bgCard}
        px="$4"
        pt="$8"
        pb="$4"
        gap="$3"
        borderBottomWidth={1}
        borderBottomColor={c.border}
      >
        <XStack alignItems="center" gap="$3">
          <Link href="/patients" asChild>
            <Pressable
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Voltar para lista de pacientes"
            >
              <ArrowLeft size={26} color={c.primary} />
            </Pressable>
          </Link>
          <Text fontSize={20} fontWeight="800" color={c.primary} f={1} numberOfLines={1}>
            Histórico do Paciente
          </Text>
        </XStack>

        {/* Avatar + name */}
        <XStack alignItems="center" gap="$4" mt="$1">
          <View style={[styles.avatar, { backgroundColor: color }]}>
            <Text style={styles.avatarText}>{initials(patientName)}</Text>
          </View>
          <YStack f={1}>
            <Text fontSize={22} fontWeight="800" color={c.text} numberOfLines={2}>
              {patientName}
            </Text>
            {stats && (
              <Text fontSize={12} color={c.textSecondary} mt="$1">
                {recordings.length} {recordings.length === 1 ? 'consulta' : 'consultas'} •{' '}
                {formatDateLong(stats.oldest.toISOString())} → {formatDateLong(stats.newest.toISOString())}
              </Text>
            )}
          </YStack>
        </XStack>

        {/* Stats chips */}
        {stats && (
          <XStack gap="$2" flexWrap="wrap" mt="$1">
            <XStack
              bg={c.bgBlueSoft}
              borderRadius={999}
              px="$3"
              py="$1"
              alignItems="center"
              gap="$1"
            >
              <CalendarDays size={12} color={c.accentBlue} />
              <Text fontSize={12} color={c.accentNavy} fontWeight="600">
                {recordings.length} consulta(s)
              </Text>
            </XStack>
            <XStack
              bg={c.bgGreenSoft}
              borderRadius={999}
              px="$3"
              py="$1"
              alignItems="center"
              gap="$1"
            >
              <FileText size={12} color="#16a34a" />
              <Text fontSize={12} color="#16a34a" fontWeight="600">
                {stats.withSummary} processada(s) com IA
              </Text>
            </XStack>
            {stats.topTemplates.map((t) => (
              <XStack
                key={t.id}
                bg={c.bgPurpleSoft}
                borderRadius={999}
                px="$3"
                py="$1"
                alignItems="center"
                gap="$1"
              >
                <Layers size={12} color={c.secondary} />
                <Text fontSize={12} color={c.secondary} fontWeight="600">
                  {t.name} ×{t.count}
                </Text>
              </XStack>
            ))}
          </XStack>
        )}

        {/* Export all */}
        {recordings.some((r) => r.summary) && (
          <Pressable
            onPress={exportAll}
            accessibilityRole="button"
            accessibilityLabel="Exportar histórico completo do paciente"
            accessibilityHint="Compartilha todas as evoluções deste paciente como texto"
          >
            <XStack
              bg={c.primary}
              px="$4"
              py="$2"
              borderRadius="$3"
              alignItems="center"
              justifyContent="center"
              gap="$2"
              mt="$1"
            >
              <Share size={16} color="#fff" />
              <Text fontWeight="700" fontSize={13} color="#fff">
                Exportar histórico completo
              </Text>
            </XStack>
          </Pressable>
        )}
      </YStack>

      {/* ── Timeline ── */}
      {recordings.length === 0 ? (
        <YStack f={1} alignItems="center" justifyContent="center" gap="$2" p="$6">
          <User size={48} color={c.textPlaceholder} />
          <Text color={c.textLabel} fontSize={16} fontWeight="700" mt="$2">
            Nenhuma gravação encontrada
          </Text>
          <Text color={c.textPlaceholder} fontSize={13} textAlign="center">
            As gravações aparecem aqui quando vinculadas a este paciente via templates
            médicos (Consulta, SOAP, Receituário, etc).
          </Text>
        </YStack>
      ) : (
        <FlatList
          data={recordings}
          keyExtractor={(r) => r.fileName}
          contentContainerStyle={{ padding: 16, gap: 0, paddingBottom: 70 }}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews
          initialNumToRender={6}
          maxToRenderPerBatch={4}
          windowSize={7}
          updateCellsBatchingPeriod={60}
          renderItem={({ item, index }) => {
            const isLast = index === recordings.length - 1;
            const displayName = item.customName ?? formatDefaultName(item.createdAt);
            const templateName = getTemplateName(item.templateId);
            const txExpanded = expandedTranscripts.has(item.fileName);
            const smExpanded = expandedSummaries.has(item.fileName);
            const copyTxKey = `tx_${item.fileName}`;
            const copySmKey = `sm_${item.fileName}`;

            return (
              <XStack gap="$3">
                {/* Timeline spine */}
                <YStack alignItems="center" width={24}>
                  <View style={[styles.timelineDot, { backgroundColor: c.primary }]} />
                  {!isLast && (
                    <View style={[styles.timelineLine, { backgroundColor: c.border }]} />
                  )}
                </YStack>

                {/* Card */}
                <YStack f={1} pb="$4">
                  {/* Date */}
                  <Text fontSize={11} color={c.textMuted} fontWeight="700" mb="$2">
                    {formatDateTime(item.createdAt)}
                  </Text>

                  <YStack
                    bg={c.bgCard}
                    borderRadius="$3"
                    borderWidth={1}
                    borderColor={c.border}
                    overflow="hidden"
                  >
                    {/* Recording name + template badge */}
                    <XStack
                      px="$3"
                      py="$3"
                      alignItems="center"
                      gap="$2"
                      borderBottomWidth={
                        item.transcript || item.summary ? 1 : 0
                      }
                      borderBottomColor={c.border}
                    >
                      <YStack f={1} gap="$1">
                        <Text fontWeight="700" fontSize={14} color={c.text} numberOfLines={2}>
                          {displayName}
                        </Text>
                        {!item.localFileExists && (
                          <Text fontSize={11} color={c.textPlaceholder}>
                            Áudio não está neste dispositivo
                          </Text>
                        )}
                      </YStack>
                      {templateName && (
                        <XStack
                          bg={c.bgPurpleSoft}
                          borderRadius={999}
                          px="$2"
                          py="$1"
                        >
                          <Text fontSize={10} color={c.secondary} fontWeight="700">
                            {templateName.toUpperCase()}
                          </Text>
                        </XStack>
                      )}
                    </XStack>

                    {/* Summary */}
                    {item.summary && (
                      <YStack
                        borderBottomWidth={item.transcript ? 1 : 0}
                        borderBottomColor={c.border}
                      >
                        <Pressable
                          onPress={() => toggleSummary(item.fileName)}
                          accessibilityRole="button"
                          accessibilityLabel={`${smExpanded ? 'Recolher' : 'Expandir'} resumo de ${displayName}`}
                          accessibilityState={{ expanded: smExpanded }}
                        >
                          <XStack
                            px="$3"
                            py="$2"
                            alignItems="center"
                            gap="$2"
                            bg={c.bgPurpleSoft}
                          >
                            <BookOpen size={14} color={c.secondary} />
                            <Text
                              fontWeight="700"
                              fontSize={12}
                              color={c.secondary}
                              f={1}
                            >
                              RESUMO / IA
                            </Text>
                            <XStack gap="$2" alignItems="center">
                              {copiedKey === copySmKey ? (
                                <Text fontSize={11} color={c.primary} fontWeight="700">
                                  Copiado!
                                </Text>
                              ) : (
                                <Pressable
                                  onPress={() => copyText(item.summary!, copySmKey)}
                                  hitSlop={8}
                                  accessibilityRole="button"
                                  accessibilityLabel={`Copiar resumo de ${displayName}`}
                                >
                                  <Copy size={14} color={c.secondary} />
                                </Pressable>
                              )}
                              <Pressable
                                onPress={() =>
                                  openShareMenu(
                                    item.summary!,
                                    `${templateName ?? 'Resumo'} — ${displayName}`
                                  )
                                }
                                hitSlop={8}
                                accessibilityRole="button"
                                accessibilityLabel={`Compartilhar resumo de ${displayName}`}
                              >
                                <Share2 size={14} color={c.secondary} />
                              </Pressable>
                              {smExpanded ? (
                                <ChevronUp size={14} color={c.secondary} />
                              ) : (
                                <ChevronDown size={14} color={c.secondary} />
                              )}
                            </XStack>
                          </XStack>
                        </Pressable>
                        {smExpanded && (
                          <Text
                            fontSize={13}
                            color={c.accentGreenDark}
                            lineHeight={20}
                            px="$3"
                            py="$3"
                          >
                            {item.summary}
                          </Text>
                        )}
                      </YStack>
                    )}

                    {/* Transcript */}
                    {item.transcript && (
                      <YStack>
                        <Pressable
                          onPress={() => toggleTranscript(item.fileName)}
                          accessibilityRole="button"
                          accessibilityLabel={`${txExpanded ? 'Recolher' : 'Expandir'} transcrição de ${displayName}`}
                          accessibilityState={{ expanded: txExpanded }}
                        >
                          <XStack
                            px="$3"
                            py="$2"
                            alignItems="center"
                            gap="$2"
                            bg={c.bgSubtle}
                          >
                            <FileText size={14} color={c.primary} />
                            <Text
                              fontWeight="700"
                              fontSize={12}
                              color={c.primary}
                              f={1}
                            >
                              TRANSCRIÇÃO
                            </Text>
                            <XStack gap="$2" alignItems="center">
                              {copiedKey === copyTxKey ? (
                                <Text fontSize={11} color={c.primary} fontWeight="700">
                                  Copiado!
                                </Text>
                              ) : (
                                <Pressable
                                  onPress={() => copyText(item.transcript!, copyTxKey)}
                                  hitSlop={8}
                                  accessibilityRole="button"
                                  accessibilityLabel={`Copiar transcrição de ${displayName}`}
                                >
                                  <Copy size={14} color={c.primary} />
                                </Pressable>
                              )}
                              {txExpanded ? (
                                <ChevronUp size={14} color={c.primary} />
                              ) : (
                                <ChevronDown size={14} color={c.primary} />
                              )}
                            </XStack>
                          </XStack>
                        </Pressable>
                        {txExpanded && (
                          <Text
                            fontSize={13}
                            color={c.text}
                            lineHeight={20}
                            px="$3"
                            py="$3"
                          >
                            {item.transcript}
                          </Text>
                        )}
                      </YStack>
                    )}

                    {/* Empty state — no transcript yet */}
                    {!item.transcript && !item.summary && (
                      <XStack px="$3" py="$3" alignItems="center" gap="$2">
                        <Text fontSize={12} color={c.textPlaceholder}>
                          Gravação não transcrita ainda
                        </Text>
                      </XStack>
                    )}
                  </YStack>
                </YStack>
              </XStack>
            );
          }}
        />
      )}
    </YStack>
    <BottomTabBar />
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  avatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  avatarText: {
    fontSize: 22,
    fontWeight: '800',
    color: '#fff',
  },
  timelineDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginTop: 2,
    flexShrink: 0,
  },
  timelineLine: {
    width: 2,
    flex: 1,
    marginTop: 4,
  },
});
