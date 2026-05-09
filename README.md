# pi-ace-tool

`pi-ace-tool` 是一个原生 TypeScript pi 扩展，参考 [ace-tool-rs](https://github.com/missdeer/ace-tool-rs) 的代码库索引、语义检索和提示词增强思路，为 pi 提供 Augment 兼容的代码库语义搜索能力。

核心能力：

- 注册 pi 原生工具：`search_context`
- 自动扫描、分块、索引当前项目
- 只上传新增或变更代码块到 Augment 兼容 API
- 通过远程语义检索返回相关代码上下文
- 提供 `/ace-enhance` 显式提示词增强命令
- 支持官方 Augment `/prompt-enhancer` 和 pi 已配置模型增强

> 安全提示：`search_context` 和带代码库上下文的 `/ace-enhance --context` 可能会上传项目代码块到你配置的远程 API。首次使用前建议运行 `/ace-init` 生成推荐忽略规则，并确认 `.env`、密钥、证书等敏感文件不会被索引。

---

## 功能特性

### 语义代码库搜索

- `search_context`：使用自然语言查询项目实现、调用链、功能流程
- 默认使用 pi 当前工作目录作为项目根目录
- 支持 `project_root_path` 参数覆盖项目根目录
- 遵守根目录 `.gitignore` 和 `.aceignore`（常用 gitignore 子集）
- 默认额外排除 `.pi/`，避免上传扩展配置和 token

### 增量索引与上传

- 本地缓存：`.ace-tool/index.json`
- 记录文件 `mtime`、`mtimeNs`、size、blob hashes
- 低精度 mtime 场景自动回退 hash 校验，避免漏掉变更
- 只处理新增、修改、删除的文件
- 自适应上传策略：参考 ace-tool-rs AIMD 思路动态调整并发和超时

### pi 原生体验

- `/ace-config` 中文交互式配置菜单
- `/ace-status` 直观状态面板
- `/ace-init` 初始化推荐 `.aceignore` / `.gitignore`
- `/ace-index` 手动预索引
- `/ace-clear-index` 清除本地索引缓存
- 工具执行时显示轻量动态 spinner、阶段、耗时和统计信息
- `/ace-enhance` 执行时显示临时等待面板，直观展示模式、模型、上下文开关、耗时和当前阶段
- 搜索结果会提取可能相关文件路径，展开时优先展示

### 提示词增强

`/ace-enhance` 是显式命令，不默认暴露 `enhance_prompt` agent 工具，避免模型误调用。

支持两种模式：

1. `official`
   - 调用 Augment 兼容接口：`POST /prompt-enhancer`
   - 需要 `ACE_TOOL_BASE_URL` 和 `ACE_TOOL_TOKEN`

2. `pi-model`
   - 使用 pi 中已经配置好的文本模型
   - 复用 pi 的鉴权、请求头、Provider、代理和自定义模型
   - 不直接维护第三方模型 API key

可选开启代码库上下文注入：

```text
/ace-enhance --context 重构登录认证流程，统一 token refresh
```

默认关闭，避免无感索引、上传和额外延迟。

---

## 安装

### 通过 GitHub 安装

```bash
pi install https://github.com/justhil/pi-ace-tool
```

或临时加载测试：

```bash
pi -e https://github.com/justhil/pi-ace-tool
```

### 项目级安装

在目标项目的 `.pi/settings.json` 中添加：

```json
{
  "packages": [
    "https://github.com/justhil/pi-ace-tool"
  ]
}
```

### 本地开发加载

```bash
git clone https://github.com/justhil/pi-ace-tool.git
cd pi-ace-tool
npm install
pi -e .
```

---

## 快速开始

1. 重新加载扩展：

```text
/reload
```

2. 初始化忽略规则：

```text
/ace-init
```

3. 配置 API：

```text
/ace-config
```

至少配置：

- `ACE_TOOL_BASE_URL`
- `ACE_TOOL_TOKEN`

4. 查看状态：

```text
/ace-status
```

5. 可选预索引：

```text
/ace-index
```

之后 agent 在需要语义代码库搜索时可以调用 `search_context`。

---

## 配置

推荐使用：

```text
/ace-config
```

配置会保存到：

- 项目级：`.pi/ace-tool.json`
- 全局级：`~/.pi/agent/ace-tool.json`

也可以直接进入指定范围：

```text
/ace-config project
/ace-config global
/ace-config clear
```

优先级：

```text
环境变量 > 项目配置 > 全局配置 > 默认值
```

### 环境变量

```bash
export ACE_TOOL_BASE_URL="https://your-augment-api.example.com"
export ACE_TOOL_TOKEN="your-token"
```

### 配置表

| 配置文件字段 | 环境变量 | 默认值 | 说明 |
|---|---|---:|---|
| `baseUrl` | `ACE_TOOL_BASE_URL` | 必填 | Augment 兼容 API Base URL |
| `token` | `ACE_TOOL_TOKEN` | 必填 | API Token |
| `maxLinesPerBlob` | `ACE_TOOL_MAX_LINES_PER_BLOB` | `800` | 每个代码块最多行数 |
| `retrievalTimeoutSecs` | `ACE_TOOL_RETRIEVAL_TIMEOUT_SECS` | `60` | 检索和官方提示词增强请求超时 |
| `uploadTimeoutSecs` | `ACE_TOOL_UPLOAD_TIMEOUT_SECS` | `30` | 上传批次基础超时 |
| `uploadConcurrency` | `ACE_TOOL_UPLOAD_CONCURRENCY` | 自动 | 上传并发度覆盖；建议默认自动 |
| `maxFileBytes` | `ACE_TOOL_MAX_FILE_BYTES` | `131072` | 单文件最大索引大小，默认 128KB |
| `maxBatchBytes` | `ACE_TOOL_MAX_BATCH_BYTES` | `1048576` | 单上传批次最大大小，默认 1MB |
| `indexDirName` | `ACE_TOOL_INDEX_DIR` | `.ace-tool` | 本地索引目录 |
| `indexFileName` | `ACE_TOOL_INDEX_FILE` | `index.json` | 本地索引文件 |
| `allowHttp` | `ACE_TOOL_ALLOW_HTTP` | `false` | 是否允许 `http://` base URL |
| `autoIndexOnSessionStart` | `ACE_TOOL_AUTO_INDEX_ON_SESSION_START` | `false` | session 启动时后台预索引，默认关闭 |
| `promptEnhancerMode` | `ACE_TOOL_PROMPT_ENHANCER_MODE` | `official` | `official` 或 `pi-model` |
| `promptEnhancerModel` | `ACE_TOOL_PROMPT_ENHANCER_MODEL` | 当前会话模型 | `pi-model` 模式下使用的 pi 模型，格式 `provider/modelId` |
| `promptEnhancerIncludeSearchContext` | `ACE_TOOL_PROMPT_ENHANCER_INCLUDE_SEARCH_CONTEXT` | `false` | 增强前是否注入 `search_context` 代码库上下文 |

---

## 工具

### `search_context`

参数：

```ts
{
  query: string;
  project_root_path?: string;
}
```

示例：

- `Where is the function that handles user authentication?`
- `What tests are there for the login functionality?`
- `Find the initialization flow of message queue consumers. Keywords: mq consumer init, subscribe`

建议：

- 不知道代码在哪时，优先使用 `search_context`
- 已知标识符精确查找、列出所有引用、读取具体文件时，继续使用 pi 内置 `grep` / `read` / `find`

---

## 命令

| 命令 | 说明 |
|---|---|
| `/ace-config` | 打开中文配置菜单 |
| `/ace-config project` | 进入项目级 `.pi/ace-tool.json` 配置 |
| `/ace-config global` | 进入全局 `~/.pi/agent/ace-tool.json` 配置 |
| `/ace-config clear` | 删除项目级或全局配置 |
| `/ace-status` | 显示状态面板：配置、配置来源、本地索引状态 |
| `/ace-status <path>` | 显示指定项目路径的索引状态 |
| `/ace-init` | 初始化推荐 `.aceignore` / `.gitignore` 安全忽略项 |
| `/ace-init <path>` | 对指定项目路径执行初始化 |
| `/ace-index` | 只执行索引/上传，不进行搜索 |
| `/ace-index <path>` | 对指定项目路径执行预索引 |
| `/ace-clear-index` | 删除当前项目索引缓存，不立即重建 |
| `/ace-clear-index <path>` | 删除指定项目路径的索引缓存 |
| `/ace-enhance` | 增强当前输入框内容，审阅后放回输入框 |
| `/ace-enhance <prompt>` | 增强指定提示词 |
| `/ace-enhance --context <prompt>` | 本次增强强制注入代码库上下文 |
| `/ace-enhance --no-context <prompt>` | 本次增强强制不注入代码库上下文 |
| `/ace-enhance --send <prompt>` | 审阅后直接作为用户消息发送给 agent |

---

## 与 ace-tool-rs 的差异

- 不实现 MCP stdio server，直接注册 pi 原生工具和命令
- `search_context` 主链路对齐 ace-tool-rs，但本地缓存使用 JSON，不兼容 Rust 版 bincode `index.bin`
- 提示词增强做成显式 `/ace-enhance` 命令，不默认暴露 `enhance_prompt` agent 工具
- 第三方模型增强调用 pi 原生模型系统，而不是在扩展里直接维护第三方 API key
- 上传策略实现了 TypeScript 版自适应并发/超时，但细节不保证与 Rust 版完全一致
- ignore 规则为常用 gitignore 子集，不保证 100% 等价
- 默认额外排除 `.pi/`，避免把本扩展配置和 token 纳入索引

---

## 开发

```bash
npm install
npm run typecheck
```

本地 smoke test：

```bash
npx tsc --outDir .tmp-build
node --input-type=module -e "import ext from './.tmp-build/index.js'; const c={tools:[],commands:[],events:[]}; ext({registerTool:t=>c.tools.push(t.name),registerCommand:n=>c.commands.push(n),on:n=>c.events.push(n)}); console.log(c)"
rm -rf .tmp-build
```

---

## License

MIT
