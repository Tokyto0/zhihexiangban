# 知禾乡伴 | 农文旅知识产权助手 AI

这是第八届 AIC 算法大赛“AI+开源”方向的 MVP。产品面向农文旅小微经营者，把项目材料整理为要素、知识产权线索、可核验的公开证据、风险初筛和行动清单。

当前开发交接状态见 [`docs/STATUS.md`](docs/STATUS.md)。

当前版本优先保证本地、离线、可复现的完整演示：前端使用 React + Vite + TypeScript，后端提供无第三方依赖的本地 HTTP API，Mock provider 负责稳定输出。DeepSeek Flash 已作为后端可选 provider 接入，只有在项目级外发同意、脱敏检查和预算闸门通过后才会调用。

## 已完成的 MVP 闭环

- 项目档案首页：项目身份、材料 → 要素 → 证据 → 风险 → 报告纵向进度、优先风险和最近档案条目；
- 材料库：真实 API 拖拽/选择上传，显示上传进度、解析状态、失败重试、来源和授权缺失；
- 要素确认：项目、品牌、产品、地点、活动、视觉元素和素材来源可编辑、确认或标记待核验；
- 分析工作台：商标、版权、地理标志三类线索，Mock 检索与风险规则阶段状态；
- 检索中心：名称、地域和产品类别线索，显示匹配原因和证据抽屉；
- 风险清单：风险等级、触发因素、证据和行动建议可人工修改；
- 报告中心：保留 AI 基线，导出脱敏 Markdown / JSON；
- 设置与开放：Mock provider、seed-v1、预算和外发控制、第三方资源清单；
- 分析工作台内嵌农文旅知识产权专家问答：按商标、作品/素材授权、地理标志和保密边界识别问题，先召回项目材料与版本化知识库，再分开展示证据事实、初步判断、待核验事项和下一步行动；
- `/ask` 使用 `evidence-answer-v1` 提示词，返回 token usage、估算/实际成本、价格版本、预算状态和证据覆盖校验；事实与判断逐条绑定可点击来源 ID，缺少合法证据的模型输出会被拦截；
- 后端 API：健康检查、项目 CRUD、材料上传/删除、解析任务重试、Mock/DeepSeek 分析、项目级检索与 `/ask` 问答、要素/风险人工编辑、任务状态、报告生成与导出；`/qa` 暂作为兼容别名保留。

## 本地启动

需要 Node.js 20+ 和 Python 3.11+。API 默认使用 `MODEL_PROVIDER=mock`，不需要 API Key。

```powershell
Copy-Item .env.example .env
npm install
python backend/run.py
```

启用 DeepSeek 时，只在本机 `.env` 中设置 `MODEL_PROVIDER=deepseek`、`DEEPSEEK_API_KEY` 和服务端总开关 `EXTERNAL_LLM_ALLOWED=true`。不要把真实 Key 写入前端、浏览器、日志、报告或 Git。项目还必须在设置中明确开启 `external_allowed` 和项目级外发同意；否则后端会阻断请求并继续使用 Mock。

另开一个终端启动前端：

```powershell
npm run dev
```

打开 <http://localhost:5173>，API 健康检查地址为 <http://localhost:8000/api/v1/health>。

也可以使用 Docker Compose：

```powershell
docker compose up
```

## 固定命令

```text
make dev              # 启动本地 API
make db-migrate       # MVP 使用本地 JSON store，迁移接口预留
make seed             # 生成 seed-v1 演示清单
make test             # 离线契约回归
make test-e2e         # 浏览器验收提示
make eval             # 输出三案例离线评测结果
make license-check    # 查看第三方资源清单
make clean-demo       # 删除本地演示数据
```

PowerShell 也可以直接运行：

```powershell
python scripts/test_mvp.py
python scripts/test_api_contract.py
python scripts/seed_demo.py
python scripts/eval_mvp.py
python scripts/import_knowledge_base.py --version local-v2
# 仅在明确允许外部调用时执行；默认只发送合成测试字段
python scripts/test_deepseek_controlled.py --confirm-external
```

## 三个固定案例

案例位于 `data/seeds/examples/`：

- `brand/`：农产品品牌与茶旅路线；
- `tourism-event/`：乡村采茶节活动；
- `intangible-culture/`：非遗竹编技艺档案。

每个案例包含脱敏 `input.md` 和最小断言 `expected.json`。案例输入不包含个人信息、密钥或受限制的原文。

## 隐私与模型边界

- 默认 `privacy_level=local_only`，材料只用于当前项目；
- 图片首版只保存文件元数据和人工补录线索，不做视觉语义分析，也不把原图发送给外部模型；
- DeepSeek 仅作为可选 provider，endpoint、模型名、Key 和预算由后端环境配置，前端不接收 Key；
- 所有结论都带证据或明确标记信息不足，并显示“本结果仅用于信息整理和风险初筛，不构成法律意见”；
- Markdown 报告遵循项目约定：行内公式使用 `$...$`，块公式使用 `$$...$$`，不使用 LaTeX 圆括号或方括号定界符。

## 代码结构

```text
frontend/                 # React + Vite + TypeScript 工作区
  src/App.tsx             # 路由式档案页面与后端状态同步
  src/api.ts              # VITE_API_BASE_URL 可配置的统一 API client
  src/mock.ts             # 固定案例数据
  src/styles.css          # 自然可信型桌面优先视觉系统
backend/
  app/main.py             # 本地 API、JsonStore、Mock 分析与报告
  run.py                  # API 启动入口
data/
  source_registry/        # 来源登记样例
  seeds/knowledge/        # seed-v1 知识库样例
  seeds/examples/         # 三个固定演示案例
scripts/                  # seed、评测、回归和清理脚本
```

## 已知限制

当前后端为便于学生团队离线复现而实现的标准库 HTTP API，不依赖 FastAPI 或数据库；前端项目、材料、分析、检索问答和报告已经通过 API 同步并保存到 `data/mvp_store.json`。项目级检索默认只查询当前案卷和已配置的本地 JSONL 知识库，不冒充实时官方检索；上传解析仍由本地 Mock 完成，DOCX/PDF 需要通过显式导入脚本整理，导入条目默认保持 `pending_manual_review`。DeepSeek 在线调用已经具备 endpoint 白名单、JSON 输出、外发同意、脱敏、预算和 usage 记录；正式部署仍需重新核验价格和服务条款。

## 本地知识库导入

`scripts/import_knowledge_base.py` 会读取 `知识库/` 下的 DOCX/PDF，提取文本、按约 800 个中文字符分块，并在写入 JSONL 前脱敏 API Key、邮箱、手机号和身份证号。原始文件保持只读，生成的 `data/processed/knowledge/` 不纳入 Git；来源许可状态默认标记为 `pending_manual_review`，不能直接当作公开数据集发布。

导入后，在本机 `.env` 指向生成的快照并重启后端：

```powershell
KNOWLEDGE_BASE_VERSION=local-v2
KNOWLEDGE_BASE_PATH=./data/processed/knowledge/knowledge-local-v2.jsonl
SOURCE_REGISTRY_PATH=./data/processed/knowledge/sources-local-v2.jsonl
```

项目级检索和问答会将本地知识库条目作为带版本的候选证据；条目仍显示待核验状态，不会被包装成官方结论。
