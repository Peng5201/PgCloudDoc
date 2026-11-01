/** 宿主级侧面板：容器组件、状态 store、React 绑定 */

export { SidePanel } from './SidePanel';
export { SidePanelArea } from './SidePanelArea';
export {
    SidePanelProvider,
    useSidePanel,
    useSidePanelOptional,
    useSidePanelState,
    useSidePanelView,
    useSidePanelVisibility,
} from './SidePanelProvider';
export { SidePanelStore } from './store';
export type {
    RegisterSidePanelView,
    SidePanelOptions,
    SidePanelPrefs,
    SidePanelState,
    SidePanelStorage,
    SidePanelView,
    SidePanelViewOwner,
} from './types';
export {
    SIDE_PANEL_DEFAULT_WIDTH,
    SIDE_PANEL_MAX_WIDTH,
    SIDE_PANEL_MIN_WIDTH,
} from './types';
