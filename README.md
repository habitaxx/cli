# 栖界开放平台 CLI

`@habitaxx/cli` 使用设备授权流程连接栖界开放平台。用户在浏览器中登录并选择项目、权限和能力，CLI 随后将该域的独立 API Key 安全保存到本机。

## 安装

全局安装（或本地运行）：

```bash
npm install -g @habitaxx/cli
```

本地仓库调试可直接执行：

```bash
node sdk/cli/bin/habitaxx.js --help
```

运行环境要求 Node.js 18.17 或更高版本。

## 登录与设备授权

```bash
habitaxx auth init
```

命令执行步骤：

1. 创建一个 10 分钟有效的设备授权请求；
2. 自动打开浏览器引导授权：`https://platform.habitaxx.com/auth?code=XXXX-XXXX`；
3. 等待用户在开放平台页面审批；
4. 将该域的授权凭据安全写入本地 `~/.habitaxx/auth.json`。

API Key 绝不会显示在浏览器或终端输出中。本地凭据目录权限严格限定为 `0700`，文件权限为 `0600`。

精细化限制授权范围示例（按能力标识申请）：

```bash
habitaxx auth init \
  --scope capabilities:read,tasks:write \
  --ability <capability-key>
```

## 查看与管理授权状态

```bash
# 查看当前域授权信息
habitaxx auth status

# 在线向网关验证凭据是否有效
habitaxx auth status --check

# 以安全脱敏 JSON 输出
habitaxx auth status --json

# 退出当前域登录（删除本地凭据）
habitaxx auth logout

# 清空全部域的本地登录信息
habitaxx auth logout --all
```

`auth logout` 仅清理本地保存的凭据，不会直接撤销开放平台远端的 API Key。若凭据遗失或弃用，请前往开放平台控制台进行吊销。

## 调用平台能力

CLI 自动在内存中完成 API Key 到短效 Access Token 的置换，请求网关时统一携带 Bearer Token 并注入 `X-Client-Type: open_platform` 请求头。

### 1. 通用接口请求 (`habitaxx request`)

```bash
# 获取开放平台可用能力清单
habitaxx request GET /capabilities

# 发起智能问诊会话
habitaxx request POST /ms-ai-fast/session-records/sessions \
  --data '{"module_type":1,"pet_profile_id":78,"content":"狗狗食欲不振并且嗜睡"}'

# 鸟类多模态识别 (Multipart 表单)
habitaxx request POST /bird/detect \
  --form file=@/path/to/bird.jpg
```

### 2. 鸟类识别快捷命令 (`habitaxx bird detect`)

```bash
habitaxx bird detect --file /path/to/bird.jpg
```

### 3. 智能项圈 IMU 行为预测 (`habitaxx imu predict`)

```bash
# 传入样本数据进行预测
habitaxx imu predict --data @samples.json --top-k 5

# 指定设备标识进行预测
habitaxx imu predict --data @samples.json --device 001
```

`samples.json` 数据结构示例：
```json
{
  "samples": [
    [-0.32, -0.49, -0.65, -32.21, -21.96, 1.33],
    [-0.31, -0.48, -0.64, -31.50, -21.20, 1.25]
  ],
  "top_k": 5
}
```

## 环境变量说明

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `HABITAXX_PLATFORM_URL` | `https://platform.habitaxx.com` | 控制台前端页面地址 |
| `HABITAXX_PLATFORM_API_URL` | `<platform-url>/api/v1` | 控制面后端 API 接口地址 |
| `HABITAXX_API_BASE_URL` | `https://open-api.habitaxx.com/v1` | 开放能力网关基础路径 |
| `HABITAXX_AUTH_FILE` | `~/.habitaxx/auth.json` | 本地凭据存储路径 |

## Agent Skill 集成

官方配套的 Agent Skill 提供了公网和本地两种安装接入方式：

```bash
# 方式一：公网在线安装（推荐）
npx skills add habitaxx/skills --skill habitaxx-skill
# 或通过 npm 在线引入
npx skills add @habitaxx/skill

# 方式二：本地仓库目录安装
npx skills add ./sdk/habitaxx-skill
```

该 Skill 借助 CLI 统一调度平台能力，无需让 AI Agent 直接接触原始密钥凭据，确保运行安全。
