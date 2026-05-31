/**
 * Cross-platform ActionSheet.
 * On iOS: delegates to ActionSheetIOS.
 * On Android: shows a Modal bottom sheet (ActionSheetIOS crashes on Android).
 */
import React, { useState } from 'react';
import {
  ActionSheetIOS,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

export interface ActionSheetOptions {
  title?: string;
  message?: string;
  options: string[];
  cancelButtonIndex: number;
  destructiveButtonIndex?: number;
}

// --- Android bottom-sheet state (module-level singleton) -----------------

type Callback = (index: number) => void;

let _setVisible: ((v: boolean) => void) | null = null;
let _setOpts: ((o: ActionSheetOptions | null) => void) | null = null;
let _callback: Callback | null = null;

export function showActionSheet(
  options: ActionSheetOptions,
  callback: Callback,
): void {
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(options, callback);
    return;
  }
  // Android path
  _callback = callback;
  _setOpts?.(options);
  _setVisible?.(true);
}

// --- AndroidActionSheetProvider ------------------------------------------
// Mount once at the app root (_layout.tsx). On iOS it renders nothing.

export function AndroidActionSheetProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [visible, setVisible] = useState(false);
  const [opts, setOpts] = useState<ActionSheetOptions | null>(null);

  _setVisible = setVisible;
  _setOpts = setOpts;

  if (Platform.OS === 'ios') {
    return <>{children}</>;
  }

  const dismiss = (index: number) => {
    setVisible(false);
    setOpts(null);
    _callback?.(index);
    _callback = null;
  };

  return (
    <>
      {children}
      <Modal
        visible={visible}
        transparent
        animationType="slide"
        accessibilityViewIsModal
        onRequestClose={() => dismiss(opts?.cancelButtonIndex ?? 0)}
      >
        <Pressable
          style={styles.backdrop}
          onPress={() => dismiss(opts?.cancelButtonIndex ?? 0)}
          accessibilityRole="button"
          accessibilityLabel="Fechar menu"
          accessibilityHint="Toque para fechar o menu de opções"
        />
        <View style={styles.sheet}>
          {opts?.title ? <Text style={styles.title}>{opts.title}</Text> : null}
          {opts?.message ? <Text style={styles.message}>{opts.message}</Text> : null}
          <ScrollView bounces={false} style={styles.list}>
            {(opts?.options ?? []).map((label, index) => {
              if (index === opts?.cancelButtonIndex) return null;
              const isDestructive = index === opts?.destructiveButtonIndex;
              return (
                <Pressable
                  key={index}
                  style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
                  onPress={() => dismiss(index)}
                  accessibilityRole="button"
                  accessibilityLabel={label}
                >
                  <Text style={[styles.optionText, isDestructive && styles.destructive]}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <Pressable
            style={({ pressed }) => [styles.cancel, pressed && styles.optionPressed]}
            onPress={() => dismiss(opts?.cancelButtonIndex ?? 0)}
            accessibilityRole="button"
            accessibilityLabel={opts ? opts.options[opts.cancelButtonIndex] : 'Cancelar'}
          >
            <Text style={styles.cancelText}>
              {opts ? opts.options[opts.cancelButtonIndex] : 'Cancelar'}
            </Text>
          </Pressable>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 32,
    paddingHorizontal: 8,
    maxHeight: '75%',
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    color: '#555',
    textAlign: 'center',
    paddingTop: 16,
    paddingBottom: 4,
    paddingHorizontal: 16,
  },
  message: {
    fontSize: 12,
    color: '#888',
    textAlign: 'center',
    paddingBottom: 8,
    paddingHorizontal: 16,
  },
  list: {
    flexGrow: 0,
  },
  option: {
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e5e5e5',
  },
  optionPressed: {
    backgroundColor: '#f0f0f0',
  },
  optionText: {
    fontSize: 16,
    color: '#343a40',
    textAlign: 'center',
  },
  destructive: {
    color: '#c0392b',
  },
  cancel: {
    marginTop: 8,
    marginHorizontal: 8,
    paddingVertical: 16,
    borderRadius: 12,
    backgroundColor: '#f2f2f7',
  },
  cancelText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    textAlign: 'center',
  },
});
