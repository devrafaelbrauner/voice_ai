import { Pressable, StyleSheet, View, Text } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Mic, List, Users, BarChart3, Settings } from 'lucide-react-native';
import { useColors } from '../context/ThemeContext';

const TABS = [
  { label: 'Gravar', icon: Mic, href: '/' as const },
  { label: 'Gravações', icon: List, href: '/recordings' as const },
  { label: 'Pacientes', icon: Users, href: '/patients' as const },
  { label: 'Stats', icon: BarChart3, href: '/stats' as const },
  { label: 'Config', icon: Settings, href: '/settings' as const },
] as const;

export function BottomTabBar() {
  const c = useColors();
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.container,
        {
          height: 52 + insets.bottom,
          paddingBottom: insets.bottom,
          backgroundColor: c.bgCard,
          borderTopColor: c.border,
        },
      ]}
    >
      {TABS.map(({ label, icon: Icon, href }) => {
        const isActive = pathname === href;
        const color = isActive ? c.primary : c.textMuted;

        return (
          <Pressable
            key={href}
            style={styles.tab}
            onPress={() => router.replace(href)}
            accessibilityRole="button"
            accessibilityLabel={label}
          >
            <Icon size={22} color={color} />
            <Text style={[styles.label, { color, fontWeight: isActive ? '700' : '400' }]}>
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingTop: 6,
  },
  label: {
    fontSize: 10,
  },
});
