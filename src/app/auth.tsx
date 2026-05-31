import { useState } from 'react';
import {
  TextInput,
  Pressable,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { YStack, XStack, Text } from 'tamagui';
import {
  ArrowLeft,
  Cloud,
  LogIn,
  UserPlus,
  KeyRound,
  Send,
  Check,
} from 'lucide-react-native';
import { Link, useRouter } from 'expo-router';
import { signIn, signUp, sendOtpCode, verifyOtpCode } from '../services/auth';
import { pullOnLogin } from '../services/sync';
import { isCloudConfigured } from '../services/supabase';
import { useColors } from '../context/ThemeContext';
import { validatePassword, PASSWORD_REQUIREMENTS_HINT } from '../utils/password';

type Mode = 'signin' | 'signup' | 'otp_send' | 'otp_verify';

const TITLE: Record<Mode, string> = {
  signin: 'Entrar',
  signup: 'Criar conta',
  otp_send: 'Recuperar acesso',
  otp_verify: 'Digite o código',
};

export default function AuthScreen() {
  const c = useColors();
  const inputStyle = {
    borderWidth: 1,
    borderColor: c.borderInput,
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
    backgroundColor: c.bgInput,
    color: c.text,
  } as const;
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async () => {
    if (!isCloudConfigured()) {
      Alert.alert(
        'Cloud não configurado',
        'Defina EXPO_PUBLIC_SUPABASE_URL e EXPO_PUBLIC_SUPABASE_ANON_KEY no .env e reinicie o Metro com --clear.'
      );
      return;
    }

    if (mode === 'otp_send') {
      const e = email.trim();
      if (!e) {
        Alert.alert('Erro', 'Digite seu email.');
        return;
      }
      setLoading(true);
      try {
        await sendOtpCode(e);
        Alert.alert(
          'Código enviado',
          `Enviamos um código de 6 dígitos para ${e}. Verifique seu email (e a pasta de spam).`
        );
        setMode('otp_verify');
      } catch (err: any) {
        Alert.alert('Erro', err?.message ?? String(err));
      } finally {
        setLoading(false);
      }
      return;
    }

    if (mode === 'otp_verify') {
      const code = otpCode.trim();
      if (code.length < 4) {
        Alert.alert('Erro', 'Código muito curto. Verifique o email.');
        return;
      }
      setLoading(true);
      try {
        await verifyOtpCode(email, code);
        await pullOnLogin();
        Alert.alert(
          'Bem-vindo de volta!',
          'Você está logado. Lembre de alterar sua senha em Configurações.',
          [{ text: 'OK', onPress: () => router.replace('/settings') }]
        );
      } catch (err: any) {
        Alert.alert(
          'Código inválido',
          err?.message ?? 'Verifique o código e tente novamente.'
        );
      } finally {
        setLoading(false);
      }
      return;
    }

    // signin / signup
    const e = email.trim();
    const p = password;
    if (!e || !p) {
      Alert.alert('Erro', 'Preencha email e senha.');
      return;
    }
    if (mode === 'signup') {
      const check = validatePassword(p);
      if (!check.valid) {
        Alert.alert('Senha fraca', check.error!);
        return;
      }
    } else if (p.length < 6) {
      // signin: keep lax check (existing accounts may have weaker passwords)
      Alert.alert('Erro', 'Senha incorreta.');
      return;
    }

    setLoading(true);
    try {
      if (mode === 'signup') {
        await signUp(e, p);
        Alert.alert('Conta criada', 'Sua conta foi criada com sucesso!');
      } else {
        await signIn(e, p);
      }
      await pullOnLogin();
      router.replace('/settings');
    } catch (err: any) {
      Alert.alert(
        mode === 'signup' ? 'Erro ao criar conta' : 'Erro ao entrar',
        err?.message ?? String(err)
      );
    } finally {
      setLoading(false);
    }
  };

  const renderButton = () => {
    const labels: Record<Mode, { icon: any; text: string }> = {
      signin: { icon: <LogIn size={20} color={c.textOnAccent} />, text: 'Entrar' },
      signup: { icon: <UserPlus size={20} color={c.textOnAccent} />, text: 'Criar conta' },
      otp_send: { icon: <Send size={20} color={c.textOnAccent} />, text: 'Enviar código' },
      otp_verify: { icon: <Check size={20} color={c.textOnAccent} />, text: 'Verificar e entrar' },
    };
    const cur = labels[mode];
    return (
      <Pressable
        onPress={handleSubmit}
        disabled={loading}
        accessibilityRole="button"
        accessibilityLabel={loading ? 'Aguarde…' : cur.text}
        accessibilityState={{ disabled: loading, busy: loading }}
      >
        <XStack
          bg={loading ? c.textPlaceholder : c.primary}
          p="$3"
          borderRadius="$3"
          alignItems="center"
          justifyContent="center"
          gap="$2"
          mt="$2"
        >
          {loading ? <ActivityIndicator color={c.textOnAccent} /> : cur.icon}
          {!loading && (
            <Text color={c.textOnAccent} fontWeight="700" fontSize={15}>
              {cur.text}
            </Text>
          )}
        </XStack>
      </Pressable>
    );
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <YStack f={1} bg={c.bgScreen} p="$4" gap="$3">
        <XStack alignItems="center" gap="$3" mt="$6">
          <Link href="/settings" asChild>
            <Pressable accessibilityRole="button" accessibilityLabel="Voltar para Configurações">
              <ArrowLeft size={28} color={c.primary} />
            </Pressable>
          </Link>
          <Text fontSize={24} fontWeight="800" color={c.primary}>
            {TITLE[mode]}
          </Text>
        </XStack>

        <YStack gap="$3" mt="$4">
          <XStack alignItems="center" gap="$2">
            {mode === 'otp_send' || mode === 'otp_verify' ? (
              <KeyRound size={20} color={c.accentBlue} />
            ) : (
              <Cloud size={20} color={c.accentBlue} />
            )}
            <Text fontSize={14} color={c.textLabel} f={1}>
              {mode === 'otp_send'
                ? 'Digite seu email para receber um código de 6 dígitos.'
                : mode === 'otp_verify'
                ? `Enviamos um código para ${email}. Cole-o abaixo.`
                : 'Sincronize gravações entre dispositivos com backup automático.'}
            </Text>
          </XStack>

          {/* Email — exibido em signin, signup, otp_send */}
          {mode !== 'otp_verify' && (
            <YStack gap="$2">
              <Text fontWeight="700" fontSize={12} color={c.textLabel}>Email</Text>
              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder="seu@email.com"
                placeholderTextColor={c.textPlaceholder}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                style={inputStyle}
                editable={!loading}
                accessibilityLabel="Email"
                accessibilityHint="Digite seu endereço de email"
              />
            </YStack>
          )}

          {/* Senha — só em signin e signup */}
          {(mode === 'signin' || mode === 'signup') && (
            <YStack gap="$2">
              <Text fontWeight="700" fontSize={12} color={c.textLabel}>Senha</Text>
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder={mode === 'signup' ? PASSWORD_REQUIREMENTS_HINT : 'Sua senha'}
                placeholderTextColor={c.textPlaceholder}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                style={inputStyle}
                editable={!loading}
                accessibilityLabel="Senha"
                accessibilityHint={mode === 'signup' ? 'Crie uma senha forte' : 'Digite sua senha'}
              />
            </YStack>
          )}

          {/* Código OTP — só em otp_verify */}
          {mode === 'otp_verify' && (
            <YStack gap="$2">
              <Text fontWeight="700" fontSize={12} color={c.textLabel}>
                Código de 6 dígitos
              </Text>
              <TextInput
                value={otpCode}
                onChangeText={(v) => setOtpCode(v.replace(/[^0-9]/g, '').slice(0, 8))}
                placeholder="000000"
                placeholderTextColor={c.textPlaceholder}
                keyboardType="number-pad"
                style={[inputStyle, { fontSize: 22, letterSpacing: 6, textAlign: 'center' }]}
                editable={!loading}
                maxLength={8}
                accessibilityLabel="Código de verificação"
                accessibilityHint="Digite o código de 6 dígitos enviado ao seu email"
              />
            </YStack>
          )}

          {renderButton()}

          {/* Links de navegação */}
          {mode === 'signin' && (
            <>
              <Pressable
                onPress={() => setMode('otp_send')}
                disabled={loading}
                accessibilityRole="button"
                accessibilityLabel="Esqueci minha senha"
                accessibilityHint="Recuperar acesso via código por email"
              >
                <Text color={c.accentBlue} fontSize={13} textAlign="center" mt="$1">
                  Esqueci minha senha
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setMode('signup')}
                disabled={loading}
                accessibilityRole="button"
                accessibilityLabel="Criar nova conta"
              >
                <Text color={c.accentBlue} fontSize={13} textAlign="center" mt="$2">
                  Não tem conta? Crie uma agora
                </Text>
              </Pressable>
            </>
          )}

          {mode === 'signup' && (
            <Pressable
              onPress={() => setMode('signin')}
              disabled={loading}
              accessibilityRole="button"
              accessibilityLabel="Já tenho conta — fazer login"
            >
              <Text color={c.accentBlue} fontSize={13} textAlign="center" mt="$2">
                Já tem conta? Faça login
              </Text>
            </Pressable>
          )}

          {(mode === 'otp_send' || mode === 'otp_verify') && (
            <Pressable
              onPress={() => {
                setMode('signin');
                setOtpCode('');
              }}
              disabled={loading}
              accessibilityRole="button"
              accessibilityLabel="Voltar para o login"
            >
              <Text color={c.accentBlue} fontSize={13} textAlign="center" mt="$2">
                Voltar para o login
              </Text>
            </Pressable>
          )}
        </YStack>
      </YStack>
    </KeyboardAvoidingView>
  );
}
