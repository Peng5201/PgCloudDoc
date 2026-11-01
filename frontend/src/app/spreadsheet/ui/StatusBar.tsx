/**
 * 状态栏 —— 选区统计 + 缩放。
 *
 * 对照 Univer: packages/sheets-ui/src/views/status-bar/
 */

import { Slider, Tooltip } from 'antd';
import { PluginSlot } from '../../plugins/ui/PluginSlot';
import { MAX_ZOOM, MIN_ZOOM, type ISheetState, type SheetEngine } from '../engine';

interface StatusBarProps {
    engine: SheetEngine | null;
    state: ISheetState | null;
}

/** 数字太长就按千分位截断，状态栏宽度有限 */
function formatNumber(value: number): string {
    if (!Number.isFinite(value)) return '—';
    const rounded = Math.round(value * 100) / 100;
    return rounded.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

export function StatusBar({ engine, state }: StatusBarProps) {
    const stats = state?.stats;
    const showStats = !!stats && stats.numericCount > 0;

    return (
        <div style={styles.bar}>
            <span style={styles.item}>{state?.selectionLabel ?? 'A1'}</span>
            <span style={styles.divider} />
            <span style={styles.item}>已选 {state?.selectedCount ?? 0} 格</span>

            {showStats ? (
                <>
                    <span style={styles.divider} />
                    <Tooltip title={`数值格 ${stats?.numericCount} 个`}>
                        <span style={styles.item}>计数 {stats?.numericCount}</span>
                    </Tooltip>
                    <span style={styles.item}>求和 {formatNumber(stats?.sum ?? 0)}</span>
                    <span style={styles.item}>平均 {formatNumber(stats?.avg ?? 0)}</span>
                    <span style={styles.item}>最小 {formatNumber(stats?.min ?? 0)}</span>
                    <span style={styles.item}>最大 {formatNumber(stats?.max ?? 0)}</span>
                </>
            ) : null}

            <PluginSlot name="sheet.statusBar.end" />

            <div style={styles.zoomBox}>
                <Slider
                    style={styles.slider}
                    min={MIN_ZOOM * 100}
                    max={MAX_ZOOM * 100}
                    step={10}
                    value={Math.round((state?.zoom ?? 1) * 100)}
                    onChange={(value) => engine?.setZoom((value as number) / 100)}
                    tooltip={{ formatter: (value) => `${value}%` }}
                />
                <span style={styles.zoomText}>{Math.round((state?.zoom ?? 1) * 100)}%</span>
            </div>
        </div>
    );
}

const styles = {
    bar: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '2px 12px',
        borderTop: '1px solid #e5e7eb',
        background: '#fff',
        fontSize: 12,
        color: '#6b7280',
        minHeight: 28,
        fontVariantNumeric: 'tabular-nums' as const,
    },
    item: {
        whiteSpace: 'nowrap' as const,
    },
    divider: {
        width: 1,
        height: 12,
        background: '#e5e7eb',
    },
    zoomBox: {
        marginLeft: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: 190,
        flex: '0 0 auto',
    },
    slider: {
        flex: 1,
        margin: 0,
    },
    zoomText: {
        width: 42,
        textAlign: 'right' as const,
    },
};
