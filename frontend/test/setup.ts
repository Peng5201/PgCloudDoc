/**
 * Vitest 环境垫片。
 *
 * 默认 Node 环境没有 localStorage，而 `api/client.ts` 在模块顶层读取它。
 * 这里提供一个内存实现，让不依赖浏览器的单元测试（doc-sync、插件协议等）
 * 可以在 Node 下跑。
 */

interface MemoryStorage {
  readonly length: number;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
  key(index: number): string | null;
}

function createMemoryStorage(): MemoryStorage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    getItem(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
    key(index) {
      return [...store.keys()][index] ?? null;
    },
  };
}

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: createMemoryStorage(),
    configurable: true,
    writable: true,
  });
}
