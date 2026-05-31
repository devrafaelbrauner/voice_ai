import { useState, useCallback, useEffect, useRef } from 'react';
import { ScrollView, Pressable, Animated, View } from 'react-native';
import { YStack, XStack, Text } from 'tamagui';
import {
  Mic,
  Users,
  FileText,
  Sparkles,
  BarChart3,
  Calendar,
  DollarSign,
  Cpu,
} from 'lucide-react-native';
import { useFocusEffect } from 'expo-router';
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
import { BottomTabBar } from '../components/BottomTabBar';

type Period = 'week' | 'month' | 'year' | 'all';

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
const MONTH_ABBR = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const BRL_RATE = 5.5;

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

function AnimatedBar({
  count,
  maxCount,
  primaryColor,
  bgCard,
  textColor,
}: {
  count: number;
  maxCount: number;
  primaryColor: string;
  bgCard: string;
  textColor: string;
}) {
  const animValue = useRef(new Animated.Value(0)).current;
  const targetWidth = maxCount > 0 ? (count / maxCount) * 100 : 0;

  useEffect(() => {
    Animated.timing(animValue, {
      toValue: targetWidth,
      duration: 400,
      useNativeDriver: false,
    }).start();
  }, [targetWidth]);

  const widthInterpolated = animValue.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
  });

  return (
    <View
      style={{
        flex: 1,
        height: 32,
        backgroundColor: bgCard,
        borderRadius: 6,
        overflow: 'hidden',
        justifyContent: 'center',
      }}
    >
      <Animated.View
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: widthInterpolated,
          backgroundColor: count > 0 ? primaryColor : 'transparent',
          borderRadius: 6,
          justifyContent: 'center',
          alignItems: 'flex-end',
          paddingRight: 6,
        }}
      >
        {count > 0 && (
          <Text style={{ fontSize: 11, fontWeight: '700', color: '#fff' }}>
            {count}
          </Text>
        )}
      </Animated.View>
      {count === 0 && (
        <Text style={{ fontSize: 11, fontWeight: '700', color: textColor, paddingLeft: 6 }}>
          0
        </Text>
      )}
    </View>
  );
}

function computePerDay(
  recordings: { date: Date }[],
  period: Period
): { day: string; count: number }[] {
  const now = new Date();

  if (period === 'week') {
    const result: { day: string; count: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const dayEnd = new Date(d);
      dayEnd.setDate(dayEnd.getDate() + 1);
      const count = recordings.filter((r) => r.date >= d && r.date < dayEnd).length;
      const label = i === 0 ? 'Hoje' : DAYS_OF_WEEK[d.getDay()];
      result.push({ day: label, count });
    }
    return result;
  }

  if (period === 'month') {
    // 4 weeks: "Sem 1" to "Sem 4"
    const result: { day: string; count: number }[] = [];
    for (let w = 0; w < 4; w++) {
      const weekStart = new Date(now);
      weekStart.setDate(weekStart.getDate() - 29 + w * 7);
      weekStart.setHours(0, 0, 0, 0);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);
      const count = recordings.filter((r) => r.date >= weekStart && r.date < weekEnd).length;
      result.push({ day: `Sem ${w + 1}`, count });
    }
    return result;
  }

  // year or all: last 12 months
  const result: { day: string; count: number }[] = [];
  for (let m = 11; m >= 0; m--) {
    const monthStart = new Date(now.getFullYear(), now.getMonth() - m, 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() - m + 1, 1);
    const count = recordings.filter((r) => r.date >= monthStart && r.date < monthEnd).length;
    result.push({ day: MONTH_ABBR[monthStart.getMonth()], count });
  }
  return result;
}

function filterByPeriod<T extends { date: Date }>(recordings: T[], period: Period): T[] {
  const now = new Date();
  if (period === 'all') return recordings;
  const days = period === 'week' ? 7 : period === 'month' ? 30 : 365;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return recordings.filter((r) => r.date >= cutoff);
}

function computeStats(
  recordings: { date: Date; meta: any }[],
  tplMap: Map<string, string>,
  period: Period,
  apiUsage: ApiUsageStats | null
): Stats {
  const filtered = filterByPeriod(recordings, period);

  const total = filtered.length;
  const uniquePatients = new Set(
    filtered.map((r) => r.meta.patientName).filter(Boolean)
  ).size;
  const withTranscript = filtered.filter((r) => r.meta.transcript).length;
  const withSummary = filtered.filter((r) => r.meta.summary).length;

  const perDay = computePerDay(filtered, period);

  const tplCounts = new Map<string, number>();
  filtered.forEach((r) => {
    if (r.meta.templateId) {
      const name = tplMap.get(r.meta.templateId) ?? 'Outro';
      tplCounts.set(name, (tplCounts.get(name) ?? 0) + 1);
    }
  });
  const perTemplate = [...tplCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const ptCounts = new Map<string, number>();
  filtered.forEach((r) => {
    if (r.meta.patientName) {
      ptCounts.set(r.meta.patientName, (ptCounts.get(r.meta.patientName) ?? 0) + 1);
    }
  });
  const topPatients = [...ptCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    totalRecordings: total,
    uniquePatients,
    withTranscript,
    withSummary,
    perDay,
    perTemplate,
    topPatients,
    apiUsage,
  };
}

const PERIOD_CHIPS: { key: Period; label: string }[] = [
  { key: 'week', label: '7 dias' },
  { key: 'month', label: 'Mês' },
  { key: 'year', label: 'Ano' },
  { key: 'all', label: 'Total' },
];

export default function StatsScreen() {
  const c = useColors();
  const [period, setPeriod] = useState<Period>('month');
  const [allRecordings, setAllRecordings] = useState<{ date: Date; meta: any }[]>([]);
  const [tplMap, setTplMap] = useState<Map<string, string>>(new Map());
  const [apiUsage, setApiUsage] = useState<ApiUsageStats | null>(null);
  const [loaded, setLoaded] = useState(false);

  const loadData = async () => {
    try {
      const meta = await getAllRecordingsMeta();
      const customTemplates = await getCustomTemplates();

      const map = new Map<string, string>();
      BUILTIN_TEMPLATES.forEach((t) => map.set(t.id, t.name));
      customTemplates.forEach((t) => map.set(t.id, t.name));

      const recs: { date: Date; meta: any }[] = [];
      for (const [fileName, m] of meta.entries()) {
        const match = fileName.match(/recording_(\d+)\.m4a/);
        if (match) {
          recs.push({ date: new Date(parseInt(match[1])), meta: m });
        }
      }

      let usage: ApiUsageStats | null = null;
      try {
        usage = await getApiUsageStats();
      } catch (e) {
        logWarn('stats', e);
      }

      setAllRecordings(recs);
      setTplMap(map);
      setApiUsage(usage);
      setLoaded(true);
    } catch (err) {
      logWarn('stats', err);
      setAllRecordings([]);
      setTplMap(new Map());
      setApiUsage(null);
      setLoaded(true);
    }
  };

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [])
  );

  const stats = loaded
    ? computeStats(allRecordings, tplMap, period, apiUsage)
    : null;

  if (!stats) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bgScreen, padding: 16 }}>
        <YStack gap="$3" mt="$6">
          <Text fontSize={24} fontWeight="800" color={c.primary}>
            Estatísticas
          </Text>
          <Text color={c.textSecondary} mt="$4">
            Carregando...
          </Text>
        </YStack>
        <BottomTabBar />
      </View>
    );
  }

  const maxDay = Math.max(1, ...stats.perDay.map((d) => d.count));
  const totalCostBRL = stats.apiUsage ? stats.apiUsage.totalUSD * BRL_RATE : 0;
  const costPerConsultation =
    stats.totalRecordings > 0 && totalCostBRL > 0
      ? totalCostBRL / stats.totalRecordings
      : null;

  return (
    <View style={{ flex: 1, backgroundColor: c.bgScreen }}>
      <ScrollView
        style={{ backgroundColor: c.bgScreen }}
        contentContainerStyle={{ padding: 16, paddingBottom: 70, gap: 20 }}
      >
        {/* Header */}
        <YStack gap="$3" mt="$6">
          <Text fontSize={24} fontWeight="800" color={c.primary}>
            Estatísticas
          </Text>

          {/* Period selector chips */}
          <XStack gap="$2" flexWrap="wrap">
            {PERIOD_CHIPS.map(({ key, label }) => {
              const active = period === key;
              return (
                <Pressable key={key} onPress={() => setPeriod(key)}>
                  <View
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                      borderRadius: 999,
                      backgroundColor: active ? c.primary : c.bgCard,
                      borderWidth: active ? 0 : 1,
                      borderColor: c.border,
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 12,
                        fontWeight: '700',
                        color: active ? c.textOnAccent : c.textSecondary,
                      }}
                    >
                      {label}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </XStack>
        </YStack>

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

        {/* Atividade chart */}
        <YStack gap="$2" mt="$2">
          <XStack alignItems="center" gap="$2">
            <Calendar size={18} color={c.textLabel} />
            <Text fontWeight="800" fontSize={13} color={c.textLabel}>
              {period === 'week'
                ? 'ATIVIDADE — ÚLTIMOS 7 DIAS'
                : period === 'month'
                ? 'ATIVIDADE — ÚLTIMOS 30 DIAS'
                : period === 'year'
                ? 'ATIVIDADE — ÚLTIMOS 12 MESES'
                : 'ATIVIDADE — TODOS OS TEMPOS'}
            </Text>
          </XStack>
          <YStack gap="$2" mt="$1">
            {stats.perDay.map((d, i) => (
              <XStack key={`${period}-${i}`} alignItems="center" gap="$3">
                <Text fontSize={11} color={c.textSecondary} w={44}>
                  {d.day}
                </Text>
                <AnimatedBar
                  count={d.count}
                  maxCount={maxDay}
                  primaryColor={c.primary}
                  bgCard={c.bgCard}
                  textColor={c.textSecondary}
                />
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
              {costPerConsultation !== null && (
                <Text fontSize={12} color={c.primary} fontWeight="600">
                  ≈ R${costPerConsultation.toFixed(2).replace('.', ',')} por consulta
                </Text>
              )}
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

      <BottomTabBar />
    </View>
  );
}
