# 查看器与 OBS 公开演示截图

这三张图供 PR 审阅使用，由 Chrome/WebGL2 实际渲染页面后直接截图，未修改图片内容。

- [常规页面](normal.png)：操作按键固定左下角，消息位于中下方，独立显示 Agent 行动说明与路径。
- [OBS 布局编辑器](obs-editor.png)：展示组件开关、位置、缩放和相机设置；棋盘格是编辑器的透明区域预览。
- [OBS 透明叠加层](obs-overlay.png)：保留 PNG 透明背景，展示第一人称手持物品和 HUD；按键组件横向偏移 2%、缩放 1.1 倍。

## 场景与来源

截图使用原 Java 1.20.6 资源、合成玩家 `viewer_fixture` 和草地平台，页面中的说明及聊天消息为显式测试输入。测试未连接实际游戏服务器，未发出游戏协议包或模型请求。图中用户名、坐标和状态均为公开测试数据。

- 共享查看器源码：[f579863e](https://github.com/jcs130/mc-visual-console/commit/f579863e64428d270dec0d3ddf89dbeab5d93481)。
- 消费端代码：[155e8a17](https://github.com/jcs130/mc-agent-neko/commit/155e8a1706740ca087b7679efba59dc0713047a7)。
- 浏览器 bundle SHA-256：`f70f275d600471b1c2d311f754929ca40c29299d79cd6a3e09112d3283cb80bd`，与实际 HTTP 返回字节一致。
- 截图尺寸：1280×720。另验 1024×768、390×844 下消息加入和清空均不改变按键面板边界。

实际 OBS 录制和完整原生 Java 场景/像素一致性仍待验收。接入和部署方法见[查看器文档](../../modern-viewer.md)。
