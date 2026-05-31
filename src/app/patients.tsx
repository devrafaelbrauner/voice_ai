import { useState, useCallback } from 'react';
import { FlatList, Pressable, View, TextInput } from 'react-native';
import { YStack, XStack, Text } from 'tamagui';
import { User, ChevronRight, Search } from 'lucide-react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { getAllRecordingsMeta } from '../services/db';
import { useColors } from '../context/ThemeContext';
import { logError } from '../services/log';
import { BottomTabBar } from '../components/BottomTabBar';

interface PatientGroup {
  name: string;
  count: number;
  withSummary: number;
  lastDate: string;
}

const normalize = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const avatarColors = ['#000000', '#2e2b26', '#57534a', '#c2410c', '#ff3f00', '#8c8676'];
const getAvatarColor = (name: string) => avatarColors[name.charCodeAt(0) % avatarColors.length];

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0]?.toUpperCase() ?? '';
  return ((parts[0][0] ?? '') + (parts[parts.length - 1][0] ?? '')).toUpperCase();
}

function SkeletonRow({ c }: { c: ReturnType<typeof useColors> }) {
  return (
    <XStack bg={c.bgCard} p="$3" borderRadius="$4" alignItems="center" gap="$3" opacity={0.6}>
      <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: c.bgBlueSoft }} />
      <YStack f={1} gap="$2">
        <View style={{ height: 14, borderRadius: 6, backgroundColor: c.bgBlueSoft, width: '60%' }} />
        <View style={{ height: 11, borderRadius: 6, backgroundColor: c.bgBlueSoft, width: '80%' }} />
      </YStack>
    </XStack>
  );
}

export default function PatientsScreen() {
  const c = useColors();
  const [patients, setPatients] = useState<PatientGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const router = useRouter();

  const loadPatients = async () => {
    setLoading(true);
    try {
      const meta = await getAllRecordingsMeta();
      const map = new Map<string, PatientGroup>();

      for (const [fileName, m] of meta.entries()) {
        if (!m.patientName) continue;
        const match = fileName.match(/recording_(\d+)\.m4a/);
        const date = match
          ? new Date(parseInt(match[1])).toISOString()
          : new Date().toISOString();

        const existing = map.get(m.patientName);
        if (existing) {
          existing.count++;
          if (m.summary) existing.withSummary++;
          if (date > existing.lastDate) existing.lastDate = date;
        } else {
          map.set(m.patientName, {
            name: m.patientName,
            count: 1,
            withSummary: m.summary ? 1 : 0,
            lastDate: date,
          });
        }
      }

      const sorted = [...map.values()].sort(
        (a, b) => new Date(b.lastDate).getTime() - new Date(a.lastDate).getTime()
      );
      setPatients(sorted);
    } catch (err) {
      logError('patients', err);
      setPatients([]);
    } finally {
      setLoading(false);
    }
  };

  useFocusEffect(
    useCallback(() => {
      loadPatients();
    }, [])
  );

  const openPatient = (name: string) => {
    router.push(`/patient-history?name=${encodeURIComponent(name)}` as any);
  };

  const filteredPatients = patients.filter((item) =>
    normalize(item.name).includes(normalize(searchQuery.trim()))
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.bgScreen }}>
      <YStack f={1} p="$4" gap="$3">
        <XStack alignItems="center" gap="$3" mt="$6">
          <Text fontSize={24} fontWeight="800" color={c.primary}>
            Pacientes
          </Text>
        </XStack>

        <XStack
          alignItems="center"
          gap="$2"
          borderWidth={1}
          borderColor={c.borderInput}
          borderRadius={8}
          backgroundColor={c.bgInput}
          px="$3"
        >
          <Search size={18} color={c.textPlaceholder} />
          <TextInput
            style={{
              flex: 1,
              padding: 12,
              fontSize: 14,
              color: c.text,
            }}
            placeholder="Buscar paciente..."
            placeholderTextColor={c.textPlaceholder}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </XStack>

        {loading ? (
          <YStack gap="$3" pt="$2">
            {[0, 1, 2].map((i) => <SkeletonRow key={i} c={c} />)}
          </YStack>
        ) : patients.length === 0 ? (
          <YStack f={1} alignItems="center" justifyContent="center" gap="$2" p="$4">
            <User size={48} color={c.textPlaceholder} />
            <Text color={c.textLabel} fontSize={16} fontWeight="700" mt="$2">
              Nenhum paciente registrado
            </Text>
            <Text color={c.textPlaceholder} fontSize={13} textAlign="center">
              Os pacientes aparecem aqui automaticamente quando você grava consultas
              e processa com templates médicos (Receituário, Atestado, Consulta, etc).
            </Text>
          </YStack>
        ) : (
          <FlatList
            data={filteredPatients}
            keyExtractor={(item) => item.name}
            contentContainerStyle={{ gap: 12, paddingVertical: 12, paddingBottom: 70 }}
            renderItem={({ item }) => {
              const color = getAvatarColor(item.name);
              const initials = getInitials(item.name);
              return (
                <Pressable
                  onPress={() => openPatient(item.name)}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.name} — ${item.count} ${item.count > 1 ? 'consultas' : 'consulta'}`}
                  accessibilityHint="Abre o histórico de gravações deste paciente"
                >
                  <XStack
                    bg={c.bgCard}
                    p="$3"
                    borderRadius="$4"
                    alignItems="center"
                    gap="$3"
                  >
                    <View
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: 22,
                        backgroundColor: color + '26',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Text style={{ fontSize: 16, fontWeight: '800', color }}>
                        {initials}
                      </Text>
                    </View>
                    <YStack f={1}>
                      <Text fontWeight="700" fontSize={15} color={c.text}>
                        {item.name}
                      </Text>
                      <Text color={c.textSecondary} fontSize={12} mt="$1">
                        {item.count} {item.count > 1 ? 'consultas' : 'consulta'}
                        {item.withSummary > 0 ? ` · ${item.withSummary} processada(s)` : ''}
                        {' · '}última em{' '}
                        {new Date(item.lastDate).toLocaleDateString('pt-BR')}
                      </Text>
                    </YStack>
                    <ChevronRight size={20} color={c.textPlaceholder} />
                  </XStack>
                </Pressable>
              );
            }}
          />
        )}
      </YStack>
      <BottomTabBar />
    </View>
  );
}
