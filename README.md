# AI 网页翻译（Chrome 插件）

用大模型翻译网页，默认使用 DeepSeek，支持任意 OpenAI 兼容 / Anthropic 兼容接口。

## 功能

- **自动识别网页语言**作为原文语言（也可在弹窗中手动指定）；译文语言由你选择并自动记住
- **双语对照 / 仅显示译文**两种显示方式，随时切换（快捷键 `Alt+S`）
- **只翻译可见区域**：滚动到哪翻译到哪，动态加载的内容也会翻译
- **多种触发方式**：弹窗按钮、页面悬浮按钮、快捷键 `Alt+A`、右键菜单、指定网站自动翻译
- **划词翻译**：选中文字后点击“译”图标（可改为直接翻译或关闭）
- **自定义模型**：可添加多个模型配置并随时切换，支持额外请求参数和自定义翻译要求

## 安装

1. 打开 `chrome://extensions`
2. 打开右上角“开发者模式”
3. 点击“加载已解压的扩展程序”，选择本项目根目录（包含 `manifest.json` 的目录）
4. 首次安装会自动打开设置页

## 配置 DeepSeek

1. 在 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 创建 API Key
2. 设置页 → 模型配置 → 选中 “DeepSeek” → 填入 API Key → 保存
3. 点击“测试连接”，看到日语示例被翻译即成功

模型名称默认 `deepseek-chat`，如 DeepSeek 更新了模型名，在设置页修改即可。

## 接入其他模型

设置页左下角选择模板后点“新增”：

| 服务 | 协议 | Base URL 示例 |
| --- | --- | --- |
| DeepSeek | OpenAI | `https://api.deepseek.com` |
| DeepSeek | Anthropic | `https://api.deepseek.com/anthropic` |
| OpenAI | OpenAI | `https://api.openai.com/v1` |
| Claude | Anthropic | `https://api.anthropic.com` |
| 通义千问 | OpenAI | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Kimi | OpenAI | `https://api.moonshot.cn/v1` |
| 智谱 GLM | OpenAI | `https://open.bigmodel.cn/api/paas/v4` |
| Ollama 本地 | OpenAI | `http://localhost:11434/v1` |

地址填写规则：OpenAI 协议自动补 `/chat/completions`，Anthropic 协议自动补 `/v1/messages`，设置页会显示实际请求地址。

- **Ollama**：需要允许插件访问，启动前设置环境变量 `OLLAMA_ORIGINS=chrome-extension://*`
- **额外请求参数**：JSON 会合并进请求体，例如关闭思考模式 `{"thinking":{"type":"disabled"}}`（具体参数以服务商文档为准）

## 数据与隐私

- API Key 只保存在本机（`chrome.storage.local`），不会跨设备同步，网页脚本无法读取
- 普通偏好（译文语言、显示方式、自动翻译网站等）通过 `chrome.storage.sync` 随 Chrome 账号同步
- 页面文字会发送给你配置的模型服务商进行翻译

## 已知限制

- 只翻译顶层页面，不翻译 iframe 内的内容
- `chrome://`、Chrome 应用商店等浏览器内置页面无法翻译
- “仅显示译文”模式会把译文写回原有的文本节点以保留链接；如果模型丢失了格式标记，整段译文会放进第一个节点

## 开发

```
node --test tests/llm.test.js   # 大模型调用层单元测试（模拟服务端，不产生费用）
python3 scripts/make_icons.py   # 重新生成图标（需要 Pillow）
```

目录结构：

```
manifest.json
src/shared/       语言表、默认配置与存储（各处共用）
src/background/   service worker 与大模型调用（llm.js）
src/content/      页面脚本：段落提取、懒翻译、渲染、悬浮按钮、划词
src/popup/        工具栏弹窗
src/options/      设置页
```
