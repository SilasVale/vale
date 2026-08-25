# 提案：面板内嵌可操作远程浏览器（round-134）

## 目标
面板内嵌可操作的远程浏览器：多标签、真实点击/键盘输入、登录态持久化 —— 替代只读截图轮询。

## 架构草案
- 画面流: agent 经 CDP Page.startScreencast 推帧，面板 canvas 渲染，WebSocket /api/browser/ws
- 输入注入: 面板坐标/键事件 → WS → CDP Input.dispatchMouseEvent/KeyEvent
- 多标签: CDP Target API + 面板标签条
- 登录态: 持久 user-data-dir（与 playwright-mcp 共享或迁移）
- 安全: 复用 TokenGate；WS 首帧鉴权

## 里程碑
1. M1 单标签：截屏流 + 鼠标/键盘注入（可用性闭环）
2. M2 多标签 + 导航/后退/下载指示
3. M3 AI 操作与人工输入的页面锁协调
