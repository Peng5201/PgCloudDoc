# render —— 渲染层

把工作表对象（`Worksheet`）画到 `<canvas>` 上，回答「一帧是怎么画出来的」。

设计上参考了 Univer 的 `engine-render`（代码注释里有逐处对照），但收敛到自研引擎需要的最小集。

**这层只负责「画」**，边界很清晰：

- **不持有对象所有权** —— `worksheet`（工作表对象）/ `skeleton` / `styles` / `getSelection` 都由 `SheetEngine` 注入，渲染层只借引用读。
- **不处理交互** —— 点击、滚动、选区操作在 `interact/`。
- **不改数据** —— 数据变更走 `command/`，渲染层永远是只读消费方。

---

## 入口与装配

render 层没有自己独立的启动入口，它由 `SheetEngine` 在构造时装配、驱动。从 React 组件到 `Renderer` 的完整链路：

```text
SheetView (React 组件)
   │  渲染画布容器 <div ref={containerRef}>
   │  useSheetEngine(containerRef, snapshot)          SheetView.tsx:30
   ▼
useSheetEngine hook
   │  new SheetEngine({ container, snapshot })        useSheetEngine.ts:51
   ▼
SheetEngine 构造函数
   │  new Renderer(container)                          index.ts:189  ← 入口
   │  renderer.skeleton / worksheet / styles / zoom = …  index.ts:207
   │  renderer.getSelection = …                        index.ts:248
   │  renderer.invalidate()  ← 触发第一帧              index.ts:253
   ▼
Renderer (renderer.ts)
   │  createElement('canvas') 挂到 container           renderer.ts:71
   │  invalidate() → rAF → draw()                      renderer.ts:110 / 162
```

对应文件：

- [`SheetView.tsx`](../../SheetView.tsx) —— 画布容器 div（`flex:1; min-height:0`，否则 canvas 拿不到确定尺寸、视口裁剪全错）；[`SheetView.tsx:30`](../../SheetView.tsx#L30) 调 `useSheetEngine`。
- [`hooks/useSheetEngine.ts`](../../hooks/useSheetEngine.ts) —— [`useSheetEngine.ts:51`](../../hooks/useSheetEngine.ts#L51) `new SheetEngine(...)`，并订阅事件同步到 React。
- [`engine/index.ts`](../index.ts) —— `SheetEngine` 构造：`new Renderer`、注入依赖、首次 `invalidate()`。
- [`renderer.ts`](renderer.ts) —— `Renderer` 本体。

关键点：

- **依赖全部注入**：`Renderer` 不自己 new 对象，`skeleton` / `worksheet` / `styles` / `zoom` / `getSelection` 都由 `SheetEngine` 在构造后填进来。
- **重绘只有一条路**：各处调 `renderer.invalidate()` —— 数据变更、`ResizeObserver`、滚动/缩放/选区，都汇聚到这一个方法。
- **导出只是便利**：`engine/index.ts` re-export `Renderer`，外部 `import { Renderer } from '../engine'`；但装配只发生这一次，别在别处再 `new`。

---

## 一帧是怎么画出来的

```text
数据变更 / 滚动 / 选择变化
   │  renderer.invalidate()        ← O(1)，只翻一个 dirty 位
   ▼
requestAnimationFrame 合帧         ← 同一帧内多次标脏，只画一次
   ▼
renderer.draw()
   │  ① 同步 DPR 位图尺寸（高分屏不糊）
   │  ② 铺底色
   ├─ drawContent()                ← 内容区
   │    skeleton.ensure()           ← 布局真脏才重建（前缀和）
   │    viewport() → visibleRange() ← 视口裁剪，只算可见行列
   │    ctx 变换：表头偏移 → 缩放 → 减滚动（进内容坐标系）
   │    background → grid → border → font → selection   逐层画
   └─ drawHeaders()                ← 表头，画在屏幕坐标系
```

调用方（交互层 / 引擎）永远只喊一声 `invalidate()`，不需要知道画什么、怎么画、何时画 —— 这些都收敛在渲染层内部。

---

## 目录结构

| 文件 | 职责 |
| --- | --- |
| [`renderer.ts`](renderer.ts) | `Renderer` 渲染主循环：脏标记 + rAF、DPR、视口裁剪、表头绘制 |
| [`accumulator.ts`](accumulator.ts) | `Accumulator` 前缀和累加器：像素 ↔ 行列下标 O(1)/O(log n) |
| [`skeleton.ts`](skeleton.ts) | `SheetSkeleton` 布局缓存：几何查询、样式解析、文本测量、断行 |
| [`extensions/extension.ts`](extensions/extension.ts) | `IDrawContext` 绘制上下文、`ISheetExtension` 接口、图层顺序、公共工具 |
| [`extensions/index.ts`](extensions/index.ts) | 图层统一出口 |
| [`extensions/background.ts`](extensions/background.ts) | 背景层：只画有背景色的格子 |
| [`extensions/grid.ts`](extensions/grid.ts) | 网格线层：受 `showGridlines` 控制 |
| [`extensions/border.ts`](extensions/border.ts) | 边框层：上/右/下/左四边 + 线型 |
| [`extensions/font.ts`](extensions/font.ts) | 文本层：溢出/换行/裁剪、对齐、下划线/删除线 |
| [`extensions/remote-selection.ts`](extensions/remote-selection.ts) | 协作者选区层：半透明底色 + 名字标签 |
| [`extensions/selection.ts`](extensions/selection.ts) | 选区层：淡蓝底、主选区框、活动格、填充柄 |

---

## 核心设计

### 1. 布局与绘制分离

`SheetSkeleton` **不画任何像素**，只回答几何问题（`cellRect` / `visibleRange` / `measureText` / `resolveColor`…）；真正画像素的是 `Renderer` + 各 `extension`。

收益：改一行高 → 重建一次前缀和数组 → 之后**每一帧**的定位都是 O(1)。这正是「布局计算」和「绘制」分开的价值。

### 2. 视口裁剪 + overscan

只算、只画可见的行列。滚到第 5000 行和第 5 行代价一样，因为不可见的 4995 行从头到尾就没参与。

`skeleton.overscan = 1`：可见范围额外多画一行一列，避免快速滚动时边缘露白。

### 3. 脏标记 + rAF 合帧

`invalidate()` 只把 `_dirty` 置位，真正的 `draw()` 丢给 `requestAnimationFrame`。连续输入 20 个字符只重绘 1 次，而不是每字一帧。

### 4. 前缀和 O(1) 定位

`Accumulator` 是渲染引擎的心脏：

```text
prefix[i] = 前 i 行的总高度
第 r 行顶部 y = prefix[r]，行高 = prefix[r+1] - prefix[r]   → O(1)
像素 → 行号：二分查找                                        → O(log n)
```

朴素做法「遍历 0..r-1 累加」是 O(r)，画 100 个格子滚到 5000 行就是每帧 50 万次加法。前缀和把重建开销（O(n)）只在行高变化时付一次。

### 5. DPR 缩放

高分屏上 1 CSS 像素 = N 设备像素。`draw()` 里把 canvas 位图尺寸设成 `css × dpr`，再用 `setTransform(dpr, …)` 让后续所有坐标都用 CSS 像素写 —— 不处理就会糊。

### 6. 分层绘制（扩展机制）

每个图层是一个 `ISheetExtension`（`{ order, name, draw(dc) }`），按 `EXTENSION_ORDER` 从小到大依次画。加新图层只要新写一个文件、在 `extensions/index.ts` 挂一行，**核心渲染循环一行都不用改**。

### 7. 稀疏渲染

`forEachVisibleCell` 只遍历可见区里**有内容**的格子。10 万格里可能只有 50 个有背景色，就只画 50 个矩形，而不是 10 万个。

### 8. 表头是固定层

表头画在**屏幕坐标系**里，所以滚动和缩放都不影响它。关键约束：高亮只能画在表头带内 —— `drawHeaders()` 用 `clip` 把绘制限制在「顶部带 + 左侧带」的并集，越界一笔都画不出来（否则选中 A1 时整列高亮会盖在正文上）。

---

## 图层与绘制顺序

`order` 越小越先画（越靠近底图）：

| 顺序 | 图层 | order | 画什么 |
| --- | --- | --- | --- |
| 1 | `background` | 0 | 有背景色的格子（稀疏） |
| 2 | `grid` | 10 | 全局网格线（`showGridlines` 关掉即隐藏） |
| 3 | `border` | 20 | 单元格自己声明的四边（稀疏） |
| 4 | `font` | 30 | 文本：溢出 / 换行 / 裁剪、对齐、下划线删除线 |
| 5 | `remote-selection` | 90 | 其他协作者的选区：半透明底色 + 名字标签 |
| 6 | `selection` | 100 | 选区淡蓝底、主选区框、活动格、填充柄 |

别的协作者的选区画在自己下面（90 < 100），自己的高亮永远最显眼。

文本层（`font.ts`）是最讲究的一层，三件事决定它像不像 Excel：

1. **视口裁剪** —— 一帧只测几十次文本宽度，不是几十万次。
2. **溢出语义** —— 右边格子空就让文字流过去（OVERFLOW），否则裁剪到自己边界（CLIP）或换行（WRAP）。
3. **+0.5px 偏移** —— 对抗 1px 线落在整数坐标上的半像素抗锯齿模糊。

---

## 坐标系统

| 坐标系 | 说明 |
| --- | --- |
| 内容坐标 | 单元格在逻辑表格里的像素位置，`skeleton.cellRect()` 返回值 |
| 屏幕坐标 | canvas 容器内的 CSS 像素，表头、编辑浮层用它 |

换算关系（`renderer.ts` 里 `contentToScreen` / `screenToContent`）：

```text
屏幕 = 表头偏移 + (内容坐标 - 滚动) × 缩放
内容 = (屏幕 - 表头偏移) / 缩放 + 滚动
```

`drawContent()` 的 ctx 变换就是这句话的矩阵形式：`translate(headerWidth, headerHeight)` → `scale(zoom)` → `translate(-scrollX, -scrollY)`。

---

## 加一个新图层

以「条件格式底纹」为例，三步：

1. 新建 `extensions/conditional.ts`，实现 `ISheetExtension`：

```ts
export const conditionalExtension: ISheetExtension = {
    order: EXTENSION_ORDER.FONT + 1,   // 插到文本之后、选区之前
    name: 'conditional',
    draw({ ctx, skeleton, worksheet, view }: IDrawContext) {
        forEachVisibleCell(worksheet.cellData.matrix, view, (row, column, cell) => {
            // …只画满足条件的格子…
        });
    },
};
```

2. 在 `extensions/index.ts` 里 re-export 它。

3. 在 `Renderer` 构造的 `_extensions` 数组里加进去（或运行时用 `setExtensions()` 追加）。

不需要碰 `drawContent()` 的主循环，也不需要改其他图层。
