/**
 * 插件插槽。
 *
 * 工具栏、标题栏、状态栏都通过同一个组件渲染：
 *   - 订阅 uiStore 版本号，插件运行时注册/释放会实时反映；
 *   - 只读文档下按 requiresWrite 自动禁用；
 *   - 单个插件的回调异常只提示错误，不影响其他插件。
 */

import { Button, Tooltip } from 'antd';
import { useSyncExternalStore, type ReactNode } from 'react';
import type { StatusBarSlot, ToolbarSlot } from '@pgclouddoc/plugin-api';
import type { PluginHost } from '../host/plugin-host';
import { usePluginHost } from '../host/PluginHostProvider';
import type { StatusBarItemView, ToolbarItemView } from '../host/ui-store';

export type PluginSlotName = ToolbarSlot | StatusBarSlot;

export function PluginSlot({ name }: { name: PluginSlotName }) {
  const host = usePluginHost();
  if (!host) return null;
  return <PluginSlotItems host={host} name={name} />;
}

function PluginSlotItems({ host, name }: { host: PluginHost; name: PluginSlotName }) {
  // 版本号变化即重渲染；items 由 store 按插槽实时计算
  useSyncExternalStore(host.ui.subscribe, host.ui.getVersion);

  const statusBar = name.startsWith('sheet.statusBar');
  const readOnly = host.isActiveDocumentReadOnly();
  const items = statusBar
    ? host.ui.statusBarItems(name as StatusBarSlot)
    : host.ui.toolbarItems(name as ToolbarSlot);

  if (items.length === 0) return null;

  return (
    <span style={statusBar ? styles.statusGroup : styles.group}>
      {items.map((item) => (
        <SlotButton
          key={item.id}
          host={host}
          item={item}
          disabled={item.requiresWrite && readOnly}
        />
      ))}
    </span>
  );
}

function SlotButton({
  host,
  item,
  disabled,
}: {
  host: PluginHost;
  item: ToolbarItemView | StatusBarItemView;
  disabled: boolean;
}) {
  const icon: ReactNode = item.iconUrl ? (
    <img src={item.iconUrl} alt="" width={16} height={16} style={styles.icon} />
  ) : undefined;

  return (
    <Tooltip title={item.title}>
      <Button
        type="text"
        size="small"
        aria-label={item.title}
        disabled={disabled}
        icon={icon}
        style={styles.button}
        onClick={() => {
          if (disabled) return;
          void Promise.resolve(item.run()).catch((err: unknown) =>
            host.reportUiError(item.pluginId, err)
          );
        }}
      >
        {icon ? null : item.title}
      </Button>
    </Tooltip>
  );
}

const styles = {
  group: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
  },
  statusGroup: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    color: '#6b7280',
  },
  button: {
    height: 26,
    paddingInline: 6,
    fontSize: 12,
    fontWeight: 400,
  },
  icon: {
    display: 'block',
  },
};
