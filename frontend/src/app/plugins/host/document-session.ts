/**
 * 文档会话注册中心。
 *
 * 编辑器（EditorPage / SheetView）是唯一知道 engine 的地方；插件系统只拿会话，
 * 并且通过 `canWrite()` 实时读角色，而不是在挂载时缓存一个布尔值 ——
 * 角色是异步加载的，缓存会直接把只读用户放进来。
 *
 * 同一个文档、同一个 engine 重复 attach 是幂等的（StrictMode / 宿主晚于编辑器就绪）。
 */

import type { SheetEngine } from '../../spreadsheet/engine';

export interface DocumentSessionOptions {
  id: string;
  engine: SheetEngine;
  getTitle: () => string;
  canWrite: () => boolean;
}

export class DocumentSession {
  private disposed = false;

  constructor(private readonly options: DocumentSessionOptions) {}

  get id(): string {
    return this.options.id;
  }

  get engine(): SheetEngine {
    return this.options.engine;
  }

  get title(): string {
    return this.options.getTitle();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** 权限 = 角色确认可写 + 引擎未只读 + 会话未关闭 */
  canWrite(): boolean {
    if (this.disposed) return false;
    if (this.options.engine.isReadOnly) return false;
    try {
      return this.options.canWrite();
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}

export class DocumentSessionRegistry {
  private current: DocumentSession | null = null;
  private readonly openListeners = new Set<(session: DocumentSession) => void>();
  private readonly closeListeners = new Set<(documentId: string) => void>();

  attach(options: DocumentSessionOptions): DocumentSession {
    const existing = this.current;
    if (existing && existing.id === options.id && existing.engine === options.engine) {
      return existing;
    }
    if (existing) this.detach(existing.id);

    const session = new DocumentSession(options);
    this.current = session;
    for (const listener of [...this.openListeners]) {
      try {
        listener(session);
      } catch (err) {
        console.error('[plugins] 文档打开监听失败', err);
      }
    }
    return session;
  }

  detach(documentId?: string): void {
    const session = this.current;
    if (!session) return;
    if (documentId && session.id !== documentId) return;

    this.current = null;
    session.dispose();
    for (const listener of [...this.closeListeners]) {
      try {
        listener(session.id);
      } catch (err) {
        console.error('[plugins] 文档关闭监听失败', err);
      }
    }
  }

  active(): DocumentSession | null {
    return this.current;
  }

  onDidOpen(cb: (session: DocumentSession) => void): () => void {
    this.openListeners.add(cb);
    return () => {
      this.openListeners.delete(cb);
    };
  }

  onDidClose(cb: (documentId: string) => void): () => void {
    this.closeListeners.add(cb);
    return () => {
      this.closeListeners.delete(cb);
    };
  }

  dispose(): void {
    this.detach();
    this.openListeners.clear();
    this.closeListeners.clear();
  }
}
