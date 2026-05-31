import { useState } from 'react';
import { WebView } from 'react-native-webview';
import { YStack } from 'tamagui';
import { useColors, useThemedColors } from '../context/ThemeContext';

interface MermaidViewProps {
  code: string;
}

export const MermaidView = ({ code }: MermaidViewProps) => {
  const c = useColors();
  const { isDark } = useThemedColors();
  const [height, setHeight] = useState(280);

  const webBg = isDark ? '#1f1f1f' : '#ffffff';
  const webFg = isDark ? '#f3f4f6' : '#111827';
  const mermaidTheme = isDark ? 'dark' : 'default';

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <style>
    html, body { margin: 0; padding: 0; background: ${webBg}; color: ${webFg}; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
    body { padding: 8px; }
    .mermaid { width: 100%; display: flex; justify-content: center; }
    .mermaid svg { max-width: 100%; height: auto !important; }
    .error { color: #ef4444; font-size: 12px; padding: 12px; }
  </style>
</head>
<body>
  <pre class="mermaid" id="m"></pre>
  <div id="err" class="error"></div>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <script>
    const code = ${JSON.stringify(code)};
    document.getElementById('m').textContent = code;
    try {
      mermaid.initialize({
        startOnLoad: false,
        theme: '${mermaidTheme}',
        mindmap: { padding: 10, useMaxWidth: true },
      });
      mermaid.run().then(() => {
        setTimeout(() => {
          const h = document.body.scrollHeight + 20;
          window.ReactNativeWebView.postMessage(String(h));
        }, 300);
      }).catch((e) => {
        document.getElementById('err').textContent = 'Erro ao renderizar: ' + (e.message || String(e));
        document.getElementById('m').style.display = 'none';
        window.ReactNativeWebView.postMessage('150');
      });
    } catch (e) {
      document.getElementById('err').textContent = 'Erro: ' + (e.message || String(e));
      window.ReactNativeWebView.postMessage('150');
    }
  </script>
</body>
</html>`;

  return (
    <YStack
      bg={c.bgInput}
      borderRadius="$3"
      overflow="hidden"
      borderWidth={1}
      borderColor={c.border}
    >
      <WebView
        source={{ html }}
        style={{ height, backgroundColor: webBg }}
        scrollEnabled={false}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        onMessage={(e) => {
          const h = Number(e.nativeEvent.data);
          if (h && h > 100 && h < 1500) setHeight(h);
        }}
        originWhitelist={['*']}
        javaScriptEnabled
      />
    </YStack>
  );
};
