/**
 * 绘制层的统一出口。
 *
 * 图层按 order 依次绘制：BACKGROUND → GRID → BORDER → FONT → SELECTION
 *
 * 加新图层（迷你图、条件格式底纹…）只要新增一个文件、在这里挂一行，
 * 不用改渲染核心循环 —— 这就是「分层绘制」的收益。
 *
 * 共享的类型/常量在 ./extension.ts 里，各图层从那边 import，
 * 避免和本文件形成循环引用（见 extension.ts 的注释）。
 */

export {
    CELL_PADDING_X,
    EXTENSION_ORDER,
    ONE_PIXEL_FIX,
    forEachVisibleCell,
    inView,
    type IDrawContext,
    type IRemoteSelection,
    type ISheetExtension,
} from './extension';

export { backgroundExtension } from './background';
export { gridExtension } from './grid';
export { borderExtension } from './border';
export { fontExtension } from './font';
export { remoteSelectionExtension } from './remote-selection';
export { selectionExtension } from './selection';
