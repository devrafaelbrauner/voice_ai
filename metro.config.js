const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// expo-sqlite web uses wa-sqlite.wasm. Expo SDK 55 docs require Metro to
// treat wasm as an asset for web builds.
if (!config.resolver.assetExts.includes('wasm')) {
  config.resolver.assetExts = [...config.resolver.assetExts, 'wasm'];
}

config.server = {
  ...config.server,
  enhanceMiddleware: (middleware) => (req, res, next) => {
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    return middleware(req, res, next);
  },
};

// Força o Metro a usar a versão CJS dos pacotes em vez de ESM.
// O supabase-js ESM (index.mjs) usa import(variable) que o Hermes não suporta;
// o CJS (index.cjs) usa require() que é compatível.
config.resolver.unstable_enablePackageExports = false;

module.exports = config;
