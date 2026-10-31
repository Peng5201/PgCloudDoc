/**
 * Sheet 标签栏 —— 底部多表切换。
 *
 * 对照 Univer: packages/sheets-ui/src/views/sheet-bar/
 *              （sheet-bar-tabs + sheet-bar-menu + sheet-bar-button）
 *
 * 用自绘条而不是 antd Tabs：重命名要内联成输入框、删除要有确认、
 * 每个标签要挂右键菜单 —— 用 Tabs 的编辑态去凑反而更绕。
 */

import { Button, Dropdown, Input, Space, Tooltip } from 'antd';
import type { InputRef } from 'antd';
import { useEffect, useRef, useState } from 'react';
import type { ISheetState, SheetEngine } from '../engine';

interface SheetBarProps {
    engine: SheetEngine | null;
    state: ISheetState | null;
    /** 只读模式：禁用增删改 sheet，仅可切换查看 */
    readOnly?: boolean;
}

export function SheetBar({ engine, state, readOnly = false }: SheetBarProps) {
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameDraft, setRenameDraft] = useState('');
    const inputRef = useRef<InputRef>(null);

    useEffect(() => {
        if (renamingId) inputRef.current?.focus();
    }, [renamingId]);

    const sheets = state?.sheets ?? [];
    const activeId = state?.sheetId ?? '';

    const startRename = (id: string, name: string) => {
        if (readOnly) return;
        setRenamingId(id);
        setRenameDraft(name);
    };

    const commitRename = () => {
        if (renamingId && renameDraft.trim()) {
            engine?.renameSheet(renamingId, renameDraft.trim());
        }
        setRenamingId(null);
    };

    return (
        <div style={styles.bar}>
            <div style={styles.scroller}>
                {sheets.map((sheet) => {
                    const isActive = sheet.id === activeId;

                    return (
                        <div
                            key={sheet.id}
                            style={{
                                ...styles.tab,
                                ...(isActive ? styles.tabActive : null),
                            }}
                            onClick={() => {
                                if (renamingId === sheet.id) return;
                                engine?.setActiveSheet(sheet.id);
                            }}
                            onDoubleClick={() => startRename(sheet.id, sheet.name)}
                        >
                            {sheet.tabColor ? (
                                <span
                                    style={{
                                        ...styles.colorDot,
                                        background: sheet.tabColor,
                                    }}
                                />
                            ) : null}

                            {renamingId === sheet.id ? (
                                <Input
                                    ref={inputRef}
                                    size="small"
                                    value={renameDraft}
                                    style={styles.renameInput}
                                    onChange={(event) => setRenameDraft(event.target.value)}
                                    onPressEnter={commitRename}
                                    onBlur={commitRename}
                                    onClick={(event) => event.stopPropagation()}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Escape') {
                                            event.stopPropagation();
                                            setRenamingId(null);
                                        }
                                    }}
                                />
                            ) : (
                                <span style={styles.label}>{sheet.name}</span>
                            )}

                            <Dropdown
                                trigger={['click']}
                                menu={{
                                    items: [
                                        { key: 'rename', label: '重命名', disabled: readOnly },
                                        {
                                            key: 'delete',
                                            label: '删除',
                                            danger: true,
                                            disabled: readOnly || sheets.length <= 1,
                                        },
                                    ],
                                    onClick: ({ key, domEvent }) => {
                                        domEvent.stopPropagation();
                                        if (key === 'rename') {
                                            startRename(sheet.id, sheet.name);
                                        } else if (key === 'delete') {
                                            engine?.removeSheet(sheet.id);
                                        }
                                    },
                                }}
                            >
                                <Button
                                    type="text"
                                    size="small"
                                    tabIndex={-1}
                                    disabled={readOnly}
                                    style={styles.more}
                                    onClick={(event) => event.stopPropagation()}
                                >
                                    ⋯
                                </Button>
                            </Dropdown>
                        </div>
                    );
                })}
            </div>

            <Space size={4} style={styles.actions}>
                <Tooltip title="新增工作表">
                    <Button
                        type="text"
                        size="small"
                        aria-label="新增工作表"
                        disabled={readOnly}
                        onClick={() => engine?.addSheet()}
                        icon={<span style={styles.plus}>＋</span>}
                    />
                </Tooltip>
            </Space>
        </div>
    );
}

const styles = {
    bar: {
        display: 'flex',
        alignItems: 'stretch',
        gap: 8,
        padding: '0 8px',
        borderTop: '1px solid #e5e7eb',
        background: '#fafafa',
        minHeight: 32,
    },
    scroller: {
        display: 'flex',
        alignItems: 'stretch',
        overflowX: 'auto' as const,
        gap: 2,
    },
    tab: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '0 6px 0 12px',
        cursor: 'pointer',
        whiteSpace: 'nowrap' as const,
        fontSize: 12,
        color: '#4b5563',
        // 用长写而非 borderBottom 简写：active 态只改颜色，
        // 简写 + 长写混用会触发 React 的样式冲突告警
        borderBottomWidth: 2,
        borderBottomStyle: 'solid' as const,
        borderBottomColor: 'transparent',
        userSelect: 'none' as const,
    },
    tabActive: {
        background: '#fff',
        color: '#1a56c4',
        borderBottomColor: '#1a56c4',
        fontWeight: 600,
    },
    colorDot: {
        width: 8,
        height: 8,
        borderRadius: '50%',
        flex: '0 0 auto',
    },
    label: {
        maxWidth: 160,
        overflow: 'hidden' as const,
        textOverflow: 'ellipsis' as const,
    },
    renameInput: {
        width: 110,
        height: 22,
    },
    more: {
        width: 20,
        height: 22,
        padding: 0,
        color: '#9ca3af',
        fontSize: 12,
        lineHeight: '22px',
    },
    actions: {
        marginLeft: 'auto',
        display: 'flex',
        alignItems: 'center',
    },
    plus: {
        fontSize: 14,
        lineHeight: 1,
    },
};
