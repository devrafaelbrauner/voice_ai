import { useEffect, useMemo, useState } from 'react';
import { TextInput, Pressable, Alert, ScrollView, Switch, View } from 'react-native';
import { YStack, XStack, Text } from 'tamagui';
import {
  Key,
  Check,
  Trash2,
  Sparkles,
  ChevronRight,
  Stethoscope,
  Cpu,
  BarChart3,
  Cloud,
  RefreshCw,
  KeyRound,
  LogOut,
  Moon,
  UserCircle,
  Briefcase,
  Shield,
  ShieldOff,
  FileText,
  Lock,
  Download,
  HelpCircle,
  Link2,
  WifiOff,
  Wifi,
  Eye,
  EyeOff,
  PenLine,
  BadgeCheck,
  X as XIcon,
  Mic,
} from 'lucide-react-native';
import { Link } from 'expo-router';
import { getCurrentUser, signOut, onAuthChange, updatePassword } from '../services/auth';
import { useTheme } from '../hooks/useTheme';
import { useColors } from '../context/ThemeContext';
import { validatePassword, PASSWORD_REQUIREMENTS_HINT } from '../utils/password';
import { useLGPDConsent } from '../context/LGPDConsentContext';
import { syncNow, onSyncChange, getSyncStatus, SyncStatus } from '../services/sync';
import { exportBackup, buildBackup, describeBackup } from '../services/backup';
import type { User } from '@supabase/supabase-js';
import {
  getApiKey,
  setApiKey,
  clearApiKey,
  AVAILABLE_MODELS,
  getModel,
  setModel,
  OpenAIModel,
  getForceDirect,
  setForceDirect,
  getOpenAIMode,
  OpenAIMode,
  getOpenRouterApiKey,
  setOpenRouterApiKey,
  AVAILABLE_TRANSCRIPTION_MODELS,
  getTranscriptionModel,
  setTranscriptionModel,
  TranscriptionModelId,
} from '../services/openai';
import {
  getDoctorProfile,
  setDoctorProfile,
  DoctorProfile,
} from '../services/doctor';
import {
  getEvoPadConfig,
  setEvoPadConfig,
  isEvoPadAvailable,
  validateEvoPadUrl,
  validateEvoPadToken,
  isLocalUrl,
  EvoPadConfig,
} from '../services/evopad-export';
import { OnboardingModal } from '../components/OnboardingModal';
import { BottomTabBar } from '../components/BottomTabBar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getBirdIdToken,
  setBirdIdToken,
  clearBirdIdToken,
  validateBirdIdToken,
  getSessionMeta,
  isSessionExpired,
  formatSessionExpiry,
  type BirdIdUserInfo,
} from '../services/bird-id';

const ONBOARDING_SEEN_KEY = '@voice_ai_recorder/onboarding_seen/v1';

function SectionHeader({ label }: { label: string }) {
  const c = useColors();
  return (
    <Text
      style={{
        fontSize: 11,
        fontWeight: '700',
        color: c.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 1,
        marginTop: 24,
        marginBottom: 8,
      }}
    >
      {label}
    </Text>
  );
}

export default function SettingsScreen() {
  const { isDark, toggleTheme } = useTheme();
  const c = useColors();
  const { accepted: lgpdAccepted, acceptedAt: lgpdAcceptedAt, revokeConsent: revokeLGPD } = useLGPDConsent();

  const inputStyle = useMemo(
    () => ({
      borderWidth: 1,
      borderColor: c.borderInput,
      borderRadius: 8,
      padding: 12,
      fontSize: 14,
      backgroundColor: c.bgInput,
      color: c.text,
    }),
    [c]
  );

  const [showOnboarding, setShowOnboarding] = useState(false);

  const [key, setKey] = useState('');
  const [keySaved, setKeySaved] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [doctor, setDoctor] = useState<DoctorProfile>({
    name: '',
    title: '',
    crmNumber: '',
    crmUF: '',
    address: '',
    phone: '',
    city: '',
    professionalEnabled: false,
  });
  const [doctorSaved, setDoctorSaved] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [model, setModelState] = useState<OpenAIModel>('gpt-4o-mini');
  const [transcriptionModel, setTranscriptionModelState] = useState<TranscriptionModelId>('whisper-1');
  const [user, setUser] = useState<User | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPwd, setChangingPwd] = useState(false);
  const [forceDirect, setForceDirectState] = useState(false);
  const [openaiMode, setOpenAIMode] = useState<OpenAIMode>('direct');
  const [backupSummary, setBackupSummary] = useState<string | null>(null);
  const [exportingBackup, setExportingBackup] = useState(false);
  const [evoPadConfig, setEvoPadConfigState] = useState<EvoPadConfig>({
    baseUrl: 'http://127.0.0.1:4173',
    importToken: '',
  });
  const [evoPadSaved, setEvoPadSaved] = useState(false);
  const [evoPadTestStatus, setEvoPadTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [openrouterKey, setOpenrouterKey] = useState('');
  const [openrouterSaved, setOpenrouterSaved] = useState(false);

  // Bird ID — Assinatura Digital
  const [birdIdToken, setBirdIdTokenState] = useState('');
  const [birdIdSaved, setBirdIdSaved] = useState(false);
  const [showBirdIdToken, setShowBirdIdToken] = useState(false);
  const [birdIdValidating, setBirdIdValidating] = useState(false);
  const [birdIdUserInfo, setBirdIdUserInfo] = useState<BirdIdUserInfo | null>(null);
  const [birdIdExpired, setBirdIdExpired] = useState(false);

  const refreshBackupSummary = async () => {
    try {
      const payload = await buildBackup();
      setBackupSummary(describeBackup(payload));
    } catch {
      setBackupSummary(null);
    }
  };

  useEffect(() => {
    getApiKey().then((k) => {
      if (k) setKey(k);
    });
    getDoctorProfile().then(setDoctor);
    getModel().then(setModelState);
    getTranscriptionModel().then(setTranscriptionModelState);
    getCurrentUser().then(setUser);
    getForceDirect().then(setForceDirectState);
    getOpenAIMode().then(setOpenAIMode);
    getEvoPadConfig().then(setEvoPadConfigState);
    getOpenRouterApiKey().then((k) => { if (k) setOpenrouterKey(k); });
    getBirdIdToken().then((t) => { if (t) setBirdIdTokenState(t); });
    getSessionMeta().then((meta) => {
      if (!meta) return;
      const expired = isSessionExpired(meta);
      setBirdIdExpired(expired);
      setBirdIdUserInfo({
        name: meta.holderName,
        cpf: meta.holderCpf,
        expiresAt: meta.expiresAt,
      });
    });
    refreshBackupSummary();
    const currentSync = getSyncStatus();
    setSyncStatus(currentSync.status);
    setLastSync(currentSync.lastSyncAt);
    const unsubscribeAuth = onAuthChange(setUser);
    const unsubscribeSync = onSyncChange((status, syncDate) => {
      setSyncStatus(status);
      setLastSync(syncDate);
    });
    return () => {
      unsubscribeAuth();
      unsubscribeSync();
    };
  }, []);

  const handleSaveEvoPad = async () => {
    try {
      await setEvoPadConfig(evoPadConfig);
      setEvoPadSaved(true);
      setTimeout(() => setEvoPadSaved(false), 1800);
    } catch (err: any) {
      Alert.alert('Configuração inválida', err?.message ?? String(err));
    }
  };

  const handleTestEvoPad = async () => {
    setEvoPadTestStatus('testing');
    try {
      const ok = await isEvoPadAvailable();
      setEvoPadTestStatus(ok ? 'ok' : 'fail');
    } catch {
      setEvoPadTestStatus('fail');
    }
    setTimeout(() => setEvoPadTestStatus('idle'), 4000);
  };

  const handleSaveBirdIdToken = async () => {
    const token = birdIdToken.trim();
    if (!token) {
      Alert.alert('Token inválido', 'Cole o token Bearer obtido no portal Bird ID.');
      return;
    }
    await setBirdIdToken(token);
    setBirdIdSaved(true);
    setTimeout(() => setBirdIdSaved(false), 1800);
  };

  const handleValidateBirdIdToken = async () => {
    const token = birdIdToken.trim();
    if (!token) {
      Alert.alert('Token vazio', 'Cole o signature_session antes de verificar.');
      return;
    }
    setBirdIdValidating(true);
    setBirdIdUserInfo(null);
    setBirdIdExpired(false);
    try {
      const info = await validateBirdIdToken(token);
      setBirdIdUserInfo(info);
      setBirdIdExpired(false);
      // Salva automaticamente se a validação for bem-sucedida
      await setBirdIdToken(token);
      setBirdIdSaved(true);
      setTimeout(() => setBirdIdSaved(false), 1800);
    } catch (err: any) {
      Alert.alert('Sessão inválida', err?.message ?? String(err));
    } finally {
      setBirdIdValidating(false);
    }
  };

  const handleClearBirdIdToken = async () => {
    Alert.alert(
      'Remover token Bird ID',
      'O token será removido. Você poderá adicionar um novo a qualquer momento.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Remover',
          style: 'destructive',
          onPress: async () => {
            await clearBirdIdToken();
            setBirdIdTokenState('');
            setBirdIdUserInfo(null);
          },
        },
      ]
    );
  };

  const handleExportBackup = async () => {
    setExportingBackup(true);
    try {
      await exportBackup();
    } finally {
      setExportingBackup(false);
      refreshBackupSummary();
    }
  };

  // Re-evaluate the effective mode whenever auth or the force toggle changes.
  useEffect(() => {
    getOpenAIMode().then(setOpenAIMode);
  }, [user, forceDirect]);

  const handleToggleForceDirect = async (v: boolean) => {
    await setForceDirect(v);
    setForceDirectState(v);
  };

  const handleChangePassword = async () => {
    const check = validatePassword(newPassword);
    if (!check.valid) {
      Alert.alert('Senha fraca', check.error!);
      return;
    }
    if (newPassword !== confirmPassword) {
      Alert.alert('Erro', 'As senhas não conferem.');
      return;
    }
    setChangingPwd(true);
    try {
      await updatePassword(newPassword);
      setNewPassword('');
      setConfirmPassword('');
      Alert.alert('Sucesso', 'Senha alterada com sucesso!');
    } catch (err: any) {
      Alert.alert('Erro', err?.message ?? String(err));
    } finally {
      setChangingPwd(false);
    }
  };

  const handleSync = async () => {
    const result = await syncNow();
    if (result.error) {
      Alert.alert('Erro na sincronização', result.error);
    } else {
      Alert.alert(
        'Sincronizado',
        `Pulled: ${result.pulled.recordings} gravações, ${result.pulled.templates} templates.\nPushed: ${result.pushed.recordings} gravações, ${result.pushed.templates} templates.`
      );
    }
  };

  const handleSignOut = async () => {
    Alert.alert(
      'Sair da conta',
      'Tem certeza? Você poderá entrar novamente a qualquer momento.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Sair',
          style: 'destructive',
          onPress: async () => {
            try {
              await signOut();
            } catch (err: any) {
              Alert.alert('Erro', err?.message ?? String(err));
            }
          },
        },
      ]
    );
  };

  const handleSelectModel = async (id: OpenAIModel) => {
    await setModel(id);
    setModelState(id);
  };

  const handleSelectTranscriptionModel = async (id: TranscriptionModelId) => {
    await setTranscriptionModel(id);
    setTranscriptionModelState(id);
  };

  const handleSaveOpenRouterKey = async () => {
    const trimmed = openrouterKey.trim();
    if (!trimmed) {
      Alert.alert('Erro', 'Insira sua chave OpenRouter antes de salvar.');
      return;
    }
    await setOpenRouterApiKey(trimmed);
    setOpenrouterSaved(true);
    setTimeout(() => setOpenrouterSaved(false), 2000);
  };

  const handleClearOpenRouterKey = async () => {
    Alert.alert(
      'Remover chave OpenRouter',
      'Tem certeza? Modelos via OpenRouter (Grok, Kimi, GPT-4o Mini TTS) deixarão de funcionar.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Remover',
          style: 'destructive',
          onPress: async () => {
            await setOpenRouterApiKey('');
            setOpenrouterKey('');
          },
        },
      ]
    );
  };

  const handleSaveKey = async () => {
    const trimmed = key.trim();
    if (!trimmed.startsWith('sk-') || trimmed.length < 20) {
      Alert.alert('Chave inválida', 'Uma chave OpenAI válida começa com "sk-" e tem pelo menos 20 caracteres.');
      return;
    }
    await setApiKey(trimmed);
    setKeySaved(true);
    setTimeout(() => setKeySaved(false), 2000);
  };

  const handleClearKey = async () => {
    await clearApiKey();
    setKey('');
    Alert.alert('Removida', 'API key apagada do dispositivo.');
  };

  const handleSaveDoctor = async () => {
    await setDoctorProfile(doctor);
    setDoctorSaved(true);
    setTimeout(() => setDoctorSaved(false), 2000);
  };

  const handleAutoSaveProfile = async () => {
    await setDoctorProfile(doctor);
    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 2000);
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.bgScreen }}>
      <YStack p="$4" gap="$3">
        <XStack alignItems="center" gap="$3" mt="$6">
          <Text fontSize={24} fontWeight="800" color={c.primary}>
            Configurações
          </Text>
        </XStack>
      </YStack>

      <ScrollView
        style={{ flex: 1, backgroundColor: c.bgScreen }}
        contentContainerStyle={{ padding: 16, paddingBottom: 70, gap: 24 }}
        keyboardShouldPersistTaps="handled"
      >

        {/* SEÇÃO: CONTA NA NUVEM */}
        <SectionHeader label="Conta" />

        {/* Conta na Nuvem */}
        <YStack gap="$3">
          <XStack alignItems="center" gap="$2">
            <Cloud size={20} color={c.accentBlue} />
            <Text fontSize={16} fontWeight="700" color={c.text}>Conta na Nuvem</Text>
          </XStack>
          {user ? (
            <>
              <Text color={c.textSecondary} fontSize={12}>Logado como:</Text>
              <XStack bg={c.bgBlueSoft} p="$3" borderRadius="$3" alignItems="center" gap="$3">
                <Cloud size={18} color={c.accentBlue} />
                <Text f={1} color={c.accentNavy} fontWeight="700" fontSize={14}>
                  {user.email}
                </Text>
              </XStack>
              <Pressable
                onPress={handleSync}
                disabled={syncStatus === 'syncing'}
                accessibilityRole="button"
                accessibilityLabel={syncStatus === 'syncing' ? 'Sincronizando…' : 'Sincronizar agora'}
                accessibilityState={{ busy: syncStatus === 'syncing', disabled: syncStatus === 'syncing' }}
              >
                <XStack
                  bg={syncStatus === 'syncing' ? c.textPlaceholder : c.accentBlue}
                  p="$3"
                  borderRadius="$3"
                  alignItems="center"
                  justifyContent="center"
                  gap="$2"
                >
                  <RefreshCw size={18} color={c.textOnAccent} />
                  <Text color={c.textOnAccent} fontWeight="700">
                    {syncStatus === 'syncing' ? 'Sincronizando...' : 'Sincronizar agora'}
                  </Text>
                </XStack>
              </Pressable>
              {lastSync && (
                <Text color={c.textSecondary} fontSize={11} textAlign="center">
                  Última sincronização: {lastSync.toLocaleString('pt-BR')}
                </Text>
              )}
              <YStack
                bg={c.bgSubtle}
                p="$3"
                borderRadius="$3"
                gap="$2"
                borderWidth={1}
                borderColor={c.border}
              >
                <XStack alignItems="center" gap="$2">
                  <KeyRound size={16} color={c.textLabel} />
                  <Text fontWeight="700" fontSize={13} color={c.text}>Alterar senha</Text>
                </XStack>
                <TextInput
                  value={newPassword}
                  onChangeText={setNewPassword}
                  placeholder={`Nova senha (${PASSWORD_REQUIREMENTS_HINT})`}
                  placeholderTextColor={c.textPlaceholder}
                  secureTextEntry
                  autoCapitalize="none"
                  style={inputStyle}
                  editable={!changingPwd}
                />
                <TextInput
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  placeholder="Confirmar nova senha"
                  placeholderTextColor={c.textPlaceholder}
                  secureTextEntry
                  autoCapitalize="none"
                  style={inputStyle}
                  editable={!changingPwd}
                />
                <Pressable
                  onPress={handleChangePassword}
                  disabled={changingPwd}
                  accessibilityRole="button"
                  accessibilityLabel={changingPwd ? 'Atualizando senha…' : 'Atualizar senha'}
                  accessibilityState={{ busy: changingPwd, disabled: changingPwd }}
                >
                  <XStack
                    bg={changingPwd ? c.textPlaceholder : c.textLabel}
                    p="$2"
                    borderRadius="$3"
                    alignItems="center"
                    justifyContent="center"
                    gap="$2"
                  >
                    <KeyRound size={14} color={c.textOnAccent} />
                    <Text color={c.textOnAccent} fontWeight="700" fontSize={13}>
                      {changingPwd ? 'Atualizando...' : 'Atualizar senha'}
                    </Text>
                  </XStack>
                </Pressable>
              </YStack>
              <Pressable
                onPress={handleSignOut}
                accessibilityRole="button"
                accessibilityLabel="Sair da conta"
                accessibilityHint="Encerra a sessão na nuvem"
              >
                <XStack bg={c.accentRed} p="$3" borderRadius="$3" alignItems="center" justifyContent="center" gap="$2">
                  <LogOut size={18} color={c.textOnAccent} />
                  <Text color={c.textOnAccent} fontWeight="700">Sair da conta</Text>
                </XStack>
              </Pressable>
            </>
          ) : (
            <>
              <Text color={c.textSecondary} fontSize={12}>
                Crie uma conta para sincronizar suas gravações entre dispositivos com backup automático.
              </Text>
              <Link href="/auth" asChild>
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel="Entrar ou criar conta"
                  accessibilityHint="Navega para a tela de login e sincronização na nuvem"
                >
                  <XStack bg={c.accentBlue} p="$3" borderRadius="$3" alignItems="center" justifyContent="center" gap="$2">
                    <Cloud size={18} color={c.textOnAccent} />
                    <Text color={c.textOnAccent} fontWeight="700">Entrar ou criar conta</Text>
                  </XStack>
                </Pressable>
              </Link>
            </>
          )}
        </YStack>

        {/* SEÇÃO: BACKUP */}
        <SectionHeader label="Backup" />

        {/* Backup & Exportação */}
        <YStack
          bg={c.bgCard}
          p="$3"
          borderRadius="$3"
          gap="$3"
        >
          <XStack alignItems="center" gap="$2">
            <Download size={20} color={c.accentBlue} />
            <Text fontWeight="700" fontSize={14} color={c.text}>
              Backup & Exportação
            </Text>
          </XStack>

          <Text fontSize={12} color={c.textSecondary} lineHeight={18}>
            Gere um arquivo JSON com todas as suas gravações, transcrições,
            resumos, dados profissionais e templates personalizados.
            Útil para portabilidade (LGPD Art. 18) ou trocar de aparelho.
          </Text>

          {backupSummary && (
            <XStack
              bg={c.bgBlueSoft}
              borderWidth={1}
              borderColor={c.accentBlue}
              borderRadius="$3"
              px="$3"
              py="$2"
              alignItems="center"
              gap="$2"
            >
              <FileText size={14} color={c.accentBlue} />
              <Text fontSize={12} color={c.accentNavy} flex={1}>
                {backupSummary}
              </Text>
            </XStack>
          )}

          <Pressable
            onPress={handleExportBackup}
            disabled={exportingBackup}
            accessibilityRole="button"
            accessibilityLabel={exportingBackup ? 'Gerando backup…' : 'Exportar backup em JSON'}
            accessibilityHint="Gera um arquivo com todas as gravações e dados para exportação"
            accessibilityState={{ busy: exportingBackup, disabled: exportingBackup }}
          >
            <XStack
              bg={exportingBackup ? c.bgSubtle : c.accentBlue}
              borderRadius="$3"
              px="$3"
              py="$3"
              alignItems="center"
              justifyContent="center"
              gap="$2"
              opacity={exportingBackup ? 0.6 : 1}
            >
              <Download size={16} color={exportingBackup ? c.textSecondary : c.textOnAccent} />
              <Text
                fontSize={13}
                color={exportingBackup ? c.textSecondary : c.textOnAccent}
                fontWeight="700"
              >
                {exportingBackup ? 'Gerando backup…' : 'Exportar backup (JSON)'}
              </Text>
            </XStack>
          </Pressable>
        </YStack>

        {/* SEÇÃO: PERFIL */}
        <SectionHeader label="Perfil" />

        {/* Perfil Pessoal */}
        <YStack gap="$3">
          <XStack alignItems="center" gap="$2">
            <UserCircle size={20} color={c.accentBlue} />
            <Text fontSize={16} fontWeight="700" color={c.text}>
              Perfil Pessoal
            </Text>
            {profileSaved && (
              <Text style={{ fontSize: 12, color: c.secondary, marginLeft: 8 }}>Salvo ✓</Text>
            )}
          </XStack>
          <Text color={c.textSecondary} fontSize={12}>
            Informações básicas usadas em todas as gravações. Salvas automaticamente ao sair do campo.
          </Text>

          <YStack gap="$2">
            <Text fontWeight="700" fontSize={12} color={c.textLabel}>
              Nome completo
            </Text>
            <TextInput
              value={doctor.name}
              onChangeText={(v) => setDoctor({ ...doctor, name: v })}
              onBlur={handleAutoSaveProfile}
              placeholder="Seu nome"
              placeholderTextColor={c.textPlaceholder}
              style={inputStyle}
            />
          </YStack>

          <YStack gap="$2">
            <Text fontWeight="700" fontSize={12} color={c.textLabel}>
              Telefone
            </Text>
            <TextInput
              value={doctor.phone}
              onChangeText={(v) => setDoctor({ ...doctor, phone: v })}
              onBlur={handleAutoSaveProfile}
              placeholder="(85) 99999-9999"
              placeholderTextColor={c.textPlaceholder}
              keyboardType="phone-pad"
              style={inputStyle}
            />
          </YStack>
        </YStack>

        {/* Perfil Profissional */}
        <YStack gap="$3">
          <XStack alignItems="center" gap="$2">
            <Briefcase size={20} color={c.secondary} />
            <Text fontSize={16} fontWeight="700" color={c.text}>
              Perfil Profissional
            </Text>
          </XStack>
          <Text color={c.textSecondary} fontSize={12}>
            Opcional. Ative para incluir dados profissionais nos PDFs e exportações para o EvoPad.
          </Text>

          <XStack
            bg={c.bgSubtle}
            borderWidth={1}
            borderColor={c.border}
            p="$3"
            borderRadius="$3"
            alignItems="center"
            justifyContent="space-between"
            gap="$3"
          >
            <YStack f={1} gap="$1">
              <Text fontWeight="700" fontSize={14} color={c.text}>
                Habilitar perfil profissional
              </Text>
              <Text fontSize={12} color={c.textSecondary}>
                {doctor.professionalEnabled
                  ? 'Perfil profissional ativo (Médico)'
                  : 'Apenas perfil pessoal'}
              </Text>
            </YStack>
            <Switch
              value={doctor.professionalEnabled}
              onValueChange={(v) =>
                setDoctor({ ...doctor, professionalEnabled: v })
              }
              trackColor={{ false: c.borderInput, true: c.secondary }}
              thumbColor={doctor.professionalEnabled ? c.secondary : c.bgCard}
              accessibilityLabel="Habilitar perfil profissional"
              accessibilityHint="Inclui dados de médico nos PDFs e exportações"
            />
          </XStack>

          {doctor.professionalEnabled && (
            <YStack
              gap="$3"
              bg={c.bgPurpleSoft}
              p="$3"
              borderRadius="$3"
              borderWidth={1}
              borderColor={c.borderPurple}
            >
              <XStack alignItems="center" gap="$2">
                <Stethoscope size={18} color={c.secondary} />
                <Text fontWeight="700" fontSize={13} color={c.secondary}>
                  DADOS DE MÉDICO
                </Text>
              </XStack>

              <YStack gap="$2">
                <Text fontWeight="700" fontSize={12} color={c.textLabel}>
                  Cargo / Especialidade
                </Text>
                <TextInput
                  value={doctor.title}
                  onChangeText={(v) => setDoctor({ ...doctor, title: v })}
                  onBlur={handleAutoSaveProfile}
                  placeholder="Médico"
                  placeholderTextColor={c.textPlaceholder}
                  style={inputStyle}
                />
              </YStack>

              <XStack gap="$2">
                <YStack f={2} gap="$2">
                  <Text fontWeight="700" fontSize={12} color={c.textLabel}>
                    CRM (número)
                  </Text>
                  <TextInput
                    value={doctor.crmNumber}
                    onChangeText={(v) =>
                      setDoctor({
                        ...doctor,
                        crmNumber: v.replace(/[^0-9]/g, ''),
                      })
                    }
                    onBlur={handleAutoSaveProfile}
                    placeholder="17950"
                    placeholderTextColor={c.textPlaceholder}
                    keyboardType="number-pad"
                    style={inputStyle}
                  />
                </YStack>
                <YStack f={1} gap="$2">
                  <Text fontWeight="700" fontSize={12} color={c.textLabel}>
                    UF
                  </Text>
                  <TextInput
                    value={doctor.crmUF}
                    onChangeText={(v) =>
                      setDoctor({
                        ...doctor,
                        crmUF: v.toUpperCase().slice(0, 2),
                      })
                    }
                    onBlur={handleAutoSaveProfile}
                    placeholder="CE"
                    placeholderTextColor={c.textPlaceholder}
                    autoCapitalize="characters"
                    maxLength={2}
                    style={inputStyle}
                  />
                </YStack>
              </XStack>

              <YStack gap="$2">
                <Text fontWeight="700" fontSize={12} color={c.textLabel}>
                  Endereço profissional
                </Text>
                <TextInput
                  value={doctor.address}
                  onChangeText={(v) => setDoctor({ ...doctor, address: v })}
                  onBlur={handleAutoSaveProfile}
                  placeholder="Rua das Flores, 123, Sala 5, Aldeota"
                  placeholderTextColor={c.textPlaceholder}
                  style={inputStyle}
                  multiline
                />
              </YStack>

              <YStack gap="$2">
                <Text fontWeight="700" fontSize={12} color={c.textLabel}>
                  Cidade
                </Text>
                <TextInput
                  value={doctor.city}
                  onChangeText={(v) => setDoctor({ ...doctor, city: v })}
                  onBlur={handleAutoSaveProfile}
                  placeholder="Fortaleza"
                  placeholderTextColor={c.textPlaceholder}
                  style={inputStyle}
                />
              </YStack>
            </YStack>
          )}
        </YStack>

        {/* SEÇÃO: APARÊNCIA */}
        <SectionHeader label="Aparência" />

        {/* Aparência */}
        <YStack gap="$3">
          <XStack alignItems="center" gap="$2">
            <Moon size={20} color={c.textSecondary} />
            <Text fontSize={16} fontWeight="700" color={c.text}>
              Aparência
            </Text>
          </XStack>
          <XStack
            bg={c.bgSubtle}
            borderWidth={1}
            borderColor={c.border}
            p="$3"
            borderRadius="$3"
            alignItems="center"
            justifyContent="space-between"
            gap="$3"
          >
            <YStack f={1} gap="$1">
              <Text fontWeight="700" fontSize={14} color={c.text}>
                Modo Escuro
              </Text>
              <Text fontSize={12} color={c.textSecondary}>
                {isDark ? 'Tema escuro ativado' : 'Tema claro ativado'}
              </Text>
            </YStack>
            <Switch
              value={isDark}
              onValueChange={() => toggleTheme()}
              trackColor={{ false: c.borderInput, true: c.primary }}
              thumbColor={isDark ? c.primary : c.bgCard}
              accessibilityLabel="Modo escuro"
              accessibilityHint={isDark ? 'Desativar tema escuro' : 'Ativar tema escuro'}
            />
          </XStack>
        </YStack>

        {/* SEÇÃO: MODELO DE IA */}
        <SectionHeader label="Modelo de IA" />

        {/* Modelo de IA */}
        <YStack gap="$3">
          <XStack alignItems="center" gap="$2">
            <Cpu size={20} color={c.secondary} />
            <Text fontSize={16} fontWeight="700" color={c.text}>
              Modelo de IA
            </Text>
          </XStack>
          <Text color={c.textSecondary} fontSize={12}>
            Modelos <Text color={c.accentGreenDark} fontSize={12} fontWeight="700">OPENAI</Text> usam a chave OpenAI ou o proxy seguro.
            Modelos <Text color={c.accentOrange} fontSize={12} fontWeight="700">OPENROUTER</Text> usam a chave OpenRouter. Configure as duas abaixo para usar qualquer modelo.
          </Text>
          {AVAILABLE_MODELS.map((m) => {
            const selected = model === m.id;
            const isOR = m.provider === 'openrouter';
            return (
              <Pressable
                key={m.id}
                onPress={() => handleSelectModel(m.id)}
                accessibilityRole="radio"
                accessibilityLabel={m.name}
                accessibilityHint={m.description}
                accessibilityState={{ checked: selected }}
              >
                <XStack
                  bg={selected ? c.bgPurpleSoft : c.bgSubtle}
                  borderWidth={selected ? 2 : 1}
                  borderColor={selected ? c.secondary : c.border}
                  p="$3"
                  borderRadius="$3"
                  alignItems="center"
                  gap="$3"
                >
                  <YStack f={1}>
                    <XStack alignItems="center" gap="$2" flexWrap="wrap">
                      <Text
                        fontWeight="700"
                        fontSize={14}
                        color={selected ? c.secondary : c.text}
                      >
                        {m.name}
                      </Text>
                      {/* Provider badge */}
                      <XStack
                        px="$1.5"
                        py={2}
                        borderRadius={6}
                        bg={isOR ? c.bgYellowSoft : c.bgGreenSoft}
                      >
                        <Text
                          fontSize={9}
                          fontWeight="700"
                          color={isOR ? c.accentOrange : c.accentGreenDark}
                          letterSpacing={0.5}
                        >
                          {isOR ? 'OPENROUTER' : 'OPENAI'}
                        </Text>
                      </XStack>
                      <Text fontSize={10} color={c.textSecondary}>
                        {m.costHint}
                      </Text>
                    </XStack>
                    <Text color={c.textSecondary} fontSize={12} mt="$1">
                      {m.description}
                    </Text>
                  </YStack>
                  {selected ? <Check size={20} color={c.secondary} /> : null}
                </XStack>
              </Pressable>
            );
          })}
        </YStack>

        {/* Modelo de Transcrição */}
        <YStack gap="$3" mt="$4">
          <XStack alignItems="center" gap="$2">
            <Mic size={20} color={c.secondary} />
            <Text fontSize={16} fontWeight="700" color={c.text}>
              Modelo de Transcrição
            </Text>
          </XStack>
          <Text color={c.textSecondary} fontSize={12}>
            Escolha o motor de speech-to-text.{' '}
            <Text color={c.accentGreenDark} fontSize={12} fontWeight="700">OPENAI</Text>
            {' '}usa proxy seguro.{' '}
            <Text color={c.accentOrange} fontSize={12} fontWeight="700">OPENROUTER</Text>
            {' '}requer chave OpenRouter.
          </Text>
          {AVAILABLE_TRANSCRIPTION_MODELS.map((m) => {
            const selected = transcriptionModel === m.id;
            const isOR = m.provider === 'openrouter';
            return (
              <Pressable
                key={m.id}
                onPress={() => handleSelectTranscriptionModel(m.id)}
                accessibilityRole="radio"
                accessibilityLabel={m.name}
                accessibilityHint={m.description}
                accessibilityState={{ checked: selected }}
              >
                <XStack
                  bg={selected ? c.bgPurpleSoft : c.bgSubtle}
                  borderWidth={selected ? 2 : 1}
                  borderColor={selected ? c.secondary : c.border}
                  p="$3"
                  borderRadius="$3"
                  alignItems="center"
                  gap="$3"
                >
                  <YStack f={1}>
                    <XStack alignItems="center" gap="$2" flexWrap="wrap">
                      <Text fontWeight="700" fontSize={14} color={selected ? c.secondary : c.text}>
                        {m.name}
                      </Text>
                      <XStack
                        px="$1.5"
                        py={2}
                        borderRadius={6}
                        bg={isOR ? c.bgYellowSoft : c.bgGreenSoft}
                      >
                        <Text
                          fontSize={9}
                          fontWeight="700"
                          color={isOR ? c.accentOrange : c.accentGreenDark}
                          letterSpacing={0.5}
                        >
                          {isOR ? 'OPENROUTER' : 'OPENAI'}
                        </Text>
                      </XStack>
                      <Text fontSize={10} color={c.textSecondary}>
                        {m.costHint}
                      </Text>
                    </XStack>
                    <Text color={c.textSecondary} fontSize={12} mt="$1">
                      {m.description}
                    </Text>
                  </YStack>
                  {selected ? <Check size={20} color={c.secondary} /> : null}
                </XStack>
              </Pressable>
            );
          })}
        </YStack>

        {/* SEÇÃO: API KEYS */}
        <SectionHeader label="API Keys" />

        {/* Modo OpenAI */}
        <YStack gap="$3">
          <XStack alignItems="center" gap="$2">
            {openaiMode === 'proxy' ? (
              <Shield size={20} color={c.primary} />
            ) : (
              <ShieldOff size={20} color={c.accentOrange} />
            )}
            <Text fontSize={16} fontWeight="700" color={c.text}>
              Modo OpenAI
            </Text>
          </XStack>

          <XStack
            bg={openaiMode === 'proxy' ? c.bgGreenSoft : c.bgYellowSoft}
            borderWidth={1}
            borderColor={openaiMode === 'proxy' ? c.borderGreen : c.borderYellow}
            p="$3"
            borderRadius="$3"
            gap="$2"
          >
            <YStack f={1} gap="$1">
              <Text fontWeight="700" fontSize={13} color={c.text}>
                {openaiMode === 'proxy'
                  ? '🛡️ Proxy seguro ativo'
                  : '🔑 Chave própria no dispositivo'}
              </Text>
              <Text fontSize={12} color={c.textSecondary}>
                {openaiMode === 'proxy'
                  ? 'A chave OpenAI fica no servidor Supabase. Autenticação via JWT.'
                  : user
                  ? 'Você desativou o proxy. Suas chamadas usam a chave abaixo.'
                  : 'Faça login para usar o proxy seguro (sem precisar de chave própria).'}
              </Text>
            </YStack>
          </XStack>

          {user && (
            <XStack
              bg={c.bgSubtle}
              borderWidth={1}
              borderColor={c.border}
              p="$3"
              borderRadius="$3"
              alignItems="center"
              justifyContent="space-between"
              gap="$3"
            >
              <YStack f={1} gap="$1">
                <Text fontWeight="700" fontSize={14} color={c.text}>
                  Forçar chave própria
                </Text>
                <Text fontSize={12} color={c.textSecondary}>
                  Use sua chave OpenAI mesmo logado (não recomendado).
                </Text>
              </YStack>
              <Switch
                value={forceDirect}
                onValueChange={handleToggleForceDirect}
                trackColor={{ false: c.borderInput, true: c.accentOrange }}
                thumbColor={forceDirect ? c.accentOrange : c.bgCard}
                accessibilityLabel="Forçar chave própria OpenAI"
                accessibilityHint="Usa sua chave OpenAI mesmo quando o proxy seguro está disponível"
              />
            </XStack>
          )}
        </YStack>

        {/* API Key OpenAI */}
        <YStack gap="$3">
          <XStack alignItems="center" gap="$2">
            <Key size={20} color={c.textLabel} />
            <Text fontSize={16} fontWeight="700" color={c.text}>
              OpenAI API Key
            </Text>
            {openaiMode === 'proxy' && (
              <Text fontSize={11} color={c.textSecondary}>
                (não usada no modo seguro)
              </Text>
            )}
          </XStack>
          <Text color={c.textSecondary} fontSize={12}>
            Cola sua chave (começa com sk-...). Fica salva apenas no seu
            dispositivo, criptografada. Só é usada quando o proxy seguro está
            indisponível ou desativado.
          </Text>
          <XStack
            alignItems="center"
            borderWidth={1}
            borderColor={c.borderInput}
            borderRadius={8}
            backgroundColor={c.bgInput}
            paddingRight={12}
          >
            <TextInput
              value={key}
              onChangeText={setKey}
              placeholder="sk-..."
              placeholderTextColor={c.textPlaceholder}
              secureTextEntry={!showApiKey}
              autoCapitalize="none"
              autoCorrect={false}
              style={[inputStyle, { flex: 1, borderWidth: 0, borderRadius: 0 }]}
            />
            <Pressable onPress={() => setShowApiKey((v) => !v)} hitSlop={8}>
              {showApiKey ? (
                <EyeOff size={18} color={c.textMuted} />
              ) : (
                <Eye size={18} color={c.textMuted} />
              )}
            </Pressable>
          </XStack>
          <XStack gap="$2">
            <Pressable
              onPress={handleSaveKey}
              style={{ flex: 1 }}
              accessibilityRole="button"
              accessibilityLabel={keySaved ? 'Chave salva' : 'Salvar chave OpenAI'}
            >
              <XStack
                bg={c.primary}
                p="$3"
                borderRadius="$3"
                alignItems="center"
                justifyContent="center"
                gap="$2"
              >
                <Check size={18} color={c.textOnAccent} />
                <Text color={c.textOnAccent} fontWeight="700">
                  {keySaved ? 'Salvo!' : 'Salvar'}
                </Text>
              </XStack>
            </Pressable>
            {key.length > 0 ? (
              <Pressable
                onPress={handleClearKey}
                accessibilityRole="button"
                accessibilityLabel="Remover chave OpenAI"
                accessibilityHint="Apaga a chave OpenAI salva no dispositivo"
              >
                <XStack
                  bg={c.accentRed}
                  p="$3"
                  borderRadius="$3"
                  alignItems="center"
                  justifyContent="center"
                >
                  <Trash2 size={18} color={c.textOnAccent} />
                </XStack>
              </Pressable>
            ) : null}
          </XStack>
        </YStack>

        {/* OpenRouter API Key */}
        <YStack gap="$3">
          <XStack alignItems="center" gap="$2">
            <Key size={20} color={c.textLabel} />
            <Text fontSize={16} fontWeight="700" color={c.text}>
              OpenRouter API Key
            </Text>
            {AVAILABLE_MODELS.find((m) => m.id === model)?.provider === 'openrouter' ? (
              <XStack px="$1.5" py={2} borderRadius={6} bg={c.bgYellowSoft}>
                <Text fontSize={9} fontWeight="700" color={c.accentOrange} letterSpacing={0.5}>
                  ATIVO
                </Text>
              </XStack>
            ) : null}
          </XStack>
          <Text color={c.textSecondary} fontSize={12}>
            Necessária para usar Grok 4.3, Kimi K2.6 e GPT-4o Mini TTS. Obtenha em{' '}
            <Text color={c.secondary} fontSize={12}>openrouter.ai/keys</Text>.
            Funciona independentemente da chave OpenAI — ambas podem estar configuradas ao mesmo tempo.
          </Text>
          <TextInput
            value={openrouterKey}
            onChangeText={setOpenrouterKey}
            placeholder="sk-or-..."
            placeholderTextColor={c.textPlaceholder}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            style={inputStyle}
          />
          <XStack gap="$2">
            <Pressable
              onPress={handleSaveOpenRouterKey}
              style={{ flex: 1 }}
              accessibilityRole="button"
              accessibilityLabel={openrouterSaved ? 'Chave OpenRouter salva' : 'Salvar chave OpenRouter'}
            >
              <XStack
                bg={c.primary}
                p="$3"
                borderRadius="$3"
                alignItems="center"
                justifyContent="center"
                gap="$2"
              >
                <Check size={18} color={c.textOnAccent} />
                <Text color={c.textOnAccent} fontWeight="700">
                  {openrouterSaved ? 'Salvo!' : 'Salvar'}
                </Text>
              </XStack>
            </Pressable>
            {openrouterKey.length > 0 ? (
              <Pressable
                onPress={handleClearOpenRouterKey}
                accessibilityRole="button"
                accessibilityLabel="Remover chave OpenRouter"
                accessibilityHint="Apaga a chave OpenRouter salva no dispositivo"
              >
                <XStack
                  bg={c.accentRed}
                  p="$3"
                  borderRadius="$3"
                  alignItems="center"
                  justifyContent="center"
                >
                  <Trash2 size={18} color={c.textOnAccent} />
                </XStack>
              </Pressable>
            ) : null}
          </XStack>
        </YStack>

        {/* SEÇÃO: EVOPAD */}
        <SectionHeader label="EvoPad" />

        {/* EvoPad — Integração local */}
        <YStack bg={c.bgCard} p="$3" borderRadius="$3" gap="$3">
          <XStack alignItems="center" gap="$2">
            <Link2 size={20} color={c.primary} />
            <Text fontWeight="700" fontSize={14} color={c.text}>
              Integração EvoPad
            </Text>
          </XStack>

          <Text fontSize={12} color={c.textSecondary} lineHeight={18}>
            Conecta o VoiceAI diretamente ao EvoPad rodando no seu computador.
            Configure a URL e o token de importação definido no .env do EvoPad.
          </Text>

          {/* URL */}
          <YStack gap="$1">
            <Text fontSize={12} fontWeight="600" color={c.textLabel}>
              URL do EvoPad (local ou rede)
            </Text>
            <TextInput
              value={evoPadConfig.baseUrl}
              onChangeText={(v) =>
                setEvoPadConfigState((prev) => ({ ...prev, baseUrl: v }))
              }
              placeholder="http://127.0.0.1:4173"
              placeholderTextColor={c.textPlaceholder}
              autoCapitalize="none"
              autoCorrect={false}
              style={[
                inputStyle,
                validateEvoPadUrl(evoPadConfig.baseUrl) && evoPadConfig.baseUrl.trim()
                  ? { borderColor: c.accentRed }
                  : {},
              ]}
              accessibilityLabel="URL do EvoPad"
              accessibilityHint="URL base do servidor EvoPad, ex: http://127.0.0.1:4173"
            />
            {/* Inline HTTPS enforcement warning */}
            {evoPadConfig.baseUrl.trim() &&
              !isLocalUrl(evoPadConfig.baseUrl) &&
              evoPadConfig.baseUrl.startsWith('http://') && (
              <XStack
                bg="rgba(192,57,43,0.08)"
                borderWidth={1}
                borderColor={c.accentRed}
                borderRadius="$2"
                px="$2"
                py="$1"
                gap="$1"
                alignItems="flex-start"
              >
                <Text fontSize={10} color={c.accentRed} fontWeight="700">⚠️</Text>
                <Text fontSize={11} color={c.accentRed} flex={1} lineHeight={15}>
                  URLs externas devem usar HTTPS para proteger dados em trânsito.
                </Text>
              </XStack>
            )}
            {evoPadConfig.baseUrl.trim() && validateEvoPadUrl(evoPadConfig.baseUrl) && (
              <Text fontSize={11} color={c.accentRed}>
                {validateEvoPadUrl(evoPadConfig.baseUrl)}
              </Text>
            )}
          </YStack>

          {/* Token */}
          <YStack gap="$1">
            <Text fontSize={12} fontWeight="600" color={c.textLabel}>
              Token de importação (IMPORT_TOKEN)
            </Text>
            <TextInput
              value={evoPadConfig.importToken}
              onChangeText={(v) =>
                setEvoPadConfigState((prev) => ({ ...prev, importToken: v }))
              }
              placeholder="Cole aqui o valor de IMPORT_TOKEN do .env do EvoPad"
              placeholderTextColor={c.textPlaceholder}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              style={[
                inputStyle,
                validateEvoPadToken(evoPadConfig.importToken) &&
                evoPadConfig.importToken.trim()
                  ? { borderColor: c.accentOrange }
                  : {},
              ]}
              accessibilityLabel="Token de importação EvoPad"
              accessibilityHint="Valor de IMPORT_TOKEN do arquivo .env do EvoPad"
            />
            {evoPadConfig.importToken.trim() &&
              validateEvoPadToken(evoPadConfig.importToken) && (
              <Text fontSize={11} color={c.accentOrange}>
                {validateEvoPadToken(evoPadConfig.importToken)}
              </Text>
            )}
          </YStack>

          <XStack gap="$2">
            {/* Testar conexão */}
            <Pressable
              onPress={handleTestEvoPad}
              disabled={evoPadTestStatus === 'testing'}
              style={{ flex: 1 }}
              accessibilityRole="button"
              accessibilityLabel={
                evoPadTestStatus === 'ok'
                  ? 'EvoPad conectado'
                  : evoPadTestStatus === 'fail'
                  ? 'Sem conexão com EvoPad — testar novamente'
                  : 'Testar conexão com EvoPad'
              }
              accessibilityState={{ busy: evoPadTestStatus === 'testing', disabled: evoPadTestStatus === 'testing' }}
            >
              <XStack
                bg={
                  evoPadTestStatus === 'ok'
                    ? 'rgba(22,163,74,0.12)'
                    : evoPadTestStatus === 'fail'
                    ? 'rgba(192,57,43,0.10)'
                    : c.bgSubtle
                }
                borderWidth={1}
                borderColor={
                  evoPadTestStatus === 'ok'
                    ? c.primary
                    : evoPadTestStatus === 'fail'
                    ? c.accentRed
                    : c.border
                }
                borderRadius="$3"
                px="$3"
                py="$2"
                alignItems="center"
                justifyContent="center"
                gap="$2"
              >
                {evoPadTestStatus === 'testing' ? (
                  <RefreshCw size={14} color={c.textSecondary} />
                ) : evoPadTestStatus === 'ok' ? (
                  <Wifi size={14} color={c.primary} />
                ) : evoPadTestStatus === 'fail' ? (
                  <WifiOff size={14} color={c.accentRed} />
                ) : (
                  <Wifi size={14} color={c.textSecondary} />
                )}
                <Text
                  fontSize={12}
                  fontWeight="700"
                  color={
                    evoPadTestStatus === 'ok'
                      ? c.primary
                      : evoPadTestStatus === 'fail'
                      ? c.accentRed
                      : c.textSecondary
                  }
                >
                  {evoPadTestStatus === 'testing'
                    ? 'Testando…'
                    : evoPadTestStatus === 'ok'
                    ? 'Conectado ✓'
                    : evoPadTestStatus === 'fail'
                    ? 'Sem conexão'
                    : 'Testar conexão'}
                </Text>
              </XStack>
            </Pressable>

            {/* Salvar */}
            <Pressable
              onPress={handleSaveEvoPad}
              style={{ flex: 1 }}
              accessibilityRole="button"
              accessibilityLabel={evoPadSaved ? 'Configuração EvoPad salva' : 'Salvar configuração EvoPad'}
            >
              <XStack
                bg={evoPadSaved ? 'rgba(22,163,74,0.12)' : c.primary}
                borderRadius="$3"
                px="$3"
                py="$2"
                alignItems="center"
                justifyContent="center"
                gap="$2"
              >
                <Check size={14} color={evoPadSaved ? c.primary : c.textOnAccent} />
                <Text fontSize={12} fontWeight="700" color={evoPadSaved ? c.primary : c.textOnAccent}>
                  {evoPadSaved ? 'Salvo!' : 'Salvar'}
                </Text>
              </XStack>
            </Pressable>
          </XStack>

          <Text fontSize={11} color={c.textMuted} lineHeight={16}>
            Token gerado automaticamente no .env do EvoPad. Procure a linha IMPORT_TOKEN
            e cole aqui. A URL padrão funciona se o EvoPad roda no mesmo Mac.
          </Text>
        </YStack>

        {/* SEÇÃO: ASSINATURA DIGITAL */}
        <SectionHeader label="Assinatura Digital" />

        <YStack bg={c.bgCard} borderRadius="$3" p="$3" gap="$3">
          {/* Cabeçalho Bird ID */}
          <XStack alignItems="center" gap="$2" mb="$1">
            <PenLine size={18} color={c.primary} />
            <YStack f={1}>
              <Text fontWeight="700" fontSize={14} color={c.text}>
                Bird ID — ICP-Brasil
              </Text>
              <Text fontSize={11} color={c.textSecondary}>
                signature_session OAuth
              </Text>
            </YStack>
          </XStack>

          {/* Badge de sessão válida */}
          {birdIdUserInfo && !birdIdExpired && (
            <XStack
              bg="rgba(22,163,74,0.10)"
              borderWidth={1}
              borderColor="rgba(22,163,74,0.30)"
              borderRadius={8}
              p="$2"
              alignItems="center"
              gap="$2"
            >
              <BadgeCheck size={16} color="#16a34a" />
              <YStack f={1}>
                <Text fontWeight="700" fontSize={13} color="#16a34a">
                  {birdIdUserInfo.name || 'Titular verificado'}
                </Text>
                <XStack gap="$2" flexWrap="wrap">
                  {birdIdUserInfo.cpf ? (
                    <Text fontSize={11} color={c.textSecondary}>
                      CPF: {birdIdUserInfo.cpf}
                    </Text>
                  ) : null}
                  {birdIdUserInfo.expiresAt ? (
                    <Text fontSize={11} color={c.textSecondary}>
                      · válida até {formatSessionExpiry(birdIdUserInfo.expiresAt)}
                    </Text>
                  ) : null}
                </XStack>
              </YStack>
            </XStack>
          )}

          {/* Badge de sessão expirada */}
          {birdIdUserInfo && birdIdExpired && (
            <XStack
              bg="rgba(220,38,38,0.08)"
              borderWidth={1}
              borderColor="rgba(220,38,38,0.30)"
              borderRadius={8}
              p="$2"
              alignItems="center"
              gap="$2"
            >
              <XIcon size={16} color="#dc2626" />
              <YStack f={1}>
                <Text fontWeight="700" fontSize={13} color="#dc2626">
                  Sessão expirada
                </Text>
                <Text fontSize={11} color={c.textSecondary}>
                  Gere uma nova signature_session no portal Bird ID.
                </Text>
              </YStack>
            </XStack>
          )}

          {/* Campo da signature_session */}
          <XStack
            alignItems="center"
            borderWidth={1}
            borderColor={birdIdExpired ? 'rgba(220,38,38,0.50)' : c.borderInput}
            borderRadius={8}
            backgroundColor={c.bgInput}
            px="$3"
            gap="$2"
          >
            <TextInput
              style={{ flex: 1, paddingVertical: 12, fontSize: 13, color: c.text, fontFamily: 'monospace' }}
              placeholder="Cole a signature_session aqui..."
              placeholderTextColor={c.textPlaceholder}
              value={showBirdIdToken ? birdIdToken : birdIdToken ? '••••••••••••••••' : ''}
              onChangeText={(t) => {
                setBirdIdTokenState(t);
                setBirdIdUserInfo(null);
                setBirdIdExpired(false);
              }}
              onFocus={() => setShowBirdIdToken(true)}
              onBlur={() => setShowBirdIdToken(false)}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={false}
            />
            <Pressable
              onPress={() => setShowBirdIdToken((v) => !v)}
              accessibilityLabel={showBirdIdToken ? 'Ocultar sessão' : 'Mostrar sessão'}
              hitSlop={8}
            >
              {showBirdIdToken ? (
                <EyeOff size={18} color={c.textPlaceholder} />
              ) : (
                <Eye size={18} color={c.textPlaceholder} />
              )}
            </Pressable>
            {birdIdToken.trim().length > 0 && (
              <Pressable onPress={handleClearBirdIdToken} hitSlop={8} accessibilityLabel="Remover sessão">
                <XIcon size={16} color={c.textPlaceholder} />
              </Pressable>
            )}
          </XStack>

          {/* Botões: Verificar + Salvar */}
          <XStack gap="$2">
            <Pressable
              onPress={handleValidateBirdIdToken}
              disabled={birdIdValidating || !birdIdToken.trim()}
              style={{ flex: 1 }}
              accessibilityLabel="Verificar signature_session Bird ID"
            >
              <XStack
                borderWidth={1}
                borderColor={c.primary}
                borderRadius={8}
                p="$2"
                alignItems="center"
                justifyContent="center"
                gap="$1"
                opacity={birdIdValidating || !birdIdToken.trim() ? 0.5 : 1}
              >
                {birdIdValidating ? (
                  <Text fontSize={12} fontWeight="700" color={c.primary}>
                    Verificando...
                  </Text>
                ) : (
                  <>
                    <BadgeCheck size={14} color={c.primary} />
                    <Text fontSize={12} fontWeight="700" color={c.primary}>
                      Verificar
                    </Text>
                  </>
                )}
              </XStack>
            </Pressable>

            <Pressable
              onPress={handleSaveBirdIdToken}
              disabled={!birdIdToken.trim()}
              style={{ flex: 1 }}
              accessibilityLabel="Salvar signature_session Bird ID"
            >
              <XStack
                bg={birdIdSaved ? 'rgba(22,163,74,0.12)' : c.primary}
                borderRadius={8}
                p="$2"
                alignItems="center"
                justifyContent="center"
                gap="$1"
                opacity={!birdIdToken.trim() ? 0.5 : 1}
              >
                <Check size={14} color={birdIdSaved ? '#16a34a' : c.textOnAccent} />
                <Text
                  fontSize={12}
                  fontWeight="700"
                  color={birdIdSaved ? '#16a34a' : c.textOnAccent}
                >
                  {birdIdSaved ? 'Salvo!' : 'Salvar'}
                </Text>
              </XStack>
            </Pressable>
          </XStack>

          <Text fontSize={11} color={c.textMuted} lineHeight={16}>
            A signature_session é um token OAuth emitido pelo Bird ID que
            permite múltiplas assinaturas ICP-Brasil enquanto estiver dentro
            do prazo de validade ou não for revogada. Obtida no portal
            birdid.com.br com o escopo "sign". Armazenada com segurança no
            Keychain / SecureStore do dispositivo.
          </Text>
        </YStack>

        {/* SEÇÃO: FERRAMENTAS */}
        <SectionHeader label="Ferramentas" />

        {/* Links */}
        <Link href="/stats" asChild>
          <Pressable accessibilityRole="link" accessibilityLabel="Estatísticas — ver dashboard com gráficos e métricas">
            <XStack
              bg={c.bgCard}
              p="$3"
              borderRadius="$3"
              alignItems="center"
              gap="$3"
            >
              <BarChart3 size={20} color={c.accentOrange} />
              <YStack f={1}>
                <Text fontWeight="700" fontSize={14} color={c.text}>
                  Estatísticas
                </Text>
                <Text fontSize={12} color={c.textSecondary}>
                  Dashboard com gráficos e métricas
                </Text>
              </YStack>
              <ChevronRight size={20} color={c.textPlaceholder} />
            </XStack>
          </Pressable>
        </Link>

        <Link href="/templates" asChild>
          <Pressable accessibilityRole="link" accessibilityLabel="Templates de IA — criar e editar prompts customizados">
            <XStack
              bg={c.bgCard}
              p="$3"
              borderRadius="$3"
              alignItems="center"
              gap="$3"
            >
              <Sparkles size={20} color={c.secondary} />
              <YStack f={1}>
                <Text fontWeight="700" fontSize={14} color={c.text}>
                  Templates de IA
                </Text>
                <Text fontSize={12} color={c.textSecondary}>
                  Crie e edite prompts customizados
                </Text>
              </YStack>
              <ChevronRight size={20} color={c.textPlaceholder} />
            </XStack>
          </Pressable>
        </Link>

        {/* Tutorial */}
        <Pressable
          onPress={async () => {
            await AsyncStorage.removeItem(ONBOARDING_SEEN_KEY);
            setShowOnboarding(true);
          }}
          accessibilityRole="button"
          accessibilityLabel="Ver tutorial — rever o guia de introdução ao app"
        >
          <XStack
            bg={c.bgCard}
            p="$3"
            borderRadius="$3"
            alignItems="center"
            gap="$3"
          >
            <HelpCircle size={20} color={c.primary} />
            <YStack f={1}>
              <Text fontWeight="700" fontSize={14} color={c.text}>
                Ver tutorial
              </Text>
              <Text fontSize={12} color={c.textSecondary}>
                Rever o guia de introdução ao app
              </Text>
            </YStack>
            <ChevronRight size={20} color={c.textPlaceholder} />
          </XStack>
        </Pressable>

        {/* SEÇÃO: PRIVACIDADE */}
        <SectionHeader label="Privacidade" />

        {/* LGPD — Privacidade */}
        <YStack
          bg={c.bgCard}
          borderRadius="$4"
          borderWidth={1}
          borderColor={c.border}
          overflow="hidden"
          mb="$6"
        >
          <XStack px="$4" pt="$3" pb="$2" gap="$2" alignItems="center">
            <Lock size={16} color={c.primary} />
            <Text fontSize={13} fontWeight="700" color={c.textSecondary} textTransform="uppercase">
              Privacidade &amp; LGPD
            </Text>
          </XStack>

          <YStack px="$4" pb="$4" gap="$3">
            {/* Status de consentimento */}
            <XStack
              bg={lgpdAccepted ? 'rgba(22,163,74,0.1)' : 'rgba(239,68,68,0.1)'}
              borderRadius="$3"
              px="$3"
              py="$2"
              alignItems="center"
              gap="$2"
            >
              <FileText size={14} color={lgpdAccepted ? c.primary : c.accentRed} />
              <YStack flex={1}>
                <Text fontSize={12} fontWeight="600" color={lgpdAccepted ? c.primary : c.accentRed}>
                  {lgpdAccepted ? 'Consentimento LGPD ativo' : 'Consentimento pendente'}
                </Text>
                {lgpdAccepted && lgpdAcceptedAt && (
                  <Text fontSize={11} color={c.textSecondary}>
                    Aceito em{' '}
                    {new Date(lgpdAcceptedAt).toLocaleDateString('pt-BR', {
                      day: '2-digit',
                      month: 'long',
                      year: 'numeric',
                    })}
                  </Text>
                )}
              </YStack>
            </XStack>

            <Text fontSize={12} color={c.textSecondary} lineHeight={18}>
              Seus dados são processados conforme a Lei Geral de Proteção de Dados
              (LGPD — Lei nº 13.709/2018). Você pode revogar o consentimento a qualquer momento.
            </Text>

            {lgpdAccepted && (
              <Pressable
                onPress={() => {
                  Alert.alert(
                    'Revogar consentimento LGPD?',
                    'O aplicativo encerrará a sessão e não processará novos dados até que o consentimento seja concedido novamente.',
                    [
                      { text: 'Cancelar', style: 'cancel' },
                      {
                        text: 'Revogar',
                        style: 'destructive',
                        onPress: async () => {
                          await revokeLGPD();
                        },
                      },
                    ]
                  );
                }}
                accessibilityRole="button"
                accessibilityLabel="Revogar consentimento LGPD"
                accessibilityHint="Encerra o processamento de dados e a sessão no aplicativo"
              >
                <XStack
                  borderWidth={1}
                  borderColor={c.accentRed}
                  borderRadius="$3"
                  px="$3"
                  py="$2"
                  alignItems="center"
                  justifyContent="center"
                  gap="$2"
                >
                  <Trash2 size={14} color={c.accentRed} />
                  <Text fontSize={13} color={c.accentRed} fontWeight="600">
                    Revogar consentimento
                  </Text>
                </XStack>
              </Pressable>
            )}
          </YStack>
        </YStack>

      </ScrollView>

      <OnboardingModal
        visible={showOnboarding}
        onDismiss={() => setShowOnboarding(false)}
      />

      <BottomTabBar />
    </View>
  );
}
