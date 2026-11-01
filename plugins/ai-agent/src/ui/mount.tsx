/**
 * 面板挂载。
 *
 * 侧面板只给一个 DOM 容器；插件在这里挂 Preact 树。
 * 返回的清理函数在面板关闭/切视图/插件停用时调用。
 */

import { render } from 'preact';
import type { AgentController } from '../controller';
import { App } from './App';
import styles from './styles.css?inline';

export function mountPanel(
    container: HTMLElement,
    controller: AgentController
): () => void {
    const root = document.createElement('div');
    root.className = 'ai-panel-root';
    root.style.height = '100%';

    const style = document.createElement('style');
    style.textContent = styles;

    const app = document.createElement('div');
    app.style.height = '100%';

    root.append(style, app);
    container.appendChild(root);

    render(<App controller={controller} />, app);
    void controller.ensureInitialized();

    return () => {
        // 关闭面板 = 中止在途请求和待确认写入；会话内容保留
        controller.onPanelUnmounted();
        render(null, app);
        root.remove();
    };
}
