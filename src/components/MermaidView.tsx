import { useState } from 'react';
import { getRandomValues } from 'expo-crypto';
import { WebView } from 'react-native-webview';
import { YStack } from 'tamagui';
import { useColors, useThemedColors } from '../context/ThemeContext';

interface MermaidViewProps {
  code: string;
}

// Versão fixada + SRI (sha384 de mermaid@10.9.8/dist/mermaid.min.js, calculado via curl|openssl).
const MERMAID_SRC = 'https://cdn.jsdelivr.net/npm/mermaid@10.9.8/dist/mermaid.min.js';
const MERMAID_SRI = 'sha384-N3QqR/7q+xm3BGX+CBbNI8AUmRRqcsDzToy+0z1NLDI0QmTKW8zvwLvqulJgk3dP';
// CSP montado em MermaidView (nonce aleatório; sem host na allowlist — nonce + SRI bastam).

export const MermaidView = ({ code }: MermaidViewProps) => {
  const c = useColors();
  const { isDark } = useThemedColors();
  const [height, setHeight] = useState(280);

  const webBg = isDark ? '#1f1f1f' : '#ffffff';
  const webFg = isDark ? '#f3f4f6' : '#111827';
  const mermaidTheme = isDark ? 'dark' : 'default';
  // Nonce aleatório estável durante a vida do componente (um nonce novo a cada render
  // mudaria o source e recarregaria a WebView em loop). A tag externa também tem SRI.
  const [nonce] = useState(() =>
    Array.from(getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
  );

  // JSON.stringify não escapa "<": sem isso, "</script>" no código do diagrama
  // fecharia o <script> inline. U+2028/2029 também são escapados por segurança.
  const safeCode = JSON.stringify(code)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  const csp =
    `default-src 'none'; script-src 'nonce-${nonce}'; ` +
    "style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'";

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="Content-Security-Policy" content="${csp}">
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
  <script nonce="${nonce}" src="${MERMAID_SRC}" integrity="${MERMAID_SRI}" crossorigin="anonymous"></script>
  <script nonce="${nonce}">
    const code = ${safeCode};
    document.getElementById('m').textContent = code;
    try {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
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
        // Mantido '*' de propósito: no react-native-webview, uma navegação que NÃO passa
        // na whitelist é aberta externamente via Linking.openURL (vazaria dados). Com '*',
        // quem decide é onShouldStartLoadWithRequest, que bloqueia tudo exceto about:blank.
        originWhitelist={['*']}
        setSupportMultipleWindows={false}
        onShouldStartLoadWithRequest={(req) => req.url === 'about:blank'}
        javaScriptEnabled
      />
    </YStack>
  );
};
