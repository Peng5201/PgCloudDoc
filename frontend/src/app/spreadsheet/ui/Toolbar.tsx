/**
 * 工具栏 —— 用 antd 重写的表格外壳。
 *
 * 对照 Univer: packages/sheets-ui/src/menu/*.menu.ts + views/sheet-container
 *              （Univer 用的是自己那套 @univerjs/ui 组件库，这里换成本项目已有的 antd）
 *
 * 图标用内联 SVG 而不是 @ant-design/icons —— 项目没装那个包，
 * 而这几个图标就几条 path，没必要为此多一个依赖。
 */

import { Button, ColorPicker, Dropdown, Select, Space, Tooltip } from 'antd';
import type { ReactNode } from 'react';
import { PluginSlot } from '../../plugins/ui/PluginSlot';
import {
    HorizontalAlign,
    VerticalAlign,
    WrapStrategy,
    alignPatch,
    createBorderPatch,
    valignPatch,
    wrapPatch,
    type BorderMode,
    type ISheetState,
    type IStylePatch,
    type SheetEngine,
} from '../engine';

interface ToolbarProps {
    engine: SheetEngine | null;
    state: ISheetState | null;
    /** 只读模式：禁用所有写操作入口（浏览/选中仍可用） */
    readOnly?: boolean;
}

const FONT_SIZES = [9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36];

const DEFAULT_BORDER_COLOR = '#1f2329';

export function Toolbar({ engine, state, readOnly = false }: ToolbarProps) {
    const style = state?.style ?? {};

    const apply = (patch: IStylePatch, label: string) => {
        engine?.setRangeStyle(patch, label);
    };

    const toggle = (key: 'bl' | 'it' | 'ul' | 'st') => () => engine?.toggleStyle(key);

    const fontSize = style.fs ?? 14;
    const fontColor = style.cl?.rgb ?? '#1f2329';
    const bgColor = style.bg?.rgb ?? '#ffffff';
    const hAlign = style.ht ?? HorizontalAlign.UNSPECIFIED;
    const vAlign = style.vt ?? VerticalAlign.UNSPECIFIED;
    const wrap = style.tb === WrapStrategy.WRAP;

    return (
        <div style={styles.bar}>
            <Space size={2} separator={<span style={styles.separator} />}>
                <Space size={2}>
                    <Tooltip title="撤销 (Ctrl+Z)">
                        <Button
                            type="text"
                            aria-label="撤销"
                            disabled={readOnly || !state?.canUndo}
                            onClick={() => engine?.undo()}
                            icon={<UndoIcon />}
                        />
                    </Tooltip>
                    <Tooltip title="重做 (Ctrl+Shift+Z)">
                        <Button
                            type="text"
                            aria-label="重做"
                            disabled={readOnly || !state?.canRedo}
                            onClick={() => engine?.redo()}
                            icon={<RedoIcon />}
                        />
                    </Tooltip>
                </Space>

                <Space size={2}>
                    <ToggleButton
                        active={style.bl === 1}
                        title="加粗 (Ctrl+B)"
                        disabled={readOnly}
                        onClick={toggle('bl')}
                        label={<b>B</b>}
                    />
                    <ToggleButton
                        active={style.it === 1}
                        title="斜体 (Ctrl+I)"
                        disabled={readOnly}
                        onClick={toggle('it')}
                        label={<i style={{ fontFamily: 'serif' }}>I</i>}
                    />
                    <ToggleButton
                        active={style.ul?.s === 1}
                        title="下划线 (Ctrl+U)"
                        disabled={readOnly}
                        onClick={toggle('ul')}
                        label={<span style={styles.underline}>U</span>}
                    />
                    <ToggleButton
                        active={style.st?.s === 1}
                        title="删除线"
                        disabled={readOnly}
                        onClick={toggle('st')}
                        label={<span style={styles.strike}>S</span>}
                    />
                </Space>

                <Space size={6}>
                    <Select
                        size="small"
                        style={{ width: 68 }}
                        value={fontSize}
                        disabled={readOnly}
                        options={FONT_SIZES.map((size) => ({ value: size, label: String(size) }))}
                        onChange={(value) => apply({ fs: value }, '字号')}
                        showSearch
                    />
                    <Tooltip title="字体颜色">
                        <ColorPicker
                            size="small"
                            value={fontColor}
                            disabled={readOnly}
                            onChangeComplete={(color) =>
                                apply({ cl: { rgb: color.toHexString() } }, '字体颜色')
                            }
                        />
                    </Tooltip>
                    <Tooltip title="背景色">
                        <ColorPicker
                            size="small"
                            value={bgColor}
                            disabled={readOnly}
                            onChangeComplete={(color) =>
                                apply({ bg: { rgb: color.toHexString() } }, '背景色')
                            }
                        />
                    </Tooltip>
                </Space>

                <Space size={2}>
                    <AlignDropdown
                        title="水平对齐"
                        active={hAlign}
                        disabled={readOnly}
                        items={[
                            { key: 'left', icon: <AlignLeftIcon />, label: '左对齐', value: HorizontalAlign.LEFT },
                            { key: 'center', icon: <AlignCenterIcon />, label: '居中', value: HorizontalAlign.CENTER },
                            { key: 'right', icon: <AlignRightIcon />, label: '右对齐', value: HorizontalAlign.RIGHT },
                        ]}
                        onPick={(value) => apply(alignPatch(value as HorizontalAlign), '水平对齐')}
                    />
                    <AlignDropdown
                        title="垂直对齐"
                        active={vAlign}
                        disabled={readOnly}
                        items={[
                            { key: 'top', icon: <AlignTopIcon />, label: '顶端对齐', value: VerticalAlign.TOP },
                            { key: 'middle', icon: <AlignMiddleIcon />, label: '垂直居中', value: VerticalAlign.MIDDLE },
                            { key: 'bottom', icon: <AlignBottomIcon />, label: '底端对齐', value: VerticalAlign.BOTTOM },
                        ]}
                        onPick={(value) => apply(valignPatch(value as VerticalAlign), '垂直对齐')}
                    />
                    <Tooltip title="自动换行">
                        <Button
                            type="text"
                            aria-label="自动换行"
                            disabled={readOnly}
                            style={wrap ? styles.activeButton : undefined}
                            onClick={() => apply(wrapPatch(!wrap), '自动换行')}
                            icon={<WrapIcon />}
                        />
                    </Tooltip>
                </Space>

                <Dropdown
                    trigger={['click']}
                    menu={{
                        items: [
                            { key: 'none', label: '无边框' },
                            { key: 'outer', label: '外框线' },
                            { key: 'all', label: '所有框线' },
                        ],
                        onClick: ({ key }) =>
                            engine?.setRangeStyle(
                                createBorderPatch(key as BorderMode, DEFAULT_BORDER_COLOR),
                                '边框'
                            ),
                    }}
                >
                    <Button type="text" aria-label="边框" disabled={readOnly} icon={<BorderIcon />} />
                </Dropdown>

                <Tooltip title="清除内容 (Delete)">
                    <Button
                        type="text"
                        aria-label="清除内容"
                        disabled={readOnly}
                        icon={<ClearIcon />}
                        onClick={() => engine?.clearSelection()}
                    />
                </Tooltip>
            </Space>

            {/* 插件工具栏：manifest 贡献先渲染，点击时才激活插件 */}
            <div style={styles.pluginSlot}>
                <PluginSlot name="sheet.toolbar.end" />
            </div>
        </div>
    );
}

// ─────────────────────────── 小控件 ───────────────────────────

interface ToggleButtonProps {
    active: boolean;
    title: string;
    label: ReactNode;
    onClick: () => void;
    disabled?: boolean;
}

function ToggleButton({ active, title, label, onClick, disabled = false }: ToggleButtonProps) {
    return (
        <Tooltip title={title}>
            <Button
                type="text"
                aria-label={title}
                aria-pressed={active}
                disabled={disabled}
                onClick={onClick}
                style={active ? { ...styles.activeButton, ...styles.glyphButton } : styles.glyphButton}
            >
                {label}
            </Button>
        </Tooltip>
    );
}

interface AlignDropdownProps {
    title: string;
    active: number;
    items: Array<{ key: string; icon: ReactNode; label: string; value: number }>;
    onPick: (value: number) => void;
    disabled?: boolean;
}

function AlignDropdown({ title, active, items, onPick, disabled = false }: AlignDropdownProps) {
    const current = items.find((item) => item.value === active) ?? items[0];

    return (
        <Dropdown
            trigger={['click']}
            menu={{
                items: items.map((item) => ({ key: item.key, icon: item.icon, label: item.label })),
                onClick: ({ key }) => {
                    const picked = items.find((item) => item.key === key);
                    if (picked) onPick(picked.value);
                },
            }}
        >
            <Tooltip title={title}>
                <Button
                    type="text"
                    aria-label={title}
                    disabled={disabled}
                    style={styles.glyphButton}
                    icon={current?.icon}
                />
            </Tooltip>
        </Dropdown>
    );
}

// ─────────────────────────── 图标 ───────────────────────────
// 统一 16×16 网格，stroke 用 currentColor 跟随按钮态

const icon = (children: ReactNode) => (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden focusable="false">
        {children}
    </svg>
);

const line = { stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const };

const UndoIcon = () =>
    icon(
        <>
            <path d="M6 4 L2.5 7 L6 10" fill="none" {...line} />
            <path d="M2.5 7 H10 a3.5 3.5 0 0 1 0 7 H6" fill="none" {...line} />
        </>
    );

const RedoIcon = () =>
    icon(
        <>
            <path d="M10 4 L13.5 7 L10 10" fill="none" {...line} />
            <path d="M13.5 7 H6 a3.5 3.5 0 0 0 0 7 H10" fill="none" {...line} />
        </>
    );

const AlignLeftIcon = () =>
    icon(
        <g {...line}>
            <path d="M2 4h12M2 8h8M2 12h11" fill="none" />
        </g>
    );

const AlignCenterIcon = () =>
    icon(
        <g {...line}>
            <path d="M2 4h12M4 8h8M3 12h10" fill="none" />
        </g>
    );

const AlignRightIcon = () =>
    icon(
        <g {...line}>
            <path d="M2 4h12M6 8h8M3 12h11" fill="none" />
        </g>
    );

const AlignTopIcon = () =>
    icon(
        <g {...line}>
            <path d="M3 2v12M7 5h6M7 9h6M7 13h4" fill="none" />
        </g>
    );

const AlignMiddleIcon = () =>
    icon(
        <g {...line}>
            <path d="M3 2v12M7 4h6M7 8h6M7 12h4" fill="none" />
        </g>
    );

const AlignBottomIcon = () =>
    icon(
        <g {...line}>
            <path d="M3 2v12M7 3h4M7 7h6M7 11h6" fill="none" />
        </g>
    );

const WrapIcon = () =>
    icon(
        <g {...line}>
            <path d="M2 4h12M2 8h9a2.5 2.5 0 0 1 0 5H8" fill="none" />
            <path d="M10 11.5 L8 13.5 L10 15" fill="none" />
            <path d="M2 12h5" fill="none" />
        </g>
    );

const BorderIcon = () =>
    icon(
        <g {...line}>
            <rect x="2.5" y="2.5" width="11" height="11" fill="none" />
            <path d="M8 2.5v11M2.5 8h11" fill="none" strokeDasharray="2 2" />
        </g>
    );

const ClearIcon = () =>
    icon(
        <g {...line}>
            <path d="M3 13h10" fill="none" />
            <path d="M5 11 L10 3 L13 6 L8 11 Z" fill="none" />
        </g>
    );

// ─────────────────────────── 样式 ───────────────────────────

const styles = {
    bar: {
        display: 'flex',
        alignItems: 'center',
        padding: '4px 8px',
        borderBottom: '1px solid #e5e7eb',
        background: '#fff',
        flexWrap: 'wrap' as const,
        gap: 2,
    },
    activeButton: {
        background: '#e8f0fe',
        color: '#1a56c4',
    },
    glyphButton: {
        width: 30,
        height: 28,
        padding: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 14,
    },
    underline: { textDecoration: 'underline' as const },
    strike: { textDecoration: 'line-through' as const },
    separator: {
        width: 1,
        height: 18,
        background: '#e5e7eb',
        display: 'inline-block',
    },
    pluginSlot: {
        marginLeft: 'auto',
        display: 'flex',
        alignItems: 'center',
    },
};
