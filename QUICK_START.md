# ⚡ Quick Start - voice-ai-recorder

## 1️⃣ Instalação

```bash
cd /Users/rafaelbrauner/voice-ai-recorder
npm install
```

## 2️⃣ Obter uma API Key OpenAI

1. Vá em https://platform.openai.com/api-keys
2. Clique em "Create new secret key"
3. Copie a chave (começa com `sk-`)
4. **Não publique essa chave em lugar nenhum!**

## 3️⃣ Rodar no seu dispositivo

### No iOS Simulator
```bash
npx expo run:ios
```

### No Android Emulator
```bash
npx expo run:android
```

### No seu celular (Expo Go)
```bash
npx expo start
# Escanear QR code no app Expo Go (instalado do App Store/Play Store)
```

## 4️⃣ Configurar a App

1. **Tela inicial**: Clique em "Config" (canto superior esquerdo)
2. **Colar a API key**:
   - Copie sua chave OpenAI
   - Cole no campo "OpenAI API Key"
   - Clique "Salvar"
3. **Dados do médico** (opcional):
   - Nome, CRM, especialidade
   - Usado para gerar PDFs

## 5️⃣ Fazer uma gravação

1. **Tela inicial**: Clique no botão verde grande "INICIAR GRAVAÇÃO"
2. **Fale algo**: Descreva um paciente, um procedimento, etc
3. **Clique em "PARAR"** para terminar

## 6️⃣ Transcrever & Processar

1. Clique em **"Minhas Gravações"** (ícone de lista)
2. Sua gravação aparece na lista
3. Clique em **"Transcrever com IA"** para converter áudio → texto
4. Após transcrever, clique em **"Processar com IA"** para gerar resumo

## 📚 Testes Rápidos

### Teste 1: Gravação funciona?
```
✅ Iniciar → Falar 5 segundos → Parar
✅ Ver na lista de "Minhas Gravações"
```

### Teste 2: Transcrição funciona?
```
✅ API key configurada? (Config → API Key)
✅ Transcrição aparece em segundos
✅ Texto está em português?
```

### Teste 3: IA funciona?
```
✅ Depois de transcrição, clica em "Processar"
✅ Escolhe um template (ex: "Resumo conciso")
✅ Resumo aparece em segundos
```

## 🆘 Troubleshooting

### "Microfone não funciona"
- **iOS**: Settings → Seu App → Microphone → Allow
- **Android**: Abrir app → Aceitar permissão ao pedir

### "API key não salva"
- Verifique que começa com `sk-`
- Não há espaços em branco antes/depois?
- Tente novamente

### "Transcrição falha com 401"
- API key expirou ou é inválida
- Gere uma nova em https://platform.openai.com/api-keys

### "Transcrição falha com 429"
- Você atingiu limite da API (rate limit)
- Espere 1 minuto e tente novamente

## 💡 Dicas

1. **Fale devagar** para melhor transcrição
2. **Em português do Brasil** - já está configurado
3. **Sem ruído de fundo** - melhor qualidade
4. **Teste em Wi-Fi** - mais rápido que celular

## 📖 Documentação Completa

Leia [TEST_REPORT.md](TEST_REPORT.md) para:
- Lista completa de testes
- Descrição de cada feature
- Bugs conhecidos
- Status técnico

---

**Tempo esperado**: ~5 min para setup completo + primeira gravação
