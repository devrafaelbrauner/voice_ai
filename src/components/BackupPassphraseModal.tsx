import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
} from 'react-native';
import { YStack, XStack, Text } from 'tamagui';
import { Eye, EyeOff, Lock } from 'lucide-react-native';
import { useColors } from '../context/ThemeContext';
import { validatePassphrase } from '../services/backup';

interface Props {
  visible: boolean;
  /** create: define a senha de um novo backup (com confirmação). enter: informa a senha para restaurar. */
  mode: 'create' | 'enter';
  /** Nome do arquivo escolhido (modo enter). */
  fileName?: string;
  /**
   * Executa a operação. Se lançar, a mensagem do erro aparece no modal e ele continua
   * aberto para nova tentativa. Em caso de sucesso quem chamou fecha o modal (visible=false).
   */
  onSubmit: (passphrase: string) => Promise<void>;
  onClose: () => void;
}

const TIME_HINT = 'Isso pode levar de cerca de 30 segundos a alguns minutos… Mantenha o aplicativo aberto.';

export function BackupPassphraseModal({ visible, mode, fileName, onSubmit, onClose }: Props) {
  const c = useColors();
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Nunca mantém a senha em memória de estado depois que o modal fecha.
  useEffect(() => {
    if (!visible) {
      setPassphrase('');
      setConfirm('');
      setShow(false);
      setError(null);
    }
  }, [visible]);

  const creating = mode === 'create';
  const phase = creating ? 'Criptografando e gerando o backup' : 'Descriptografando e restaurando o backup';

  const submit = async () => {
    if (busy) return;
    let problem: string | null = null;
    if (creating) {
      problem = validatePassphrase(passphrase) ?? (passphrase !== confirm ? 'As senhas não conferem.' : null);
    } else if (passphrase.length === 0) {
      problem = 'Informe a senha do backup.';
    }
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setBusy(true);
    AccessibilityInfo.announceForAccessibility(`${phase}.`);
    try {
      // Deixa o estado "ocupado" pintar antes do trabalho pesado de JS.
      await new Promise<void>((r) => setTimeout(r, 60));
      await onSubmit(passphrase);
    } catch (err: any) {
      if (mounted.current) setError(err?.message ?? String(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const inputStyle = {
    borderWidth: 1,
    borderColor: c.borderInput,
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    backgroundColor: c.bgInput,
    color: c.text,
  } as const;

  const canSubmit = !busy && passphrase.length > 0 && (!creating || confirm.length > 0);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      accessibilityViewIsModal
      // Durante o processamento o modal não fecha (voltar do Android incluído).
      onRequestClose={() => {
        if (!busy) onClose();
      }}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <YStack
          flex={1}
          style={{ backgroundColor: 'rgba(0,0,0,0.7)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 }}
        >
          <YStack
            style={{ backgroundColor: c.bgCard, borderRadius: 16, width: '100%', maxHeight: '90%', overflow: 'hidden' }}
          >
            <ScrollView keyboardShouldPersistTaps="handled" bounces={false}>
              <YStack style={{ padding: 20, gap: 14 }}>
                <XStack style={{ alignItems: 'center', gap: 8 }}>
                  <Lock size={20} color={c.accentBlue} />
                  <Text
                    accessibilityRole="header"
                    style={{ fontSize: 16, fontWeight: '700', color: c.text, flex: 1 }}
                  >
                    {creating ? 'Proteger backup com senha' : 'Restaurar backup'}
                  </Text>
                </XStack>

                {creating ? (
                  <Text style={{ fontSize: 13, color: c.textSecondary, lineHeight: 19 }}>
                    O backup é cifrado com uma senha que só você conhece. Sem ela o arquivo não pode ser
                    aberto — nem por nós. Guarde-a em local seguro: não há como recuperá-la.
                  </Text>
                ) : (
                  <Text style={{ fontSize: 13, color: c.textSecondary, lineHeight: 19 }}>
                    {fileName ? `Arquivo: ${fileName}. ` : ''}
                    Informe a senha definida ao criar este backup. Itens que já existem no aparelho não são
                    sobrescritos.
                  </Text>
                )}

                <YStack style={{ gap: 6 }}>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: c.textLabel }}>
                    {creating ? 'Senha do backup' : 'Senha'}
                  </Text>
                  <XStack style={{ alignItems: 'center', gap: 8 }}>
                    <TextInput
                      value={passphrase}
                      onChangeText={(v) => {
                        setPassphrase(v);
                        if (error) setError(null);
                      }}
                      secureTextEntry={!show}
                      editable={!busy}
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="off"
                      importantForAutofill="no"
                      textContentType="none"
                      returnKeyType={creating ? 'next' : 'done'}
                      onSubmitEditing={creating ? undefined : submit}
                      placeholder={creating ? 'Mínimo de 12 caracteres' : 'Senha do backup'}
                      placeholderTextColor={c.textPlaceholder}
                      accessibilityLabel={creating ? 'Senha do backup' : 'Senha para restaurar o backup'}
                      accessibilityHint={creating ? 'Use pelo menos 12 caracteres' : undefined}
                      style={{ ...inputStyle, flex: 1 }}
                    />
                    <Pressable
                      onPress={() => setShow((s) => !s)}
                      disabled={busy}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={show ? 'Ocultar senha' : 'Mostrar senha'}
                    >
                      {show ? <EyeOff size={20} color={c.textSecondary} /> : <Eye size={20} color={c.textSecondary} />}
                    </Pressable>
                  </XStack>
                </YStack>

                {creating && (
                  <YStack style={{ gap: 6 }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: c.textLabel }}>Confirmar senha</Text>
                    <TextInput
                      value={confirm}
                      onChangeText={(v) => {
                        setConfirm(v);
                        if (error) setError(null);
                      }}
                      secureTextEntry={!show}
                      editable={!busy}
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="off"
                      importantForAutofill="no"
                      textContentType="none"
                      returnKeyType="done"
                      onSubmitEditing={submit}
                      placeholder="Digite a senha novamente"
                      placeholderTextColor={c.textPlaceholder}
                      accessibilityLabel="Confirmar senha do backup"
                      style={inputStyle}
                    />
                  </YStack>
                )}

                {error && (
                  <YStack
                    accessibilityRole="alert"
                    accessibilityLiveRegion="assertive"
                    style={{ backgroundColor: c.bgRedSoft, borderRadius: 8, padding: 10 }}
                  >
                    <Text style={{ fontSize: 13, color: c.accentRed, lineHeight: 18 }}>{error}</Text>
                  </YStack>
                )}

                {busy && (
                  <XStack style={{ gap: 10, alignItems: 'flex-start' }}>
                    <ActivityIndicator color={c.accentBlue} />
                    {/* O leitor de tela recebe só a fase; o aviso de tempo é visual. */}
                    <Text
                      accessibilityLiveRegion="polite"
                      accessibilityLabel={`${phase}.`}
                      style={{ fontSize: 13, color: c.textSecondary, lineHeight: 19, flex: 1 }}
                    >
                      {`${phase}. ${TIME_HINT}`}
                    </Text>
                  </XStack>
                )}

                <XStack style={{ gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
                  <Pressable
                    onPress={onClose}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel="Cancelar"
                    accessibilityState={{ disabled: busy }}
                    style={{ paddingVertical: 12, paddingHorizontal: 16, opacity: busy ? 0.4 : 1 }}
                  >
                    <Text style={{ fontSize: 14, fontWeight: '600', color: c.textSecondary }}>Cancelar</Text>
                  </Pressable>
                  <Pressable
                    onPress={submit}
                    disabled={!canSubmit}
                    accessibilityRole="button"
                    accessibilityLabel={creating ? 'Gerar backup cifrado' : 'Restaurar backup'}
                    accessibilityState={{ disabled: !canSubmit, busy }}
                    style={{
                      backgroundColor: canSubmit ? c.accentBlue : c.bgSubtle,
                      borderRadius: 8,
                      paddingVertical: 12,
                      paddingHorizontal: 18,
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 14,
                        fontWeight: '700',
                        color: canSubmit ? c.textOnAccent : c.textSecondary,
                      }}
                    >
                      {creating ? 'Gerar backup' : 'Restaurar'}
                    </Text>
                  </Pressable>
                </XStack>
              </YStack>
            </ScrollView>
          </YStack>
        </YStack>
      </KeyboardAvoidingView>
    </Modal>
  );
}
