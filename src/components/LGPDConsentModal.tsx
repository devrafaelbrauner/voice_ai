import { Modal, ScrollView, Pressable } from 'react-native';
import { YStack, XStack, Text } from 'tamagui';
import { Shield, FileText, Server, Trash2, Eye } from 'lucide-react-native';
import { useColors } from '../context/ThemeContext';

interface Props {
  visible: boolean;
  onAccept: () => void;
}

export function LGPDConsentModal({ visible, onAccept }: Props) {
  const c = useColors();

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent accessibilityViewIsModal>
      <YStack
        flex={1}
        style={{ backgroundColor: 'rgba(0,0,0,0.7)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 }}
      >
        <YStack
          style={{
            backgroundColor: c.bgCard,
            borderRadius: 16,
            maxHeight: '88%',
            width: '100%',
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <YStack
            style={{
              backgroundColor: c.primary,
              paddingVertical: 20,
              paddingHorizontal: 20,
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Shield size={32} color="#fff" />
            <Text style={{ fontSize: 18, fontWeight: '700', color: '#fff', textAlign: 'center' }}>
              Privacidade e Proteção de Dados
            </Text>
            <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)', textAlign: 'center' }}>
              LGPD — Lei nº 13.709/2018
            </Text>
          </YStack>

          {/* Body */}
          <ScrollView style={{ flexGrow: 0 }} bounces={false}>
            <YStack style={{ paddingHorizontal: 20, paddingVertical: 16, gap: 16 }}>

              <Text style={{ fontSize: 14, color: c.textSecondary, lineHeight: 21 }}>
                Este aplicativo processa dados de saúde (gravações, transcrições e resumos
                clínicos). Antes de continuar, leia como seus dados são tratados.
              </Text>

              {/* Dados coletados */}
              <YStack style={{ gap: 8 }}>
                <XStack style={{ alignItems: 'center', gap: 8 }}>
                  <Eye size={16} color={c.primary} />
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>
                    Dados coletados
                  </Text>
                </XStack>
                <YStack style={{ paddingLeft: 24, gap: 4 }}>
                  {[
                    'Gravações de áudio (armazenadas localmente e sincronizadas na nuvem)',
                    'Transcrições geradas por IA (OpenAI Whisper)',
                    'Resumos e evoluções clínicas',
                    'Dados do médico (nome, CRM) e paciente (nome, plano)',
                  ].map((item) => (
                    <Text key={item} style={{ fontSize: 13, color: c.textSecondary, lineHeight: 19 }}>
                      • {item}
                    </Text>
                  ))}
                </YStack>
              </YStack>

              {/* Processadores externos */}
              <YStack style={{ gap: 8 }}>
                <XStack style={{ alignItems: 'center', gap: 8 }}>
                  <Server size={16} color={c.primary} />
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>
                    Processadores de dados
                  </Text>
                </XStack>
                <YStack style={{ paddingLeft: 24, gap: 8 }}>
                  <YStack>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>OpenAI (EUA)</Text>
                    <Text style={{ fontSize: 12, color: c.textSecondary }}>
                      Transcrição de áudio e sumarização de texto. Os dados de áudio são enviados
                      para os servidores da OpenAI somente durante o processamento.
                    </Text>
                  </YStack>
                  <YStack>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>Supabase (EUA)</Text>
                    <Text style={{ fontSize: 12, color: c.textSecondary }}>
                      Armazenamento seguro de dados clínicos, autenticação e sincronização.
                      Dados criptografados em repouso e em trânsito.
                    </Text>
                  </YStack>
                </YStack>
              </YStack>

              {/* Retenção */}
              <YStack style={{ gap: 8 }}>
                <XStack style={{ alignItems: 'center', gap: 8 }}>
                  <FileText size={16} color={c.primary} />
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>
                    Retenção e finalidade
                  </Text>
                </XStack>
                <YStack style={{ paddingLeft: 24, gap: 4 }}>
                  {[
                    'Dados usados exclusivamente para prestação do serviço de transcrição',
                    'Evoluções clínicas retidas enquanto a conta estiver ativa',
                    'Áudios temporários descartados após transcrição pelos servidores da OpenAI',
                    'Não compartilhamos dados com terceiros não listados acima',
                  ].map((item) => (
                    <Text key={item} style={{ fontSize: 13, color: c.textSecondary, lineHeight: 19 }}>
                      • {item}
                    </Text>
                  ))}
                </YStack>
              </YStack>

              {/* Direitos */}
              <YStack style={{ gap: 8 }}>
                <XStack style={{ alignItems: 'center', gap: 8 }}>
                  <Trash2 size={16} color={c.primary} />
                  <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>
                    Seus direitos (Art. 18 LGPD)
                  </Text>
                </XStack>
                <YStack style={{ paddingLeft: 24, gap: 4 }}>
                  {[
                    'Acesso aos dados pessoais armazenados',
                    'Correção de dados incompletos ou desatualizados',
                    'Exclusão dos dados mediante solicitação',
                    'Portabilidade dos dados clínicos',
                    'Revogação do consentimento a qualquer momento em Configurações',
                  ].map((item) => (
                    <Text key={item} style={{ fontSize: 13, color: c.textSecondary, lineHeight: 19 }}>
                      • {item}
                    </Text>
                  ))}
                </YStack>
              </YStack>

              {/* Contato para exercer direitos */}
              <YStack
                style={{
                  backgroundColor: c.bgSubtle,
                  padding: 12,
                  borderRadius: 8,
                  gap: 4,
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: '600', color: c.text }}>
                  Exercer seus direitos
                </Text>
                <Text style={{ fontSize: 11, color: c.textSecondary }}>
                  Para acessar, corrigir, excluir ou exportar seus dados, entre em contato com o desenvolvedor via configurações do aplicativo.
                </Text>
              </YStack>

            </YStack>
          </ScrollView>

          {/* Footer */}
          <YStack
            style={{
              paddingHorizontal: 20,
              paddingVertical: 16,
              gap: 12,
              borderTopWidth: 1,
              borderTopColor: c.border,
            }}
          >
            <Text style={{ fontSize: 11, color: c.textSecondary, textAlign: 'center' }}>
              Ao aceitar, você autoriza o tratamento dos dados acima para os fins descritos,
              conforme a Lei Geral de Proteção de Dados (LGPD — Lei nº 13.709/2018).
            </Text>

            <Pressable
              onPress={onAccept}
              accessibilityRole="button"
              accessibilityLabel="Aceitar e continuar"
              accessibilityHint="Aceita os termos da LGPD e abre o aplicativo"
            >
              <YStack
                style={{
                  backgroundColor: c.primary,
                  paddingVertical: 14,
                  borderRadius: 12,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>
                  Entendido — Aceitar e Continuar
                </Text>
              </YStack>
            </Pressable>
          </YStack>
        </YStack>
      </YStack>
    </Modal>
  );
}
