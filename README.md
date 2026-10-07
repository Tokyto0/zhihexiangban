# 知禾乡伴 | 农文旅知识产权助手 AI

这是第八届 AIC 算法大赛“AI+开源”方向的 MVP。产品面向农文旅小微经营者，把项目材料整理为要素、知识产权线索、可核验的公开证据、风险初筛和行动清单。

当前版本优先保证本地、离线、可复现的完整演示：前端使用 React + Vite + TypeScript，后端提供无第三方依赖的本地 HTTP API，Mock provider 负责稳定输出。后续可以把 `JsonStore` 替换为 FastAPI + PostgreSQL/pgvector，并在项目明确同意、脱敏和预算通过后接入 DeepSeek Flash。

## 已完成的 MVP 闭环

- 项目总览：项目状态、四阶段进度、风险摘要和项目内问答入口；
- 材料库：拖拽/选择上传，显示解析状态、来源和授权缺失；
- 要素确认：项目、品牌、产品、地点、活动、视觉元素和素材来源可编辑、确认或标记待核验；
- 分析工作台：商标、版权、地理标志三类线索，Mock 检索与风险规则阶段状态；
- 检索中心：名称、地域和产品类别线索，显示匹配原因和证据抽屉；
- 风险清单：风险等级、触发因素、证据和行动建议可人工修改；
- 报告中心：保留 AI 基线，导出脱敏 Markdown / JSON；
- 设置与开放：Mock provider、seed-v1、预算和外发控制、第三方资源清单；
- 后端 API：健康检查、项目 CRUD、材料上传/删除、Mock 分析、任务状态、报告生成与导出。

## 本地启动

需要 Node.js 20+ 和 Python 3.11+。API 默认使用 `MODEL_PROVIDER=mock`，不需要 API Key。

```powershell
Copy-Item .env.example .env
npm install
python backend/run.py
```

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
python scripts/seed_demo.py
python scripts/eval_mvp.py
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
  src/App.tsx             # 路由式页面与 Mock 交互
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

当前后端为便于学生团队离线复现而实现的标准库 HTTP API，不依赖 FastAPI、数据库或外部模型；前端 Mock 状态与后端数据暂未做自动同步。下一阶段接入 PostgreSQL/pgvector、文档解析器、真实知识库导入、DeepSeek 预算闸门和 Playwright E2E。