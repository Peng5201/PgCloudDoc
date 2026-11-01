/**
 * 侧面板本体：活动栏 + 标题栏 + 内容区。
 *
 * 这是「容器」，不含任何业务：内容全部来自注册进来的视图。
 * 宿主页面注册的视图按 React 渲染，插件注册的按容器挂载渲染。
 */

import {
    Component,
    useEffect,
    useRef,
    useState,
    type ErrorInfo,
    type ReactNode,
} from 'react';
import { Alert, Button, Empty, Spin, Tooltip, Typography } from 'antd';
import { CloseOutlined } from '@ant-design/icons';
import { useSidePanel, useSidePanelState } from './SidePanelProvider';
import type { SidePanelView } from './types';

const { Text } = Typography;

export interface SidePanelProps {
    /** 文档只读时，requiresWrite 的视图只展示提示 */
    readOnly?: boolean;
    /** 空内容时的引导文案 */
    emptyText?: ReactNode;
}

export function SidePanel({ readOnly = false, emptyText }: SidePanelProps) {
    const store = useSidePanel();
    const state = useSidePanelState();
    const active = state.views.find((view) => view.id === state.activeId) ?? null;

    return (
        <aside style={styles.root} aria-label="侧面板">
            <div style={styles.body}>
                <header style={styles.header}>
                    <Text strong ellipsis style={styles.title}>
                        {active?.title ?? '侧面板'}
                    </Text>
                    {active && active.closable !== false && (
                        <Tooltip title="关闭侧面板">
                            <Button
                                type="text"
                                size="small"
                                aria-label="关闭侧面板"
                                icon={<CloseOutlined />}
                                onClick={() => store.hide()}
                            />
                        </Tooltip>
                    )}
                </header>

                <div style={styles.content}>
                    {active ? (
                        active.requiresWrite && readOnly ? (
                            <div style={styles.center}>
                                <Alert
                                    type="info"
                                    showIcon
                                    message="当前文档只读"
                                    description="该面板需要在可编辑状态下使用。"
                                />
                            </div>
                        ) : (
                            <ViewBoundary key={active.id} view={active} />
                        )
                    ) : (
                        <div style={styles.center}>
                            <Empty
                                image={Empty.PRESENTED_IMAGE_SIMPLE}
                                description={emptyText ?? '还没有可用的面板'}
                            />
                        </div>
                    )}
                </div>
            </div>

            {/* 视图多于一个时才需要活动栏，单个视图留着反而占地方 */}
            {state.views.length > 1 && (
                <nav style={styles.rail} aria-label="侧面板视图">
                    {state.views.map((view) => (
                        <Tooltip key={view.id} title={view.title} placement="left">
                            <button
                                type="button"
                                aria-label={view.title}
                                aria-pressed={view.id === state.activeId}
                                style={{
                                    ...styles.railButton,
                                    ...(view.id === state.activeId
                                        ? styles.railButtonActive
                                        : null),
                                }}
                                onClick={() => store.activate(view.id)}
                            >
                                <ViewIcon view={view} />
                            </button>
                        </Tooltip>
                    ))}
                </nav>
            )}
        </aside>
    );
}

function ViewIcon({ view }: { view: SidePanelView }) {
    if (typeof view.icon === 'string') {
        return <img src={view.icon} alt="" width={16} height={16} style={styles.icon} />;
    }
    if (view.icon) return <>{view.icon}</>;
    // 没给图标时用标题首字，活动栏不至于出现空按钮
    return <span style={styles.initial}>{view.title.slice(0, 1)}</span>;
}

/**
 * 视图内容。两种渲染方式二选一：
 *   - React：宿主页面直接给 render()
 *   - 容器：插件给 mount(el)，这里负责挂载/清理
 */
function ViewContent({ view }: { view: SidePanelView }) {
    // manifest 占位：插件激活后会用同 id 的运行时面板替换掉这个视图
    if (view.pending) {
        return (
            <div style={styles.center}>
                <Spin tip="正在加载面板…" />
            </div>
        );
    }
    if (view.mount) return <ContainerContent mount={view.mount} />;
    return <>{view.render?.()}</>;
}

function ContainerContent({ mount }: { mount: (container: HTMLElement) => void | (() => void) }) {
    const ref = useRef<HTMLDivElement>(null);
    const [error, setError] = useState<Error | null>(null);

    useEffect(() => {
        const container = ref.current;
        if (!container) return;

        let cleanup: void | (() => void);
        try {
            cleanup = mount(container);
        } catch (err) {
            console.error('[side-panel] 面板挂载失败', err);
            setError(err instanceof Error ? err : new Error(String(err)));
            return;
        }

        return () => {
            try {
                if (typeof cleanup === 'function') cleanup();
            } catch (err) {
                console.error('[side-panel] 面板清理失败', err);
            }
            // 插件没有清理干净时兜底，避免残留节点被下一次挂载叠加
            container.replaceChildren();
        };
    }, [mount]);

    if (error) {
        return (
            <div style={styles.center}>
                <Alert type="error" showIcon message="面板渲染失败" description={error.message} />
            </div>
        );
    }

    return <div ref={ref} style={styles.mountHost} />;
}

/** 单个视图的异常边界：一个面板崩了不影响活动栏和其他面板 */
class ViewBoundary extends Component<{ view: SidePanelView }, { error: Error | null }> {
    state = { error: null as Error | null };

    static getDerivedStateFromError(error: Error) {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error(`[side-panel] 视图 ${this.props.view.id} 渲染失败`, error, info);
    }

    render() {
        if (this.state.error) {
            return (
                <div style={styles.center}>
                    <Alert
                        type="error"
                        showIcon
                        message="面板渲染失败"
                        description={this.state.error.message}
                    />
                </div>
            );
        }
        return <ViewContent view={this.props.view} />;
    }
}

const styles = {
    root: {
        display: 'flex',
        flexDirection: 'row' as const,
        height: '100%',
        minWidth: 0,
        background: '#fff',
    },
    body: {
        display: 'flex',
        flexDirection: 'column' as const,
        flex: 1,
        minWidth: 0,
    },
    header: {
        display: 'flex',
        alignItems: 'center' as const,
        justifyContent: 'space-between' as const,
        gap: 8,
        height: 40,
        paddingInline: '12px 6px',
        borderBottom: '1px solid #e5e6eb',
        flex: '0 0 auto',
    },
    title: {
        fontSize: 13,
    },
    content: {
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
    },
    center: {
        display: 'flex',
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        padding: 16,
        minHeight: 120,
    },
    mountHost: {
        height: '100%',
    },
    rail: {
        display: 'flex',
        flexDirection: 'column' as const,
        alignItems: 'center' as const,
        gap: 4,
        width: 40,
        paddingBlock: 8,
        borderLeft: '1px solid #e5e6eb',
        background: '#f7f8fa',
        flex: '0 0 auto',
    },
    railButton: {
        display: 'flex',
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        width: 32,
        height: 32,
        padding: 0,
        border: 'none',
        borderRadius: 6,
        background: 'transparent',
        color: '#5f6368',
        cursor: 'pointer',
    },
    railButtonActive: {
        background: '#e8f0ff',
        color: '#3370ff',
    },
    icon: {
        display: 'block',
    },
    initial: {
        fontSize: 13,
        fontWeight: 600,
    },
};
