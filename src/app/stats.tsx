import { useState, useCallback } from 'react';
import { ScrollView, Pressable } from 'react-native';
import { YStack, XStack, Text } from 'tamagui';
import {
  ArrowLeft,
  Mic,
  Users,
  FileText,
  Sparkles,
  BarChart3,
  Calendar,
  DollarSign,
  Cpu,
} from 'lucide-react-native';
import { Link, useFocusEffect } from 'expo-router';
import { getAllRecordingsMeta, getCustomTemplates } from '../services/db';
import { BUILTIN_TEMPLATES } from '../services/openai';
import {
  getApiUsageStats,
  formatUSD,
  formatBRL,
  ApiUsageStats,
} from '../services/api_usage';
import { useColors } from '../context/ThemeContext';
import { logWarn } from '../services/log';

interface Stats {
  totalRecordings: number;
  uniquePatients: number;
  withTranscript: number;
  withSummary: number;
  perDay: { day: string; count: number }[];
  perTemplate: { name: string; count: number }[];
  topPatients: { name: string; count: number }[];
  apiUsage: ApiUsageStats | null;
}

const DAYS_OF_WEEK = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

function StatCard({
  icon,
  label,
  value,
  color,
  bg,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  color: string;
  bg: string;
}) {
  const c = useColors();
  return (
    <YStack f={1} bg={bg} p="$3" borderRadius="$4" gap="$2">
      {icon}
      <Text fontSize={28} fontWeight="900" color={color}>
        {value}
      </Text>
      <Text fontSize={11} color={c.textSecondary} fontWeight="700">
        {label.toUpperCase()}
      </Text>
    </YStack>
  );
}

export default function StatsScreen() {
  const c = useColors();
  const [stats, setStats] = useState<Stats | null>(null);

  const loadStats = async () => {
    try {
    const meta = await getAllRecordingsMeta();
    const customTemplates = await getCustomTemplates();

    const tplMap = new Map<string, string>();
    BUILTIN_TEMPLATES.forEach((t) => tplMap.set(t.id, t.name));
    customTemplates.forEach((t) => tplMap.set(t.id, t.name));

    const recordings: {
      fileName: string;
      date: Date;
      meta: any;
    }[] = [];
    for (const [fileName, m] of meta.entries()) {
      const match = fileName.match(/recording_(\d+)\.m4a/);
      if (match) {
        recordings.push({
          fileName,
          date: new Date(parseInt(match[1])),
          meta: m,
        });
      }
    }

    const total = recordings.length;
    const uniquePatients = new Set(
      recordings.map((r) => r.meta.patientName).filter(Boolean)
    ).size;
    const withTranscript = recordings.filter((r) => r.meta.transcript).length;
    const withSummary = recordings.filter((r) => r.meta.summary).length;

    // Atividade últimos 7 dias
    const perDay: { day: string; count: number }[] = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const dayEnd = new Date(d);
      dayEnd.setDate(dayEnd.getDate() + 1);
      const count = recordings.filter(
        (r) => r.date >= d && r.date < dayEnd
      ).length;
      const label = i === 0 ? 'Hoje' : DAYS_OF_WEEK[d.getDay()];
      perDay.push({ day: label, count });
    }

    // Templates mais usados
    const tplCounts = new Map<string, number>();
    recordings.forEach((r) => {
      if (r.meta.templateId) {
        const name = tplMap.get(r.meta.templateId) ?? 'Outro';
        tplCounts.set(name, (tplCounts.get(name) ?? 0) + 1);
      }
    });
    const perTemplate = [...tplCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Top pacientes
    const ptCounts = new Map<string, number>();
    recordings.forEach((r) => {
      if (r.meta.patientName) {
        ptCounts.set(
          r.meta.patientName,
          (ptCounts.get(r.meta.patientName) ?? 0) + 1
        );
      }
    });
    const topPatients = [...ptCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Custos da API OpenAI
    let apiUsage: ApiUsageStats | null = null;
    try {
      apiUsage = await getApiUsageStats();
    } catch (e) {
      logWarn('stats', e);
    }

    setStats({
      totalRecordings: total,
      uniquePatients,
      withTranscript,
      withSummary,
      perDay,
      perTemplate,
      topPatients,
      apiUsage,
    });
    } catch (err) {
      logWarn('stats', err);
      // Fallback seguro — evita tela travada em "Carregando..." e propagação de erro
      setStats({
        totalRecordings: 0,
        uniquePatients: 0,
        withTranscript: 0,
        withSummary: 0,
        perDay: Array.from({ length: 7 }, () => ({ day: '', count: 0 })),
        perTemplate: [],
        topPatients: [],
        apiUsage: null,
      });
    }
  };

  useFocusEffect(
    useCallback(() => {
      loadStats();
    }, [])
  );

  if (!stats) {
    return (
      <YStack f={1} bg={c.bgScreen} p="$4" gap="$3">
        <XStack alignItems="center" gap="$3" mt="$6">
          <Link href="/" asChild>
            <Pressable accessibilityRole="button" accessibilityLabel="Voltar para gravação">
              <ArrowLeft size={28} color={c.primary} />
            </Pressable>
          </Link>
          <Text fontSize={24} fontWeight="800" color={c.primary}>
            Estatísticas
          </Text>
        </XStack>
        <Text color={c.textSecondary} mt="$4">
          Carregando...
        </Text>
      </YStack>
    );
  }

  const maxDay = Math.max(1, ...stats.perDay.map((d) => d.count));

  return (
    <YStack f={1} bg={c.bgScreen}>
      <YStack p="$4" gap="$3">
        <XStack alignItems="center" gap="$3" mt="$6">
          <Link href="/" asChild>
            <Pressable accessibilityRole="button" accessibilityLabel="Voltar para gravação">
              <ArrowLeft size={28} color={c.primary} />
            </Pressable>
          </Link>
          <Text fontSize={24} fontWeight="800" color={c.primary}>
            Estatísticas
          </Text>
        </XStack>
      </YStack>

      <ScrollView
        style={{ backgroundColor: c.bgScreen }}
        contentContainerStyle={{ padding: 16, paddingBottom: 60, gap: 20 }}
      >
        {/* Cards 2x2 */}
        <XStack gap="$3">
          <StatCard
            icon={<Mic size={20} color={c.primary} />}
            label="Gravações"
            value={stats.totalRecordings}
            color={c.primary}
            bg={c.bgGreenSofter}
          />
          <StatCard
            icon={<Users size={20} color={c.accentBlue} />}
            label="Pacientes"
            value={stats.uniquePatients}
            color={c.accentBlue}
            bg={c.bgBlueSoft}
          />
        </XStack>
        <XStack gap="$3">
          <StatCard
            icon={<FileText size={20} color={c.secondary} />}
            label="Transcrições"
            value={stats.withTranscript}
            color={c.secondary}
            bg={c.bgPurpleSoft}
          />
          <StatCard
            icon={<Sparkles size={20} color={c.accentOrange} />}
            label="Resumos IA"
            value={stats.withSummary}
            color={c.accentOrange}
            bg={c.bgYellowSoft}
          />
        </XStack>

        {/* Atividade últimos 7 dias */}
        <YStack gap="$2" mt="$2">
          <XStack alignItems="center" gap="$2">
            <Calendar size={18} color={c.textLabel} />
            <Text fontWeight="800" fontSize={13} color={c.textLabel}>
              ATIVIDADE — ÚLTIMOS 7 DIAS
            </Text>
          </XStack>
          <YStack gap="$2" mt="$1">
            {stats.perDay.map((d, i) => (
              <XStack key={i} alignItems="center" gap="$3">
                <Text fontSize={11} color={c.textSecondary} w={44}>
                  {d.day}
                </Text>
                <XStack
                  f={1}
                  h={22}
                  bg={c.bgCard}
                  borderRadius="$2"
                  overflow="hidden"
                  accessibilityRole="progressbar"
                  accessibilityLabel={`${d.day}: ${d.count} gravação(ões)`}
                  accessibilityValue={{ min: 0, max: maxDay, now: d.count }}
                >
                  <XStack
                    h={22}
                    bg={d.count > 0 ? c.primary : 'transparent'}
                    w={`${(d.count / maxDay) * 100}%`}
                  />
                </XStack>
                <Text
                  fontSize={12}
                  fontWeight="700"
                  color={c.text}
                  w={28}
                  textAlign="right"
                  accessibilityElementsHidden
                  importantForAccessibility="no"
                >
                  {d.count}
                </Text>
              </XStack>
            ))}
          </YStack>
        </YStack>

        {/* Templates mais usados */}
        {stats.perTemplate.length > 0 && (
          <YStack gap="$2" mt="$2">
            <XStack alignItems="center" gap="$2">
              <Sparkles size={18} color={c.secondary} />
              <Text fontWeight="800" fontSize={13} color={c.textLabel}>
                TEMPLATES MAIS USADOS
              </Text>
            </XStack>
            <YStack gap="$2">
              {stats.perTemplate.map((t, i) => (
                <XStack
                  key={i}
                  bg={c.bgSubtle}
                  p="$3"
                  borderRadius="$3"
                  alignItems="center"
                  gap="$3"
                  borderWidth={1}
                  borderColor={c.border}
                >
                  <Text
                    fontSize={13}
                    fontWeight="700"
                    color={c.textSecondary}
                    w={22}
                  >
                    {i + 1}
                  </Text>
                  <Text f={1} fontSize={13} color={c.text}>
                    {t.name}
                  </Text>
                  <Text fontWeight="800" color={c.secondary} fontSize={16}>
                    {t.count}
                  </Text>
                </XStack>
              ))}
            </YStack>
          </YStack>
        )}

        {/* Top pacientes */}
        {stats.topPatients.length > 0 && (
          <YStack gap="$2" mt="$2">
            <XStack alignItems="center" gap="$2">
              <Users size={18} color={c.accentBlue} />
              <Text fontWeight="800" fontSize={13} color={c.textLabel}>
                TOP PACIENTES
              </Text>
            </XStack>
            <YStack gap="$2">
              {stats.topPatients.map((p, i) => (
                <XStack
                  key={i}
                  bg={c.bgSubtle}
                  p="$3"
                  borderRadius="$3"
                  alignItems="center"
                  gap="$3"
                  borderWidth={1}
                  borderColor={c.border}
                >
                  <Text
                    fontSize={13}
                    fontWeight="700"
                    color={c.textSecondary}
                    w={22}
                  >
                    {i + 1}
                  </Text>
                  <Text f={1} fontSize={13} color={c.text}>
                    {p.name}
                  </Text>
                  <Text fontWeight="800" color={c.accentBlue} fontSize={16}>
                    {p.count}
                  </Text>
                </XStack>
              ))}
            </YStack>
          </YStack>
        )}

        {/* Custos da API OpenAI */}
        {stats.apiUsage && stats.apiUsage.totalCalls > 0 && (
          <YStack gap="$2" mt="$4">
            <XStack alignItems="center" gap="$2">
              <DollarSign size={18} color={c.primary} />
              <Text fontWeight="800" fontSize={13} color={c.textLabel}>
                CUSTOS DA API OPENAI
              </Text>
            </XStack>

            {/* Card de total */}
            <YStack
              bg={c.bgGreenSofter}
              borderWidth={1}
              borderColor={c.borderGreen}
              p="$4"
              borderRadius="$4"
              gap="$2"
            >
              <Text fontSize={11} color={c.primaryDeep} fontWeight="700">
                TOTAL GASTO
              </Text>
              <XStack alignItems="baseline" gap="$2">
                <Text fontSize={32} fontWeight="900" color={c.primaryDeep}>
                  {formatUSD(stats.apiUsage.totalUSD)}
                </Text>
                <Text fontSize={14} color={c.primary} fontWeight="700">
                  ≈ {formatBRL(stats.apiUsage.totalUSD)}
                </Text>
              </XStack>
              <Text fontSize={12} color={c.primaryDeep}>
                {stats.apiUsage.totalCalls} chamada
                {stats.apiUsage.totalCalls !== 1 ? 's' : ''} de API
              </Text>
            </YStack>

            {/* Breakdown por operação */}
            {stats.apiUsage.byOperation.length > 0 && (
              <YStack gap="$2" mt="$2">
                <Text fontSize={11} color={c.textSecondary} fontWeight="700">
                  POR OPERAÇÃO
                </Text>
                {stats.apiUsage.byOperation.map((op, i) => {
                  const label =
                    op.operation === 'whisper'
                      ? 'Whisper (transcrição)'
                      : 'Chat (resumos/templates)';
                  const color =
                    op.operation === 'whisper' ? c.secondary : c.accentOrange;
                  return (
                    <XStack
                      key={i}
                      bg={c.bgSubtle}
                      p="$3"
                      borderRadius="$3"
                      alignItems="center"
                      gap="$3"
                      borderWidth={1}
                      borderColor={c.border}
                    >
                      <Cpu size={16} color={color} />
                      <YStack f={1}>
                        <Text fontSize={13} fontWeight="700" color={c.text}>
                          {label}
                        </Text>
                        <Text fontSize={11} color={c.textSecondary}>
                          {op.calls} chamada{op.calls !== 1 ? 's' : ''}
                        </Text>
                      </YStack>
                      <Text fontWeight="800" color={color} fontSize={14}>
                        {formatUSD(op.costUSD)}
                      </Text>
                    </XStack>
                  );
                })}
              </YStack>
            )}

            {/* Breakdown por modelo */}
            {stats.apiUsage.byModel.length > 0 && (
              <YStack gap="$2" mt="$2">
                <Text fontSize={11} color={c.textSecondary} fontWeight="700">
                  POR MODELO
                </Text>
                {stats.apiUsage.byModel.map((m, i) => (
                  <XStack
                    key={i}
                    bg={c.bgSubtle}
                    p="$3"
                    borderRadius="$3"
                    alignItems="center"
                    gap="$3"
                    borderWidth={1}
                    borderColor={c.border}
                  >
                    <YStack f={1}>
                      <Text fontSize={13} fontWeight="700" color={c.text}>
                        {m.model}
                      </Text>
                      <Text fontSize={11} color={c.textSecondary}>
                        {m.calls} chamada{m.calls !== 1 ? 's' : ''}
                      </Text>
                    </YStack>
                    <Text fontWeight="800" color={c.textLabel} fontSize={14}>
                      {formatUSD(m.costUSD)}
                    </Text>
                  </XStack>
                ))}
              </YStack>
            )}

            {/* Métricas adicionais */}
            <XStack gap="$3" mt="$2">
              <YStack
                f={1}
                bg={c.bgPurpleSoft}
                p="$3"
                borderRadius="$3"
                gap="$1"
              >
                <Text fontSize={10} color={c.secondary} fontWeight="700">
                  ÁUDIO TRANSCRITO
                </Text>
                <Text fontSize={20} fontWeight="900" color={c.secondary}>
                  {stats.apiUsage.whisperTotalMinutes.toFixed(1)} min
                </Text>
              </YStack>
              <YStack
                f={1}
                bg={c.bgYellowSoft}
                p="$3"
                borderRadius="$3"
                gap="$1"
              >
                <Text fontSize={10} color={c.accentYellow} fontWeight="700">
                  TOKENS DE TEXTO
                </Text>
                <Text fontSize={20} fontWeight="900" color={c.accentYellow}>
                  {stats.apiUsage.chatTotalTokens.toLocaleString('pt-BR')}
                </Text>
              </YStack>
            </XStack>

            <Text fontSize={10} color={c.textPlaceholder} mt="$2" textAlign="center">
              Cotação aprox. R$5,50/USD. Preços oficiais: Whisper $0.006/min •
              GPT-4o mini $0.15/1M in + $0.60/1M out • GPT-4o $2.50/1M in +
              $10.00/1M out
            </Text>
          </YStack>
        )}

        {stats.totalRecordings === 0 && (
          <YStack alignItems="center" gap="$2" mt="$4" p="$4">
            <BarChart3 size={48} color={c.textPlaceholder} />
            <Text color={c.textLabel} fontSize={15} fontWeight="700">
              Nenhuma gravação ainda
            </Text>
            <Text color={c.textPlaceholder} fontSize={13} textAlign="center">
              Suas estatísticas aparecem aqui após você criar gravações.
            </Text>
          </YStack>
        )}
      </ScrollView>
    </YStack>
  );
}
