/**
 * 公式栏 —— 名称框 + 编辑框。
 *
 * 对照 Univer: packages/sheets-ui/src/views/formula-bar/
 *
 * 与单元格编辑态的双向联动：
 *   - 双击格子进入编辑 → 公式栏跟着显示
 *   - 在公式栏里打字 → 浮动编辑器实时同步（不落库，不产生撤销记录）
 *   - Enter / 失焦 → 落库，产生一条撤销记录
 */

import { Button, Input, Space, Tooltip } from 'antd';
import { useEffect, useRef, useState } from 'react';
import {
    parseCellReference,
    rangeSelection,
    singleSelection,
    type ISheetState,
    type SheetEngine,
} from '../engine';

interface FormulaBarProps {
    engine: SheetEngine | null;
    state: ISheetState | null;
}

export function FormulaBar({ engine, state }: FormulaBarProps) {
    const [draft, setDraft] = useState('');
    const [name, setName] = useState('');
    const focusedRef = useRef(false);
    const committedRef = useRef('');

    // 外部状态变了（切格、编辑器内容变）才刷新草稿；
    // 用户正在这里输入时不覆盖，否则打一个字就被弹回去
    useEffect(() => {
        if (focusedRef.current) return;
        const next = state?.isEditing ? state.editText : state?.cellText ?? '';
        setDraft(next);
        committedRef.current = next;
    }, [state?.cellText, state?.editText, state?.isEditing, state?.selectionLabel]);

    useEffect(() => {
        setName(state?.selectionLabel ?? '');
    }, [state?.selectionLabel]);

    const commit = () => {
        if (draft === committedRef.current) return;
        engine?.commitFromFormulaBar(draft);
        committedRef.current = draft;
    };

    const jumpTo = () => {
        if (!engine || !state) return;

        const [start, end] = name.split(':');
        const from = start ? parseCellReference(start) : null;
        if (!from) {
            setName(state.selectionLabel);
            return;
        }

        if (!end) {
            engine.setSelection(singleSelection(from.row, from.column));
            return;
        }

        const to = parseCellReference(end);
        if (!to) {
            engine.setSelection(singleSelection(from.row, from.column));
            return;
        }
        engine.setSelection(rangeSelection(from.row, from.column, to.row, to.column));
    };

    return (
        <div style={styles.bar}>
            <Input
                size="small"
                style={styles.nameBox}
                value={name}
                onChange={(event) => setName(event.target.value)}
                onPressEnter={jumpTo}
                onBlur={jumpTo}
                aria-label="名称框"
            />

            <Space.Compact style={styles.editor}>
                <Button
                    type="text"
                    size="small"
                    style={styles.fx}
                    tabIndex={-1}
                    onClick={() => engine?.beginEdit(state?.selection.active.row ?? 0, state?.selection.active.column ?? 0, undefined, false)}
                >
                    fx
                </Button>
                <Input
                    size="small"
                    style={styles.input}
                    value={draft}
                    placeholder="输入内容或公式"
                    aria-label="公式栏"
                    onChange={(event) => {
                        setDraft(event.target.value);
                        engine?.syncFromFormulaBar(event.target.value);
                    }}
                    onPressEnter={commit}
                    onFocus={() => {
                        focusedRef.current = true;
                    }}
                    onBlur={() => {
                        focusedRef.current = false;
                        commit();
                    }}
                />
                <Tooltip title="确认">
                    <Button type="text" size="small" onClick={commit} tabIndex={-1}>
                        ✓
                    </Button>
                </Tooltip>
                <Tooltip title="取消">
                    <Button
                        type="text"
                        size="small"
                        tabIndex={-1}
                        onClick={() => {
                            engine?.cancelEdit();
                            const next = state?.cellText ?? '';
                            setDraft(next);
                            committedRef.current = next;
                        }}
                    >
                        ✕
                    </Button>
                </Tooltip>
            </Space.Compact>
        </div>
    );
}

const styles = {
    bar: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 8px',
        borderBottom: '1px solid #e5e7eb',
        background: '#fff',
    },
    nameBox: {
        width: 110,
        flex: '0 0 auto',
        textAlign: 'center' as const,
        fontVariantNumeric: 'tabular-nums' as const,
    },
    editor: {
        flex: 1,
        minWidth: 0,
    },
    fx: {
        width: 34,
        color: '#6b7280',
        fontStyle: 'italic' as const,
        borderRight: '1px solid #e5e7eb',
    },
    input: {
        flex: 1,
    },
};
