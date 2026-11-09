# Aria —— 任务 01 报告

[English](ARIA-MISSION-01-REPORT.md) | 中文

分支 `arena/cbbfef15-aria-repository`，提交 `e19208ca2f9985813d1132541fc76f669dd45330`，未合并。新增或修改 102 个文件，11,871 行新增。

下表中每一项结论都是 PASS、FAIL 或 BLOCKED，并附有证据。凡是在本沙箱内无法运行的，都会写明实际运行的替代方案及其确切范围，并明确说明差距，而不是含糊带过。

## 构建了什么

`packages/aria/` 下的三个工作区包，以及设计文档。

| 包 | 内容 |
| --- | --- |
| `aria-theme` | 以类型化数据提供的调色板、对比度辅助函数与字阶；同一组值作为 CSS 自定义属性；以及在 `.aria-surface` 内重绑 DSH `--dsw-alias-*` 名称的覆盖层。 |
| `aria-wordmark` | 标记、符号（底板与描边两种色调）、字标（产品与大写两种字形）、组合标识与应用图标——全部来自同一份导出几何。 |
| `aria-prototype` | 基于包内演示工作区的六个界面、外壳、组件清单、抽屉与模态框、语言字典、路由、独立预览，以及十一个交互测试。 |

未修改任何既有 DSH 包。`packages/aria/` 之外的改动仅有：`tsconfig.base.json` 中的 Aria 别名、`scripts/check-workspace-constraints.ts` 中的一份豁免清单、三行已审计的模型体验条目，以及重新生成的模块图。

## 完成定义

### 1. 品牌识别——标志、字标与变体——PASS

标记是一套构造：顶端平截的收窄拱门，由地面线闭合，被一条 0.86 倍粗细的楣线横穿，方形端点与斜接接头，16px 及以下时笔画从 1.75 加粗到 2.3。四种变体随包发布：主组合、紧凑符号、侧边栏组合、应用图标。证据：`packages/aria/wordmark/src/index.tsx` 中的 `ARIA_MARK_GEOMETRY`，以及 `docs/assets/aria/brand-sheet.png`——它在参考尺寸下按两种底板色调渲染全部五个导出，评审通过。

### 2. 调色板与设计令牌——PASS

石墨底色 `#0b0e0c`、单一青柠强调色 `#c8f169`、石灰岩文字阶梯、琥珀/红/蓝三族状态色，各自带有用于着色填充的文字变体。发布两次——`tokens.ts` 作为数据，`tokens.css` 作为自定义属性——组件读取角色别名而非调色板档位。证据：`packages/aria/theme/src/tokens.ts`、`src/css/tokens.css`。

### 3. 字体排印与间距系统——PASS

八个字号及其行高、四个字重、三个字距值、十档 4px 间距刻度、六档圆角阶梯、三个控件高度、四级高度与三条动效时长。在 `prefers-reduced-motion` 下所有过渡关闭。证据：同两个文件。

### 4. 无障碍与对比度——PASS

每一对都用仓库自带的 `contrastRatio()` 实测，而非凭记忆断言：`text-100` 在四种底色上 17.59→14.25:1，`text-500` 7.60→6.16，`text-600` 5.24→4.25，`text-700` 3.66→2.97，强调色 15.01→12.16，墨色于青柠之上 15.01。有两档在某处未达标，文档明确点名并限定其用途，而不是悄悄使用：`text-700` 仅作装饰，`text-600` 不在抬升底色上用于小字。每个交互元素一个焦点环，一条跳转链接，抽屉与模态框支持 Escape 与焦点恢复。证据：`docs/ARIA-VISUAL-IDENTITY.zh.md` 中的实测表，可用 `@deepseek-ai/dsh-aria-theme` 的 `contrastRatio()` 复现。未测试：屏幕阅读器走查——自动化检查不等于辅助技术审计。

### 5. 组件库——PASS

原样复用 `ui-primitives`：`Button`、`Input`、`Switch`、`Modal`、`Tag`，以及十一个符号。为原型编写：外壳、面板基础件、状态词汇、三种记录类型、控件集、抽屉、新建任务模态框、反馈，以及空/加载词汇——各自带有模块 CSS。`components/primitives.tsx` 是唯一接缝；`src/atoms.ts` 从源码解析它。证据：`packages/aria/prototype/src/components/`。

### 6. 六个界面——PASS

总览、任务、智能体、知识、活动与设置，各自回答一个问题，各自带有详情抽屉与状态。证据：`docs/assets/aria/` 中 1440/1024/390 三档共 18 张截图加三张交互状态，均从仓库内预览采集，三种宽度下控制台零错误、横向溢出零。

### 7. 信息架构与导航——PASS

五个主目的地加一个次级设置分组、一个统计待决策任务数的徽标、可链接详情视图的哈希路由（`#/missions?mission=…`），未知路由回退到总览。证据：`src/routes.ts`、`src/shell/Shell.tsx`，以及断言导航会改变哈希的测试。

### 8. 交互模型——PASS

抽屉、带计数与空状态的筛选、本地搜索、带校验/规划态/可关闭横幅的新建任务流程、键盘与焦点处理。全部为本地状态；没有 `fetch`、没有 websocket、没有持久化。证据：`tests/prototype.spec.tsx`——11/11 通过——以及 `state-new-mission.png`。

### 9. 响应式行为——PASS

外壳断点 1180/1023/720，界面级断点 900/860/760/640/560。导航栏先折叠为图标、再变为浮层抽屉；筛选行改为横向滚动而非换行；抽屉转为全宽。证据：每个界面三档宽度的截图，加上一个报告精确越界元素的自动探测——零发现。

### 10. 文档——PASS

`docs/ARIA-VISUAL-IDENTITY.md` 与 `.zh.md` 构成经校验的双语对，涵盖参照界面、品牌、带实测对比度的令牌、组件清单、架构、各界面、交互模型、响应式行为、限制与未来工作，以及截图表。每个包都带有遵循仓库库模板的双语 README 对。证据：配对门禁报告 936 对一致。

### 11. 演示数据、明确隔离——PASS

单一 `DEMO_WORKSPACE` 固定数据，包内任何位置都没有导入服务，每个界面都有常驻原型提示，活动流带有演示标签，模态框与横幅的文案说明新建任务只存在于会话中。因为没有后端，所以不存在关于后端行为的声明——指派控件明确拒绝伪装。

### 12. 保留原 DSH 界面——PASS

`packages/aria/` 之外没有任何文件改变渲染行为。`apps/web`、`packages/client/*` 与主题服务均未改动；Aria 层通过添加 `.aria-surface` 选择加入，挂载期间加在 `<body>` 上的 class 会在卸载时移除。证据：`git show --stat`——唯一的非 Aria 改动是别名列表、一份豁免集合、三行审计条目与生成的模块图。

### 13. 验证与报告——PASS（带范围说明）

已运行且全绿：按仓库自身 ES2024 客户端设置，覆盖三个 Aria 包以及原子接缝所触达的每一处 `ui-primitives` 源码的 TypeScript——0 个错误（首次运行发现 9 个真实错误，全部来自写在 ES2022 上的临时配置；代码同时也从 `Array#sort` 改为 `Array#toSorted` 以满足严格 lint 规则，配置已修正）；同样三个包经由仓库复合项目引用——`packages/aria/` 0 个错误；以严格规则集对 `packages/aria` 运行 oxlint——0 个错误，14 条警告其中 7 条是仓库自身的 `clsx` 默认导入习惯（与其 `ui-primitives` 产生的同 30 条警告同源）；vitest——11/11；Puppeteer——21 次采集，控制台零错误、零溢出。

可离线运行的仓库门禁，全部通过：翻译配对（936 对）、Markdown 换行（1,890 个文件）、交叉链接（1,860）、文档引用（3,877）、包路径（5,699）、包 README 摘要/限制/模型体验、导出 JSDoc（`packages/aria` 中 0 项）、DSH 包许可（340 个包）、工作区清单策略（三个 Aria 清单全部通过）、`tsconfig` 路径生成、模块图。

**BLOCKED：** 本沙箱内 `pnpm install` 无法完成（有依赖经由不可达的主机解析），因此 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`publint`、完整的 `verify-export-jsdoc`、`verify-client-packages` 与客户端打包门禁未能针对完整依赖图端到端运行。包清单改为直接调用仓库自身的清单策略函数校验。具备已安装检出的评审者应在合并前运行 `pnpm install && pnpm run typecheck && pnpm run lint && pnpm test`。

**既有失败，非本次改动所致：** `packages/mission/mission-continuity/README.md` 未通过 README 摘要预算（178 词对上限 100）与模型体验分节顺序规则。该文件在本分支上未被触碰，与 `main` 完全一致；相关失败在基线提交的干净检出上可复现。此处如实报告而非修复，因为修另一个包的 README 不在本任务范围内。

## 已知差距

- 原型是一个包，不是已注册的 DSH 插件。接入意味着在展示类型上写适配层，并把真实导航路由进外壳。
- 仅深色主题、仅英文。令牌层可以承载浅色主题；未定义任何浅色取值。
- 标记与字标以 React 组件形式发布，尚不是独立 SVG 资产，因此安装程序或非 React 的文档站点暂时无法直接使用。
- 设置仅为视觉呈现：没有控件写入配置。

## 如何评审

```sh
pnpm install
pnpm --filter @deepseek-ai/dsh-aria-prototype run preview
pnpm --filter @deepseek-ai/dsh-aria-prototype exec vitest run
```

然后对照 `docs/assets/aria/` 阅读 `docs/ARIA-VISUAL-IDENTITY.zh.md`。
