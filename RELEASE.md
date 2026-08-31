# Release runbook

## Convenções

- A versão pública usa SemVer: `MAJOR.MINOR.PATCH`.
- A tag Git é sempre `vMAJOR.MINOR.PATCH`.
- `app.json > expo.version` e `package.json > version` devem ser idênticos.
- `android.versionCode` e `ios.buildNumber` são números de build monotonicamente crescentes, geridos remotamente pelo EAS para builds de produção.
- O caminho oficial de distribuição é EAS Build. Os scripts Gradle locais são contingência para desenvolvimento nativo.

## Antes do primeiro build remoto

Inicialize no EAS os números que já foram distribuídos, usando o último `versionCode` Android e `buildNumber` iOS publicados:

```bash
eas build:version:set
```

Confirme a fonte de versões remota quando o EAS solicitar. O `eas.json` já define `appVersionSource: "remote"` e `production.autoIncrement: true`.

## Criar uma release

1. Atualize `app.json` e `package.json` para a mesma próxima versão SemVer.
2. Adicione as notas da versão em `CHANGELOG.md`.
3. Instale dependências e execute os controles locais:

   ```bash
   npm ci
   npm run release:check
   ```

4. Faça commit em uma branch de release, abra PR e aguarde o CI verde.
5. Após o merge em `main`, crie uma tag anotada:

   ```bash
   git checkout main
   git pull --ff-only origin main
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   git push origin vX.Y.Z
   ```

6. Gere a build de produção:

   ```bash
   eas build --platform all --profile production
   ```

7. Faça smoke test em dispositivos reais. Só então envie e promova a build nas lojas.

## OTA updates

EAS Update não está habilitado neste baseline. Antes de adotá-lo, defina e documente uma `runtimeVersion` compatível e separe mudanças JavaScript compatíveis de mudanças nativas que exigem uma nova build de loja.

## Rollback

- Para uma build de loja: promova a última build aprovada ou publique uma nova correção com incremento de `PATCH` e novo número de build.
- Não reutilize `android.versionCode` nem `ios.buildNumber`.
- Registre o incidente e a correção no changelog da nova release.
