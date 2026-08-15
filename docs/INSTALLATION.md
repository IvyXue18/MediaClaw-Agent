# 安装与连接 MediaClaw Agent

MediaClaw Agent 需要与 MediaClaw 浏览器插件配合使用。普通用户不需要自行配置端口、令牌或运行服务。

## 第一步：准备浏览器插件

1. 安装或升级 MediaClaw 浏览器插件。
2. 在 MediaClaw 插件中完成有效会员验证。
3. 在浏览器中登录需要使用的小红书或抖音账号。
4. 确认插件可以正常打开。

## 第二步：安装到 Agent

### Codex

```bash
codex plugin marketplace add IvyXue18/MediaClaw-Agent
codex plugin add mediaclaw@mediaclaw-agent
```

安装完成后，新建一个 Codex 任务。

### WorkBuddy

在 WorkBuddy 中执行：

```text
/plugin marketplace add IvyXue18/MediaClaw-Agent
/plugin install mediaclaw@mediaclaw-agent
```

安装完成后，新建一个 WorkBuddy 会话。

## 后续更新

每个新会话首次使用 MediaClaw 时都会检查官方 Agent 版本。发现新版后，Agent 会先请求授权，再自动刷新 marketplace、更新接入包并创建加载新版的新会话继续原任务。正常情况下不需要用户手动运行以下命令。

如果自动升级失败，可让 Agent 报告失败阶段。宿主实际执行的固定命令为：

Codex：

```bash
codex plugin marketplace upgrade mediaclaw-agent
```

WorkBuddy：

```bash
codebuddy plugin marketplace update mediaclaw-agent
codebuddy plugin update mediaclaw@mediaclaw-agent
```

升级必须经过用户明确授权。新版任务启动时会自动替换仍存活的旧版共享 Broker，并复用已有设备批准；除非协议确实不兼容，否则不需要重新配对。

## 第三步：批准连接

1. 在新会话中说：“检查 MediaClaw 连接状态。”
2. 打开 MediaClaw 浏览器插件 → 设置 → Agent 接管。
3. 开启“允许本机 Agent 调用”。
4. 核对当前 Agent 名称，在待确认列表中点击“批准”。
5. 回到 Agent，再次说：“检查 MediaClaw 连接状态，并告诉我现在能做什么。”

每个 Agent 需要分别批准。撤销其中一个不会影响其他已经批准的 Agent。

## 常见问题

### 安装后没有检测到 Agent

- 确认安装完成后创建了全新的 Agent 会话。
- 确认 MediaClaw 浏览器插件已经开启。
- 回到 Agent 再次要求它检查连接状态。
- 如果仍未连接，让 Agent 报告具体安装状态和错误信息，不要反复重装。

### 一直显示等待批准

打开浏览器插件的“Agent 接管”，检查待确认列表并批准当前 Agent。不要把激活码、Cookie、Token 或任何本机令牌发给 Agent。

### 采集过程中要求处理浏览器

登录失效、验证码、平台限制或页面异常时，MediaClaw 可能暂停任务。按浏览器中的提示处理后，再让 Agent 查询原任务状态。

### 为什么有些能力不能使用

Agent 接管需要有效会员；逐字稿等计费能力还需要足够积分和执行前确认。平台登录状态、页面状态和安全限制也可能影响任务。让 Agent 说明缺少的条件和最小下一步，不要让它尝试绕过插件提示。

## 卸载

先在 MediaClaw 浏览器插件的“Agent 接管”中撤销对应 Agent，再使用 Codex 或 WorkBuddy 自己的插件管理入口卸载 MediaClaw。
