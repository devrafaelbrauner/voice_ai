/**
 * ErrorBoundary — captura erros de render em qualquer tela e exibe uma tela de
 * recuperação em vez de FECHAR o aplicativo.
 *
 * Por que existe?
 * Em builds de produção (Hermes, sem overlay de erro), um throw síncrono durante
 * o render desmonta a árvore React e o app fecha sem aviso. Este boundary:
 *   - Mantém o app vivo.
 *   - Mostra a mensagem do erro (para diagnóstico — o usuário pode reportar).
 *   - Oferece "Tentar novamente" para re-renderizar.
 *
 * Usa apenas componentes nativos do React Native (sem Tamagui / contextos), pois
 * o próprio provedor de tema pode ser a origem do erro — o boundary precisa
 * funcionar de forma independente.
 */

import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { logError } from '../services/log';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  info: string | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    try {
      logError('ErrorBoundary', error);
      logError('ErrorBoundary.stack', info?.componentStack ?? '');
    } catch {
      // nunca deixar o handler de erro lançar
    }
    this.setState({ info: info?.componentStack ?? null });
  }

  reset = () => {
    this.setState({ hasError: false, error: null, info: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const msg = this.state.error?.message ?? String(this.state.error ?? 'Erro desconhecido');

    return (
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.emoji}>⚠️</Text>
          <Text style={styles.title}>Algo deu errado nesta tela</Text>
          <Text style={styles.subtitle}>
            O aplicativo evitou um fechamento inesperado. Você pode tentar novamente
            ou voltar e abrir a tela de novo.
          </Text>

          <View style={styles.errorBox}>
            <Text style={styles.errorLabel}>Detalhe técnico</Text>
            <Text style={styles.errorText} selectable>
              {msg}
            </Text>
            {this.state.info ? (
              <Text style={styles.stackText} selectable numberOfLines={12}>
                {this.state.info.trim()}
              </Text>
            ) : null}
          </View>

          <Pressable style={styles.button} onPress={this.reset} accessibilityRole="button">
            <Text style={styles.buttonText}>Tentar novamente</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fffffc' },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 24, gap: 14 },
  emoji: { fontSize: 44, textAlign: 'center' },
  title: { fontSize: 20, fontWeight: '800', color: '#000000', textAlign: 'center' },
  subtitle: { fontSize: 14, color: '#57534a', textAlign: 'center', lineHeight: 20 },
  errorBox: {
    backgroundColor: '#f0eee7',
    borderColor: '#d9d4c5',
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 6,
    marginTop: 8,
  },
  errorLabel: { fontSize: 11, fontWeight: '700', color: '#c2410c', letterSpacing: 1 },
  errorText: { fontSize: 13, color: '#000000', fontWeight: '600' },
  stackText: { fontSize: 11, color: '#8c8676', marginTop: 6 },
  button: {
    backgroundColor: '#000000',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  buttonText: { color: '#fffffc', fontWeight: '700', fontSize: 15 },
});
