/**
 * 数字格式渲染 —— 把 Excel 的 numFmt 格式串渲染成显示文本。
 *
 * 为什么放在 model 层：`Worksheet.cellText` 要靠它把「日期序列号 + 格式」
 * 渲染成日期，渲染层和公式栏都走这一条路。放在 import/ 会让 model 反向依赖
 * 导入模块。
 *
 * 支持的是「显示渲染」子集，不是完整格式引擎：
 *   - 数字：`0` `0.00` `#,##0` `#,##0.00` `000` `0%` `0.00%`
 *   - 日期：`yyyy` `yy` `mm` `m` `dd` `d` `hh` `h` `ss` `s` `AM/PM` `A/P`
 *   - 文本：`@`（当作不加格式）
 *
 * 不支持的（货币符号组合、条件分段、科学计数、会计格式）走兜底：
 * 原样 `String(value)`。
 *
 * 时间统一按 **UTC** 处理：Excel 的序列号没有时区概念，ExcelJS 解析出来的
 * Date 也是「把墙上时间当 UTC 存」。日期按本地时区读会整体偏移一天。
 */

/** 格式化时用的最小输入 */
export interface IFormatOptions {
    /** 单元格值（数字或已格式化的文本） */
    value: string | number | boolean;
    /** Excel numFmt 格式串。缺省表示「常规」 */
    pattern?: string;
}

type Token = { type: 'code' | 'literal'; text: string };

/** 格式串 token 缓存 —— 渲染每帧每格都会问，tokenize 结果必须复用 */
const tokenCache = new Map<string, Token[]>();

const DATE_CODE = new Set(['yyyy', 'yy', 'mm', 'm', 'dd', 'd', 'hh', 'h', 'ss', 's', 'am/pm', 'a/p']);

/** 把 Excel 格式串切成 token（引号字面量 / 转义字符 / 格式代码） */
function tokenize(pattern: string): Token[] {
    const cached = tokenCache.get(pattern);
    if (cached) return cached;

    const tokens: Token[] = [];
    // 布局可能是「正数;负数;零;文本」多段，只取第一段
    const first = pattern.split(';')[0] ?? pattern;
    let i = 0;

    const pushLiteral = (text: string) => {
        const last = tokens[tokens.length - 1];
        if (last && last.type === 'literal') last.text += text;
        else tokens.push({ type: 'literal', text });
    };

    while (i < first.length) {
        const ch = first[i];

        // 引号内是字面量
        if (ch === '"') {
            const end = first.indexOf('"', i + 1);
            pushLiteral(end === -1 ? first.slice(i + 1) : first.slice(i + 1, end));
            i = end === -1 ? first.length : end + 1;
            continue;
        }

        // 反斜杠转义下一个字符
        if (ch === '\\') {
            if (i + 1 < first.length) pushLiteral(first[i + 1]);
            i += 2;
            continue;
        }

        // [ ] 里是颜色/条件/区域代码，跳过
        if (ch === '[') {
            const end = first.indexOf(']', i + 1);
            i = end === -1 ? first.length : end + 1;
            continue;
        }

        // 连续字母的数字代码（yyyy / mm / AM/PM …）
        if (/[A-Za-z]/.test(ch)) {
            let j = i;
            let word = '';
            // 只连续收集字母：`/` 是分隔符，不能吞进 yyyy/mm/dd 里
            while (j < first.length && /[A-Za-z]/.test(first[j])) {
                word += first[j];
                j += 1;
            }
            const lower = word.toLowerCase();

            // AM/PM、A/P：字母部分后面紧跟 `/pm` 或 `/p`
            const slash = /^\/(pm|p)/i.exec(first.slice(j));
            if ((lower === 'am' || lower === 'a') && slash) {
                tokens.push({ type: 'code', text: lower === 'am' ? 'am/pm' : 'a/p' });
                i = j + slash[0].length;
                continue;
            }

            if (DATE_CODE.has(lower)) {
                tokens.push({ type: 'code', text: lower });
                i = j;
            } else {
                pushLiteral(word);
                i = j;
            }
            continue;
        }

        // 数字代码：0 # ? , . % 以及其它符号
        if (/[0#?,.%]/.test(ch)) {
            tokens.push({ type: 'code', text: ch });
            i += 1;
            continue;
        }

        pushLiteral(ch);
        i += 1;
    }

    tokenCache.set(pattern, tokens);
    return tokens;
}

/** 格式串是否是日期/时间格式 */
export function isDateFormat(pattern: string | undefined): boolean {
    if (!pattern) return false;
    const stripped = pattern
        .replace(/"[^"]*"/g, '')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\\./g, '');
    // 标准数字格式里不会出现字母，出现 y/m/d/h/s 就是日期
    return /[ymdhs]/i.test(stripped);
}

/** 格式串是否是百分比 */
function isPercentFormat(pattern: string): boolean {
    return pattern.includes('%');
}

/** 数字套用 0/# 型格式 */
function formatNumber(value: number, pattern: string): string {
    const percent = isPercentFormat(pattern);
    const scaled = percent ? value * 100 : value;

    const sample = pattern.split(';')[0] ?? '';
    const dot = sample.lastIndexOf('.');
    const intPart = dot === -1 ? sample : sample.slice(0, dot);
    const decPart = dot === -1 ? '' : sample.slice(dot + 1);

    const hasThousands = intPart.includes(',');
    const decDigits = (decPart.match(/[0#?]/g) ?? []).length;
    const minIntDigits = (intPart.match(/0/g) ?? []).length;

    const negative = scaled < 0;
    const fixed = Math.abs(scaled).toFixed(decDigits);
    let [intStr, decStr = ''] = fixed.split('.');

    if (hasThousands) intStr = intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

    const plainLen = intStr.replace(/,/g, '').length;
    if (plainLen < minIntDigits) intStr = intStr.padStart(intStr.length + (minIntDigits - plainLen), '0');

    const body = decDigits > 0 ? `${intStr}.${decStr}` : intStr;
    return (negative ? '-' : '') + body + (percent ? '%' : '');
}

/** 从 tokens[index] 出发，沿 dir 方向找最近的 code token 文本（跳过字面量） */
function nearestCode(tokens: Token[], index: number, dir: 1 | -1): string | undefined {
    for (let j = index + dir; j >= 0 && j < tokens.length; j += dir) {
        if (tokens[j].type === 'code') return tokens[j].text;
    }
    return undefined;
}

/** Date 套用日期/时间格式（全部按 UTC 取，避免时区偏移） */
function formatDate(date: Date, pattern: string): string {
    const tokens = tokenize(pattern);
    const use12h = /am\/pm|a\/p/i.test(pattern);
    const hours = date.getUTCHours();
    const isPm = hours >= 12;
    const hour12 = hours % 12 === 0 ? 12 : hours % 12;

    let out = '';
    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (token.type === 'literal') {
            out += token.text;
            continue;
        }
        switch (token.text) {
            case 'yyyy':
                out += String(date.getUTCFullYear());
                break;
            case 'yy':
                out += String(date.getUTCFullYear()).slice(-2);
                break;
            case 'm':
            case 'mm': {
                // `m`/`mm` 是月份还是分钟取决于上下文：紧邻 hour 代码，或紧邻
                // second 代码（`mm:ss` 这种省略小时的写法），都当分钟
                const prevCode = nearestCode(tokens, i, -1);
                const nextCode = nearestCode(tokens, i, 1);
                const asMinutes =
                    prevCode === 'h' ||
                    prevCode === 'hh' ||
                    nextCode === 's' ||
                    nextCode === 'ss';
                const value = asMinutes ? date.getUTCMinutes() : date.getUTCMonth() + 1;
                out += token.text === 'mm' ? String(value).padStart(2, '0') : String(value);
                break;
            }
            case 'd':
                out += String(date.getUTCDate());
                break;
            case 'dd':
                out += String(date.getUTCDate()).padStart(2, '0');
                break;
            case 'h':
                out += String(use12h ? hour12 : hours);
                break;
            case 'hh':
                out += String(use12h ? hour12 : hours).padStart(2, '0');
                break;
            case 's':
                out += String(date.getUTCSeconds());
                break;
            case 'ss':
                out += String(date.getUTCSeconds()).padStart(2, '0');
                break;
            case 'am/pm':
                out += isPm ? 'PM' : 'AM';
                break;
            case 'a/p':
                out += isPm ? 'P' : 'A';
                break;
            default:
                out += token.text;
                break;
        }
    }
    return out;
}

/**
 * 渲染单元格显示文本。
 *
 * 优先级：日期格式 → 数字/百分比格式 → 常规（`String(value)`）。
 */
export function formatCellValue(options: IFormatOptions): string {
    const { value, pattern } = options;

    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (value === '') return '';

    const numeric = typeof value === 'number' ? value : Number(value);
    const numericLike = typeof value === 'number' || (value !== '' && Number.isFinite(numeric));

    if (pattern && isDateFormat(pattern) && numericLike && Number.isFinite(numeric)) {
        // 日期值在模型里一律是 Excel 序列号（数字），这里换算成墙上时间
        const date = excelSerialToDate(numeric);
        if (date) return formatDate(date, pattern);
    }

    if (numericLike && Number.isFinite(numeric)) {
        if (pattern && /[0#?]/.test(pattern)) return formatNumber(numeric, pattern);
        return String(value);
    }

    return String(value);
}

/**
 * Excel 序列号 → Date（按 UTC 组件取）。
 *
 * 以 1899-12-30 为原点：Excel 为兼容 Lotus 的 1900 闰年 bug，
 * 1900-03-01 之前会差一天，这个原点是通用修正。
 */
export function excelSerialToDate(serial: number): Date | null {
    if (!Number.isFinite(serial)) return null;
    const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
    const date = new Date(EXCEL_EPOCH_MS + serial * 24 * 60 * 60 * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
}

/** Date → Excel 序列号（写回 xlsx 用） */
export function dateToExcelSerial(date: Date): number {
    const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
    return (date.getTime() - EXCEL_EPOCH_MS) / (24 * 60 * 60 * 1000);
}

/** 清除 token 缓存（测试或长时间运行时用） */
export function clearFormatCache(): void {
    tokenCache.clear();
}
