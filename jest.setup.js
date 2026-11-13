/* global jest, beforeEach, Buffer */
// Mocks mínimos dos módulos nativos do Expo. Tudo roda em memória, sem rede.
//
// - expo-sqlite  -> adaptador sobre `node:sqlite` (SQL real; Node >= 22).
//   Por padrão cada openDatabaseAsync() abre um banco :memory: novo. Um teste que precisa
//   de um banco pré-populado (ex.: esquema v9) coloca o DatabaseSync em
//   `globalThis.__nextSqliteDb` antes de chamar getDb(); ele é consumido uma vez.
// - expo-file-system (+ /legacy) -> FS em memória em `globalThis.__fakeFs` (uri -> string
//   ou `{ size }` para arquivos "grandes" sem alocar memória).
// - expo-secure-store / AsyncStorage / expo-crypto (node:crypto) / expo-document-picker.
// Estado por registry de módulos: use jest.resetModules() entre testes para zerar.

globalThis.__fakeFs = new Map();

jest.mock('expo-sqlite', () => {
  const { DatabaseSync } = require('node:sqlite');
  const params = (p) => (p ?? []).map((v) => (v === undefined ? null : v));
  const plain = (row) => (row == null ? null : { ...row });

  function wrap(raw) {
    const db = {
      raw,
      execAsync: async (sql) => {
        raw.exec(sql);
      },
      runAsync: async (sql, p) => {
        const r = raw.prepare(sql).run(...params(p));
        return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
      },
      getFirstAsync: async (sql, p) => plain(raw.prepare(sql).get(...params(p))),
      getAllAsync: async (sql, p) => raw.prepare(sql).all(...params(p)).map(plain),
      withTransactionAsync: async (fn) => {
        raw.exec('BEGIN');
        try {
          await fn();
          raw.exec('COMMIT');
        } catch (e) {
          raw.exec('ROLLBACK');
          throw e;
        }
      },
      withExclusiveTransactionAsync: async (fn) => {
        raw.exec('BEGIN EXCLUSIVE');
        try {
          await fn(db);
          raw.exec('COMMIT');
        } catch (e) {
          raw.exec('ROLLBACK');
          throw e;
        }
      },
      closeAsync: async () => {
        raw.close();
      },
    };
    return db;
  }

  return {
    __esModule: true,
    openDatabaseAsync: async () => {
      const preset = globalThis.__nextSqliteDb;
      globalThis.__nextSqliteDb = undefined;
      return wrap(preset ?? new DatabaseSync(':memory:'));
    },
  };
});

jest.mock('expo-secure-store', () => {
  const store = new Map();
  return {
    __esModule: true,
    getItemAsync: async (k) => (store.has(k) ? store.get(k) : null),
    setItemAsync: async (k, v) => {
      store.set(k, String(v));
    },
    deleteItemAsync: async (k) => {
      store.delete(k);
    },
    __store: store,
  };
});

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('expo-crypto', () => ({
  __esModule: true,
  getRandomValues: (arr) => require('node:crypto').randomFillSync(arr),
  randomUUID: () => require('node:crypto').randomUUID(),
}));

jest.mock('expo-document-picker', () => ({ __esModule: true, getDocumentAsync: jest.fn() }));
jest.mock('expo-sharing', () => ({
  __esModule: true,
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => undefined),
}));

jest.mock('expo-file-system', () => {
  const fs = (globalThis.__fakeFs ??= new Map());
  const join = (parts) =>
    parts.reduce((out, p) => {
      const s = typeof p === 'string' ? p : p.uri;
      return out === '' ? s : `${out.replace(/\/+$/, '')}/${s.replace(/^\/+/, '')}`;
    }, '');
  const sizeOf = (v) => (typeof v === 'string' ? Buffer.byteLength(v) : v.size);

  class File {
    constructor(...parts) {
      this.uri = join(parts);
    }
    get name() {
      return this.uri.split('/').pop();
    }
    get exists() {
      return fs.has(this.uri);
    }
    get size() {
      if (!fs.has(this.uri)) throw new Error('File does not exist');
      return sizeOf(fs.get(this.uri));
    }
    async text() {
      if (!fs.has(this.uri)) throw new Error('File does not exist');
      const v = fs.get(this.uri);
      if (typeof v !== 'string') throw new Error('fake file without content');
      return v;
    }
    write(content) {
      fs.set(this.uri, content);
    }
    create() {
      if (!fs.has(this.uri)) fs.set(this.uri, '');
    }
    delete() {
      if (!fs.delete(this.uri)) throw new Error('File does not exist');
    }
  }
  class Directory {
    constructor(...parts) {
      this.uri = join(parts).replace(/\/*$/, '/');
    }
    get name() {
      return this.uri.replace(/\/$/, '').split('/').pop();
    }
    get exists() {
      return true;
    }
    create() {}
    list() {
      return [];
    }
  }
  return {
    __esModule: true,
    File,
    Directory,
    Paths: { cache: new Directory('file:///cache/'), document: new Directory('file:///doc/') },
  };
});

jest.mock('expo-file-system/legacy', () => {
  const fs = (globalThis.__fakeFs ??= new Map());
  return {
    __esModule: true,
    cacheDirectory: 'file:///cache/',
    documentDirectory: 'file:///doc/',
    getInfoAsync: async (uri) => {
      if (!fs.has(uri)) return { exists: false, isDirectory: false };
      const v = fs.get(uri);
      return { exists: true, isDirectory: false, size: typeof v === 'string' ? Buffer.byteLength(v) : v.size };
    },
    deleteAsync: async (uri) => {
      fs.delete(uri);
    },
    readDirectoryAsync: async () => [],
  };
});

// supabase.ts cria o client no import (exige URL) e puxa o polyfill de URL: nunca no teste.
// Quem precisa de um remoto (sync.test.ts) registra o seu próprio jest.mock.
jest.mock('./src/services/supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: null } }),
      getUser: async () => ({ data: { user: null } }),
    },
    from: () => {
      throw new Error('supabase não mockado neste teste');
    },
  },
  isCloudConfigured: () => false,
}));

// O FormData do RN aceita qualquer valor em append (inclusive o File nativo do Expo); o do
// Node só aceita Blob e lançaria no upload multipart. Stub fiel ao que o app usa: append/get.
globalThis.FormData = class FormData {
  _parts = [];
  append(name, value) {
    this._parts.push([name, value]);
  }
  get(name) {
    const part = this._parts.find(([n]) => n === name);
    return part ? part[1] : null;
  }
};

beforeEach(() => {
  globalThis.__fakeFs.clear();
  globalThis.__nextSqliteDb = undefined;
  // logError/logWarn imprimem em __DEV__; os testes inspecionam os spies quando importa.
  for (const level of ['error', 'warn', 'log']) {
    jest.spyOn(console, level).mockImplementation(() => {}).mockClear();
  }
});
