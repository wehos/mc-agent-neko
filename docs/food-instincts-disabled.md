# 主动食物本能开关

`MC_FOOD_INSTINCTS=1` 只控制主动维护饥饿值的行为，例如食物提案、种田和主动觅食。未设置或其它值时，这些主动行为保持关闭。

低血量反射已经独立、永久退役；打开食物本能不会恢复任何低血逃跑、停工、驻守、挖掘、上浮、迁移或 `surviveNow` 路径。

## 不受开关影响的库存治疗例外

- bot 受伤且饥饿值低于自然回血线时，可以吃背包里已有的食物。
- bot 低血且背包里有可饮用治疗/再生药水时，可以饮用。
- 两者都只消费现有库存，不会为了回血主动获取资源或改变当前任务。

相关实现位于 [`contracts.js`](../src/agent/framework/contracts.js)、[`healing_reflex.js`](../src/agent/framework/healing_reflex.js) 和 [`modes.js`](../src/agent/modes.js)。
