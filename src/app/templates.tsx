import { useState, useCallback } from 'react';
import {
  ScrollView,
  Pressable,
  Alert,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  View,
} from 'react-native';
import { YStack, XStack, Text } from 'tamagui';
import {
  Plus,
  Pencil,
  Trash2,
  Check,
  X,
  Sparkles,
  BookOpen,
} from 'lucide-react-native';
import { useFocusEffect } from 'expo-router';
import { BottomTabBar } from '../components/BottomTabBar';
import {
  BUILTIN_TEMPLATES,
} from '../services/openai';
import {
  getCustomTemplates,
  createCustomTemplate,
  updateCustomTemplate,
  deleteCustomTemplate,
  CustomTemplate,
} from '../services/db';
import { useColors } from '../context/ThemeContext';

type Mode = 'list' | 'form';

export default function TemplatesScreen() {
  const c = useColors();
  const inputStyle = {
    borderWidth: 1,
    borderColor: c.borderInput,
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    backgroundColor: c.bgInput,
    color: c.text,
  };
  const [mode, setMode] = useState<Mode>('list');
  const [customTemplates, setCustomTemplates] = useState<CustomTemplate[]>([]);

  // Form state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');

  const loadCustom = async () => {
    const list = await getCustomTemplates();
    setCustomTemplates(list);
  };

  useFocusEffect(
    useCallback(() => {
      loadCustom();
    }, [])
  );

  const startNew = () => {
    setEditingId(null);
    setName('');
    setDescription('');
    setSystemPrompt('');
    setMode('form');
  };

  const startEdit = (t: CustomTemplate) => {
    setEditingId(t.id);
    setName(t.name);
    setDescription(t.description ?? '');
    setSystemPrompt(t.systemPrompt);
    setMode('form');
  };

  const cancelForm = () => {
    setMode('list');
    setEditingId(null);
  };

  const saveForm = async () => {
    const n = name.trim();
    const d = description.trim();
    const sp = systemPrompt.trim();

    if (!n) {
      Alert.alert('Erro', 'Dê um nome ao template.');
      return;
    }
    if (!sp) {
      Alert.alert('Erro', 'O prompt do sistema não pode estar vazio.');
      return;
    }

    try {
      if (editingId) {
        await updateCustomTemplate(editingId, n, d, sp);
      } else {
        await createCustomTemplate(n, d, sp);
      }
      await loadCustom();
      cancelForm();
    } catch (err: any) {
      Alert.alert('Erro ao salvar', err?.message ?? String(err));
    }
  };

  const confirmDelete = (t: CustomTemplate) => {
    Alert.alert(
      'Excluir template',
      `Deseja excluir o template "${t.name}"? Gravações que usaram esse template manterão a saída salva, mas não conseguirão reprocessar com ele.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Excluir',
          style: 'destructive',
          onPress: async () => {
            await deleteCustomTemplate(t.id);
            await loadCustom();
          },
        },
      ]
    );
  };

  if (mode === 'form') {
    return (
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <YStack f={1} bg={c.bgScreen} p="$4" gap="$3">
          <XStack alignItems="center" gap="$3" mt="$6">
            <Pressable
              onPress={cancelForm}
              accessibilityRole="button"
              accessibilityLabel="Cancelar e voltar para lista de templates"
            >
              <X size={28} color={c.accentRed} />
            </Pressable>
            <Text fontSize={22} fontWeight="800" color={c.primary} f={1}>
              {editingId ? 'Editar Template' : 'Novo Template'}
            </Text>
            <Pressable
              onPress={saveForm}
              accessibilityRole="button"
              accessibilityLabel={editingId ? 'Salvar alterações do template' : 'Criar novo template'}
            >
              <Check size={28} color={c.primary} />
            </Pressable>
          </XStack>

          <ScrollView
            style={{ flex: 1 }}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ gap: 16, paddingVertical: 12 }}
          >
            <YStack gap="$2">
              <Text fontWeight="700" fontSize={13} color={c.textLabel}>
                Nome
              </Text>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="Ex: Reuniões 1:1"
                placeholderTextColor={c.textPlaceholder}
                style={inputStyle}
                accessibilityLabel="Nome do template"
              />
            </YStack>

            <YStack gap="$2">
              <Text fontWeight="700" fontSize={13} color={c.textLabel}>
                Descrição (opcional)
              </Text>
              <TextInput
                value={description}
                onChangeText={setDescription}
                placeholder="O que esse template faz"
                placeholderTextColor={c.textPlaceholder}
                style={inputStyle}
                accessibilityLabel="Descrição do template (opcional)"
              />
            </YStack>

            <YStack gap="$2">
              <Text fontWeight="700" fontSize={13} color={c.textLabel}>
                Prompt do sistema
              </Text>
              <Text color={c.textSecondary} fontSize={12}>
                Instrução que o GPT-4o-mini receberá. Escreva como uma diretriz
                clara em português, com regras de formato se quiser.
              </Text>
              <TextInput
                value={systemPrompt}
                onChangeText={setSystemPrompt}
                placeholder="Ex: Resuma a transcrição em até 3 frases, focando em decisões tomadas..."
                placeholderTextColor={c.textPlaceholder}
                multiline
                textAlignVertical="top"
                maxLength={3000}
                style={[inputStyle, { minHeight: 220, paddingTop: 12 }]}
                accessibilityLabel="Prompt do sistema"
                accessibilityHint="Instrução que a IA receberá ao processar gravações com este template"
              />
              <Text color={c.textMuted} fontSize={11} textAlign="right">{systemPrompt.length}/3000 caracteres</Text>
            </YStack>

            <YStack
              bg={c.bgYellowSoft}
              p="$3"
              borderRadius="$3"
              borderWidth={1}
              borderColor={c.borderYellow}
              gap="$2"
            >
              <Text fontWeight="700" fontSize={12} color={c.accentYellow}>
                💡 Dica
              </Text>
              <Text fontSize={12} color={c.accentYellow} lineHeight={18}>
                Para formatos estruturados (markdown, JSON, etc.), peça
                explicitamente. Para mapas mentais Mermaid, foi necessário
                instruir &quot;retorne APENAS código válido, sem cercas markdown&quot;.
              </Text>
            </YStack>
          </ScrollView>
        </YStack>
      </KeyboardAvoidingView>
    );
  }

  // mode === 'list'
  return (
    <View style={{ flex: 1, backgroundColor: c.bgScreen }}>
      <YStack f={1} bg={c.bgScreen} p="$4" gap="$3">
        <XStack alignItems="center" gap="$3" mt="$6">
          <Text fontSize={24} fontWeight="800" color={c.primary} f={1}>
            Templates de IA
          </Text>
        </XStack>

        <Pressable
          onPress={startNew}
          accessibilityRole="button"
          accessibilityLabel="Criar novo template"
        >
          <XStack
            bg={c.primary}
            p="$3"
            borderRadius="$3"
            alignItems="center"
            justifyContent="center"
            gap="$2"
          >
            <Plus size={20} color={c.textOnAccent} />
            <Text color={c.textOnAccent} fontWeight="700">
              Novo template
            </Text>
          </XStack>
        </Pressable>

        <ScrollView contentContainerStyle={{ gap: 12, paddingVertical: 12, paddingBottom: 70 }}>
          {/* Seção: Custom */}
          {customTemplates.length > 0 && (
            <YStack gap="$2">
              <Text color={c.textSecondary} fontSize={11} fontWeight="700">
                SEUS TEMPLATES
              </Text>
              {customTemplates.map((t) => (
                <YStack
                  key={t.id}
                  bg={c.bgPurpleSoft}
                  p="$3"
                  borderRadius="$3"
                  borderWidth={1}
                  borderColor={c.borderPurple}
                  gap="$2"
                >
                  <XStack alignItems="center" gap="$2">
                    <Sparkles size={16} color={c.secondary} />
                    <Text fontWeight="700" fontSize={14} color={c.secondary} f={1}>
                      {t.name}
                    </Text>
                    <Pressable
                      onPress={() => startEdit(t)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={`Editar template: ${t.name}`}
                    >
                      <Pencil size={18} color={c.secondary} />
                    </Pressable>
                    <Pressable
                      onPress={() => confirmDelete(t)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={`Excluir template: ${t.name}`}
                    >
                      <Trash2 size={18} color={c.accentRed} />
                    </Pressable>
                  </XStack>
                  {t.description && (
                    <Text fontSize={13} color={c.textSecondary}>
                      {t.description}
                    </Text>
                  )}
                </YStack>
              ))}
            </YStack>
          )}

          {/* Seção: Built-in */}
          <YStack gap="$2" mt="$2">
            <Text color={c.textSecondary} fontSize={11} fontWeight="700">
              TEMPLATES PADRÃO
            </Text>
            {BUILTIN_TEMPLATES.map((t) => (
              <YStack
                key={t.id}
                bg={c.bgCard}
                p="$3"
                borderRadius="$3"
                gap="$2"
              >
                <XStack alignItems="center" gap="$2">
                  <BookOpen size={16} color={c.primary} />
                  <Text fontWeight="700" fontSize={14} color={c.text} f={1}>
                    {t.name}
                  </Text>
                  <XStack bg={c.bgBlueSoft} px="$2" py={2} borderRadius={999} borderWidth={1} borderColor={c.borderBlue}>
                    <Text fontSize={9} fontWeight="700" color={c.secondary}>PADRÃO</Text>
                  </XStack>
                </XStack>
                <Text fontSize={13} color={c.textSecondary}>
                  {t.description}
                </Text>
              </YStack>
            ))}
          </YStack>
        </ScrollView>
      </YStack>
      <BottomTabBar />
    </View>
  );
}
