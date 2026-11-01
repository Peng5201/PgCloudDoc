/**
 * 插件宿主 Provider。
 *
 * 登录态变化驱动整个生命周期：
 *   - 有用户 → 创建 PluginHost，拉索引，注册 manifest 贡献
 *   - 登出/切换用户 → dispose 全部插件，避免上一个用户的数据残留在插件里
 *
 * 索引拉取失败不阻塞页面：PluginHost 内部会降级到缓存或空列表。
 */

import { App as AntApp } from 'antd';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { MessageLevel } from '@pgclouddoc/plugin-api';
import { useAuth } from '../../auth/AuthContext';
import { PluginHost } from './plugin-host';

const PluginHostContext = createContext<PluginHost | null>(null);

export function PluginHostProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { message } = AntApp.useApp();

  const notify = useCallback(
    (level: MessageLevel, text: string) => {
      switch (level) {
        case 'success':
          void message.success(text);
          break;
        case 'warning':
          void message.warning(text);
          break;
        case 'error':
          void message.error(text);
          break;
        default:
          void message.info(text);
      }
    },
    [message]
  );

  // 宿主实例只随 userId 重建；通知器通过 ref 取最新实现，避免 message 引用变化导致插件重载
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const [host, setHost] = useState<PluginHost | null>(null);
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId) {
      setHost(null);
      return;
    }

    const instance = new PluginHost({
      userId,
      notifier: (level, text) => notifyRef.current(level, text),
    });
    setHost(instance);
    void instance.initialize();

    return () => {
      instance.dispose();
      setHost((current) => (current === instance ? null : current));
    };
  }, [userId]);

  return <PluginHostContext.Provider value={host}>{children}</PluginHostContext.Provider>;
}

export function usePluginHost(): PluginHost | null {
  return useContext(PluginHostContext);
}
