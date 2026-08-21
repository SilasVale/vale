# ADR 0001: Gateway 采用单一插件核心，index.ts 只做前端门

状态: 已采纳 ｜ 日期: 2026-08-21 ｜ 影响范围: `gateway/src`

## 背景

vale-gate 参照 DSH/Cordis 的插件模型演进。round-73 引入了 `plugins/registry.ts`
（`{ name, deps, setup(ctx) }` + 路由表 + ctx.api 能力面），但迁移是渐进式的：

1. `index.ts`（原 index.js）保留了完整的内联 console 处理链，插件路由先匹配、
   未命中落到内联实现——**同一职责两份代码**。
2. 双份代码已经造成过实际回归：round-99（插件的 /v1 实现从未被走到，800 行
   死代码持续漂移）、round-120（内联 handleGatewayImpl 是过期副本）、
   round-88（mcp 插件手写的会话门漏了 sess-revoked 黑名单）。
3. 会话校验 `requireSession/sessionSecret` 复制了 **4 份**；上游路由表
   `pickRoute/passthroughHeaders` 复制了 **2 份**且行为已分叉（or/ 渠道在
   US_PROXY 开启时，探测与实际转发走不同上游）。
4. 存在第二套从未接线的"生命周期容器"（container.ts/types.ts），其 dispatch
   是返回 null 的占位符，与 registry 并存造成两个 PluginContext 契约。

## 决策

1. **完成迁移，删除双轨**：所有 `/api/*`、`/mcp`、`/v1/*` 路由只存在于插件中；
   `index.ts` 收缩为纯前端门（host 分流、HTTPS 重定向、静态资产、公共工具端点、
   插件上下文装配）。1569 行 → ~400 行。
2. **横切关注点单例化**：新建 `src/session.ts`（会话校验唯一实现）与
   `src/upstream.ts`（渠道路由表唯一实现），插件与 index 共同导入。
3. **删除未使用的第二套插件系统**（container.ts/types.ts/built-in），registry
   自包含唯一定义契约；同时删除全部 `.js` 再导出 shim，wrangler main 直接指向
   `src/index.ts`，测试直接导入真实模块而非桶文件。
4. **控制台 UI 统一设计系统**：全部视图收敛到一套类词汇表 + 共享组件
   （PageHeader/Card/Badge/Modal 等），深色模式与哈希路由。

## 后果

- 正向：新增能力 = 新增/修改一个插件文件；会话与路由语义只有一处真相；
  测试直接针对模块；净删 ~1500 行。
- 负向/代价：插件注册顺序即依赖顺序（auth 依赖 translate 的 api 能力），
  需要在注册列表处维护顺序注释；前缀匹配的 `route()` 辅助函数对子路径敏感，
  动态路由一律使用精确 match（devices 插件已有先例）。

## 验证

- `node --test`：173 通过 / 0 失败（覆盖 console API、代理鉴权、MCP、plugin-hub）。
- `npx wrangler deploy --dry-run`：打包与 DO 导出校验通过。
