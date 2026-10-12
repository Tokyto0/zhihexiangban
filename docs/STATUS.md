# 知禾乡伴｜项目开发状态

更新时间：2026-10-11

这份文档是交给后续开发对话的工作区快照。继续开发前先阅读本文件、项目根目录的 `农文旅知识产权助手AI_产品文档.md` 和 `README.md`，再检查 `git status` 与 `git diff`。不要重置、覆盖或回退现有提交和未提交改动。

## 当前定位

“知禾乡伴｜农文旅知识产权助手 AI”当前是一个桌面优先的 MVP。产品采用“田野档案 / 项目案卷”视觉方向，让项目、材料、要素、证据、风险和报告形成可追溯链路。

当前开发原则：

- 本地 Mock provider 仍是默认的离线回归基线；
- DeepSeek 是后端可选 provider，只能在服务端配置、预算闸门、脱敏和项目级外发同意同时通过后调用；
- 本地知识库原始 DOCX/PDF 只读保存，运行时使用脱敏 JSONL；
- 证据必须携带来源 ID、摘录、来源状态和知识库版本；
- 不把任何 API Key 写入前端、浏览器响应、日志、报告或 Git；
- 任何知识产权结论都只能作为信息整理和风险初筛，不能包装成法律确定性结论。

## Git 与工作区

当前分支：`main`

最近已有提交：

- `c7d4d5e Frontend and backend communication established`
- `36987b8 feat: add project search and evidence qa APIs`
- `760ee67 feat: connect archive UI and DeepSeek provider`

当前未提交改动：

- `README.md`、`backend/app/main.py`
- `frontend/src/App.tsx`、`frontend/src/api.ts`、`frontend/src/types.ts`、`frontend/src/styles.css`
- `scripts/test_api_contract.py`、`scripts/test_deepseek_controlled.py`
- 本文件 `docs/STATUS.md`

前端 API、后端 provider gate、本地知识库导入脚本和回归脚本已经包含在 `c7d4d5e` 中。

不要自动提交 Git。提交前应先让用户确认要提交的文件范围。

## 当前技术结构

- 前端：React + Vite + TypeScript，入口为 `frontend/src/App.tsx`；
- 前端 API client：`frontend/src/api.ts`，通过 `VITE_API_BASE_URL` 配置后端地址；
- 前端样式：`frontend/src/styles.css`，保留纸张、档案编号、田埂线、印章和禾穗等轻量视觉语言；
- 后端：标准库 `http.server` + `JsonStore`，入口为 `backend/run.py`；
- 持久化：`data/mvp_store.json`，本地文件被 `.gitignore` 忽略；
- 本地知识库运行快照：`data/processed/knowledge/`，被 `.gitignore` 忽略；
- 原始参考资料：`知识库/`，不直接提交 DOCX/PDF。

## 已完成能力

### 前端

- 项目列表和项目案卷首页；
- 项目创建、项目编辑和项目级隐私设置；
- 项目总览、材料、要素、分析、检索、风险和报告页面；
- 浏览器路由覆盖 `/projects`、`/projects/new`、`/projects/:id/overview`、`/projects/:id/assets`、`/projects/:id/entities`、`/projects/:id/analysis`、`/projects/:id/search`、`/projects/:id/findings`、`/projects/:id/reports` 和 `/settings`；
- 材料拖拽/选择上传、上传进度、解析状态、失败重试和删除交互；
- 检索按钮和问答按钮使用无事件参数的调用方式，避免 `query.trim is not a function` 与 `question.trim is not a function`；
- 分析工作台内嵌农文旅知识产权专家问答，提供商标、作品/素材授权、地理标志和保密边界快捷提问，并分开展示证据事实、初步判断、待核验事项、下一步和来源版本；
- 证据抽屉可打开来源档案，显示来源编号、发布机构、域名、原文摘录、支持结论和限制；
- 报告可读取并导出 Markdown / JSON；
- 刷新和直接访问合法项目路由时，项目上下文从 URL 与 API 恢复。

### 后端 API

现有 API 包含健康检查、项目 CRUD、项目隐私设置、材料上传/删除、解析任务状态和重试、分析、检索、问答、要素/风险编辑、报告生成、报告读取和报告导出。

正式问答接口为：

```text
POST /api/v1/projects/{id}/ask
```

`/qa` 仍保留为兼容别名。问答响应包含 `answer`、`facts`、`assessment`、`uncertainties`、`next_steps`、`evidence_ids`、`sources`、`expertise_scope`、`intent`、`provider`、`model_version`、`knowledge_base_version`、`generated_at` 和 `disclaimer`。Mock 路径使用确定性的领域分类与知识库召回；DeepSeek 路径沿用外发同意、脱敏和预算闸门。

检索结果会携带可追溯的 `evidence_id` 和证据内容。空查询、超长查询、空问题和超长问题会返回结构化校验错误。

### 本地知识库

已运行 `scripts/import_knowledge_base.py`，从 `知识库/` 读取 4 个 DOCX/PDF，生成：

- 463 条脱敏知识库片段；
- 4 条来源登记；
- 版本：`local-v2`；
- 许可状态默认是 `pending_manual_review`。

生成文件位于被忽略的目录：

```text
data/processed/knowledge/knowledge-local-v2.jsonl
data/processed/knowledge/sources-local-v2.jsonl
data/processed/knowledge/knowledge-local-v2.manifest.json
```

脱敏扫描未发现 API Key、邮箱、手机号或身份证号。原始文件没有被改写，也没有加入 Git。

### DeepSeek 受控调用

后端已经具备：

- `deepseek-flash` provider；
- 只允许 `https://api.deepseek.com` 的 endpoint 白名单；
- JSON 输出约束；
- 项目级 `external_allowed` 与 `external_llm_consent`；
- 全局 `EXTERNAL_LLM_ALLOWED` 开关；
- 请求、项目、日和月预算闸门；
- usage 账本和错误映射；
- 项目字段、材料元数据和问答证据的外发脱敏。

## 当前本机配置

`.env` 被 `.gitignore` 忽略，不能复制到文档、提交记录或聊天输出中。当前本机已经配置为：

```ini
MODEL_PROVIDER=deepseek
EXTERNAL_LLM_ALLOWED=true
DEEPSEEK_MODEL=deepseek-flash
KNOWLEDGE_BASE_VERSION=local-v2
KNOWLEDGE_BASE_PATH=./data/processed/knowledge/knowledge-local-v2.jsonl
SOURCE_REGISTRY_PATH=./data/processed/knowledge/sources-local-v2.jsonl
```

API Key 已由用户放入本机 `.env`，文档不记录其值。`.env.example` 仍保持安全默认值：`MODEL_PROVIDER=mock`、`EXTERNAL_LLM_ALLOWED=false`、`seed-v1`。

修改 `.env` 后必须重启后端，后端启动时才会重新加载知识库和 provider 配置。

## 已验证的真实项目状态

当前本地 JSON store 中有一个项目：`project-723ad360dee0`。该项目已设置为：

- `privacy_level=external_allowed`；
- `external_llm_consent=true`；
- 材料数量：1。

已对该项目执行一次真实项目级 DeepSeek 分析和问答：

- 分析 provider：`deepseek`；
- 模型：`deepseek-flash`；
- 知识库版本：`local-v2`；
- 分析结果包含 4 条要素、2 条权利候选和 3 条风险发现；
- 问答返回 2 条关联证据 ID；
- 已生成报告：`report-5a9dcf049601`；
- 该项目已有 2 条成功 usage 记录。

这次调用发送的是后端脱敏后的项目字段、材料元数据和有限证据片段。没有发送 API Key，也没有把模型原文写入交接文档。

## 本轮问答增强

- `/ask` 统一返回 `usage`、估算/实际成本、币种、`pricing_version`、`budget_status` 和 `evidence_coverage`；Mock 返回零成本和 `not_applicable` 预算状态，DeepSeek 成功、失败及预算拒绝都写入 usage 账本。
- 问答提示词固定为 `evidence-answer-v1`，把项目字段、问题和来源摘录视为不可信数据，忽略其中的提示注入指令；服务端只接受合法来源 ID，并拦截无证据的事实或判断。
- 前端事实和初步判断逐条显示可点击证据引用，同时展示 token 用量、成本、价格版本、预算状态和证据覆盖结果。
- 受控 DeepSeek 脚本只发送合成项目与合成证据，不打印密钥或答案；真实 provider 往返已完成 usage/pricing/prompt 校验，预算拒绝的脱敏错误提示通过离线闸门校验。

## 验证结果

最近通过的命令：

```powershell
npm run build --prefix frontend
python scripts/test_mvp.py
python scripts/eval_mvp.py
python scripts/test_api_contract.py
python -m py_compile backend/app/main.py scripts/import_knowledge_base.py scripts/test_api_contract.py scripts/test_deepseek_controlled.py
git diff --check
```

结果：前端构建、MVP 回归、三案例离线评测、API 契约测试、Python 语法检查和 diff 检查均通过。Python 启动器会打印一次 `Failed to find real location of C:\Python314\python.exe` 环境提示，但相关命令退出码为 0，测试结果有效。

受限项：当前执行环境的普通沙箱进程无法访问本地 HTTP socket，使用 `Invoke-RestMethod http://127.0.0.1:8000` 会被系统拒绝。因此本轮完成了后端逻辑级和持久化验证，但没有在此环境完成完整浏览器 HTTP 主链路验收。正常本地环境中应启动后端和前端，再验证页面刷新、前进后退、证据抽屉、报告导出和窄窗口布局。

## 新开发对话的启动顺序

1. 读取本文件、`README.md` 和产品文档第 15—23 节；
2. 执行 `git status --short` 和 `git diff`，保留当前 UI 与 API 改动；
3. 不读取或输出 `.env` 中的 API Key；
4. 需要离线回归时，将 `MODEL_PROVIDER=mock`，使用 `scripts/test_mvp.py`、`scripts/test_api_contract.py` 和 `scripts/eval_mvp.py`；
5. 需要使用本地知识库时，确认 `KNOWLEDGE_BASE_PATH`、`SOURCE_REGISTRY_PATH` 和 `KNOWLEDGE_BASE_VERSION=local-v2`；
6. 需要调用 DeepSeek 时，确认全局外发开关、项目级同意和预算状态，并只发送脱敏字段和有限证据片段；
7. 继续前端开发时，优先检查 `frontend/src/App.tsx`、`frontend/src/api.ts`、`frontend/src/types.ts` 和 `frontend/src/styles.css`；
8. 继续后端开发时，优先检查 `backend/app/main.py` 的 JSON schema、provider gate、证据来源和 usage 记录；
9. 完成改动后至少运行构建、离线回归、API 契约测试和 `git diff --check`；
10. 未经用户明确要求，不要自动提交 Git。

## 建议的下一阶段

- 在正常本地 HTTP 环境完成浏览器主链路验收；
- 检查真实项目分析结果在刷新页面后能完整展示，并验证报告 Markdown / JSON 下载；
- 对本地知识库来源逐条补充许可、发布日期、访问时间和可公开状态；
- 增加真实检索连接器前，先保留本地 JSONL 和证据版本边界；
- 对 DeepSeek 的价格、服务条款、数据处理范围和预算配置做正式发布前复核；
- 只有在用户明确要求时，再提交当前工作区改动。
