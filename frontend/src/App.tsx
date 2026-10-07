import { useEffect, useMemo, useRef, useState } from 'react'
import { assets as seedAssets, entities as seedEntities, evidence as seedEvidence, findings as seedFindings, project as seedProject } from './mock'
import type { Asset, Entity, Evidence, Finding, Project, RiskLevel, View } from './types'
import './styles.css'

const navItems: Array<{ id: View; label: string; icon: string; group?: string }> = [
  { id: 'overview', label: '项目总览', icon: '⌂' },
  { id: 'assets', label: '材料库', icon: '▤' },
  { id: 'entities', label: '要素确认', icon: '✣' },
  { id: 'analysis', label: '分析工作台', icon: '◒' },
  { id: 'search', label: '检索中心', icon: '⌕' },
  { id: 'findings', label: '风险清单', icon: '△' },
  { id: 'reports', label: '报告中心', icon: '▥' },
  { id: 'settings', label: '设置与开放', icon: '⚙' },
]

const riskLabels: Record<RiskLevel, string> = { high: '高风险', medium: '中风险', low: '低风险', insufficient: '信息不足' }

function viewFromLocation(): View {
  const pathName = window.location.pathname.split('/').filter(Boolean).pop()
  const hashName = window.location.hash.replace(/^#\/?/, '').split('/')[0]
  const name = (pathName || hashName) as View
  return navItems.some((item) => item.id === name) ? name : 'overview'
}

function RiskPill({ level }: { level: RiskLevel }) {
  return <span className={`risk-pill risk-${level}`}><i aria-hidden="true" />{riskLabels[level]}</span>
}

function StatusBadge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'green' | 'amber' | 'red' | 'blue' }) {
  return <span className={`status-badge tone-${tone}`}>{children}</span>
}

function SectionHeading({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: React.ReactNode }) {
  return <div className="section-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>
}

function ProgressRing({ value }: { value: number }) {
  return <div className="progress-ring" style={{ '--progress': `${value * 360}deg` } as React.CSSProperties}><span>{Math.round(value * 100)}<small>%</small></span></div>
}

function App() {
  const [activeView, setActiveView] = useState<View>(viewFromLocation)
  const [project, setProject] = useState<Project>(seedProject)
  const [assetData, setAssetData] = useState<Asset[]>(seedAssets)
  const [entityData, setEntityData] = useState<Entity[]>(seedEntities)
  const [findingData, setFindingData] = useState<Finding[]>(seedFindings)
  const [evidenceData] = useState<Evidence[]>(seedEvidence)
  const [selectedEvidence, setSelectedEvidence] = useState<Evidence | null>(null)
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState('')
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [isNewProjectOpen, setIsNewProjectOpen] = useState(false)
  const [externalAllowed, setExternalAllowed] = useState(false)
  const [assistantQuestion, setAssistantQuestion] = useState('')
  const [assistantAnswer, setAssistantAnswer] = useState('')
  const uploadRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onLocation = () => setActiveView(viewFromLocation())
    window.addEventListener('hashchange', onLocation)
    window.addEventListener('popstate', onLocation)
    return () => { window.removeEventListener('hashchange', onLocation); window.removeEventListener('popstate', onLocation) }
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 3600)
    return () => window.clearTimeout(timer)
  }, [notice])

  function navigate(view: View, projectId = project.id) {
    const path = view === 'settings' ? '/settings' : `/projects/${projectId}/${view}`
    window.history.pushState({}, '', path)
    setActiveView(view)
  }

  function beginAnalysis() {
    setIsAnalyzing(true)
    setNotice('分析任务已加入队列，Mock provider 正在处理…')
    window.setTimeout(() => {
      setIsAnalyzing(false)
      navigate('findings')
      setNotice('分析完成：已生成 4 条风险线索，所有结论均带有证据状态。')
    }, 1300)
  }

  function handleUpload(file?: File) {
    if (!file) return
    const extension = file.name.split('.').pop()?.toUpperCase() || 'FILE'
    const newAsset: Asset = { id: `a-${Date.now()}`, name: file.name, type: extension, size: `${(file.size / 1024 / 1024).toFixed(2)} MB`, source: '本地上传', status: 'processing', authorization: '待补充', updatedAt: '刚刚' }
    setAssetData((current) => [...current, newAsset])
    setNotice(`${file.name} 已上传，正在解析材料…`)
    window.setTimeout(() => {
      setAssetData((current) => current.map((asset) => asset.id === newAsset.id ? { ...asset, status: 'succeeded' } : asset))
      setNotice(`${file.name} 解析成功，可前往要素确认。`)
    }, 900)
  }

  function updateEntity(id: string, updates: Partial<Entity>) {
    setEntityData((current) => current.map((entity) => entity.id === id ? { ...entity, ...updates } : entity))
  }

  function updateFinding(id: string, updates: Partial<Finding>) {
    setFindingData((current) => current.map((finding) => finding.id === id ? { ...finding, ...updates } : finding))
    setNotice('风险项已保存到当前项目。')
  }

  function askAssistant(question = assistantQuestion) {
    const content = question.trim()
    if (!content) return
    setAssistantQuestion(content)
    setAssistantAnswer('正在查阅当前项目材料与 seed-v1 知识库…')
    window.setTimeout(() => setAssistantAnswer('基于当前证据，建议先补充素材作者、创作时间与授权凭证，再对“云岭茶旅”按商品/服务类别进行官方系统检索。该建议属于风险初筛，不构成法律意见。'))
  }

  function exportReport(format: 'markdown' | 'json') {
    const payload = {
      project,
      assets: assetData,
      entities: entityData,
      findings: findingData,
      evidence: evidenceData,
      generated_at: '2026-10-07T10:42:00+08:00',
      model_version: 'mock-v1',
      knowledge_base_version: 'seed-v1',
      disclaimer: '本结果仅用于信息整理和风险初筛，不构成法律意见。',
    }
    const markdown = `# ${project.name} · 知识产权初筛报告\n\n> 生成时间：2026-10-07 10:42  |  模型：Mock provider  |  知识库：seed-v1\n\n## 项目概况\n\n${project.description}\n\n- 地区：${project.region}\n- 材料：${assetData.length} 项\n\n## 要素与权利线索\n\n${entityData.map((item) => `- **${item.type}**：${item.value}（${item.review}，置信度 ${Math.round(item.confidence * 100)}%）`).join('\n')}\n\n- 商标：名称与服务品牌线索，建议按类别人工核验。\n- 版权：文案、摄影与图形表达线索，补充作者和授权凭证。\n- 地理标志：地域关联候选，仍需质量特征与官方来源。\n\n## 风险与行动\n\n${findingData.map((item) => `- **${riskLabels[item.level]}｜${item.title}**：${item.recommendation}（证据：${item.evidence.join(', ')}）`).join('\n')}\n\n## 证据索引\n\n${evidenceData.map((item) => `- **${item.id}** ${item.title}｜${item.publisher}｜${item.publishedAt}`).join('\n')}\n\n## 限制说明\n\n${payload.disclaimer}`
    const content = format === 'markdown' ? markdown : JSON.stringify(payload, null, 2)
    const blob = new Blob([content], { type: format === 'markdown' ? 'text/markdown;charset=utf-8' : 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `zhihe-xiangban-${project.id}.${format === 'markdown' ? 'md' : 'json'}`
    anchor.click()
    URL.revokeObjectURL(url)
    setNotice(`已导出脱敏 ${format === 'markdown' ? 'Markdown' : 'JSON'} 报告。`)
  }

  const openEvidence = (id: string) => setSelectedEvidence(evidenceData.find((item) => item.id === id) || null)
  const pendingCount = findingData.filter((finding) => finding.status === '待处理').length
  const confirmedEntities = entityData.filter((entity) => entity.review === '已确认').length
  const parsedAssets = assetData.filter((asset) => asset.status === 'succeeded').length
  const searchResults = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const base = [
      { title: '云岭茶旅', kind: '商标名称线索', region: '云南 · 茶叶 / 旅游服务', match: 0.91, source: '开放样例库 · seed-v1', evidence: '名称包含地域意象与“茶旅”服务描述，需按类别核验。' },
      { title: '云岭古树茶', kind: '相似名称', region: '云南 · 茶叶', match: 0.83, source: '国家知识产权局公开入口', evidence: '核心词“云岭”“茶”相近，建议保存官方检索时间与截图。' },
      { title: '景迈山传统茶文化', kind: '地域文化线索', region: '云南 · 普洱', match: 0.76, source: '项目知识库 · GI-001', evidence: '具有地域与传统工艺关联，当前仅作为地理标志人工核验线索。' },
    ]
    return normalized ? base.filter((item) => `${item.title}${item.kind}${item.region}`.toLowerCase().includes(normalized)) : base
  }, [query])

  const renderView = () => {
    switch (activeView) {
      case 'assets': return <AssetsView assets={assetData} onUpload={() => uploadRef.current?.click()} onOpen={(asset) => setNotice(`正在打开 ${asset.name} 的解析内容`)} />
      case 'entities': return <EntitiesView entities={entityData} onUpdate={updateEntity} />
      case 'analysis': return <AnalysisView project={project} isAnalyzing={isAnalyzing} onAnalyze={beginAnalysis} onAsk={askAssistant} answer={assistantAnswer} question={assistantQuestion} setQuestion={setAssistantQuestion} />
      case 'search': return <SearchView query={query} setQuery={setQuery} results={searchResults} onEvidence={openEvidence} onAddFinding={(title) => { setNotice(`已将“${title}”加入待确认风险项。`); navigate('findings') }} />
      case 'findings': return <FindingsView findings={findingData} onEvidence={openEvidence} onUpdate={updateFinding} />
      case 'reports': return <ReportsView project={project} findings={findingData} entities={entityData} onExport={exportReport} />
      case 'settings': return <SettingsView project={project} externalAllowed={externalAllowed} setExternalAllowed={setExternalAllowed} onNotice={setNotice} />
      default: return <OverviewView project={project} assets={assetData} pendingCount={pendingCount} confirmedEntities={confirmedEntities} parsedAssets={parsedAssets} findings={findingData} onNavigate={navigate} onAnalyze={beginAnalysis} isAnalyzing={isAnalyzing} onAsk={askAssistant} answer={assistantAnswer} question={assistantQuestion} setQuestion={setAssistantQuestion} />
    }
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand-lockup"><div className="brand-mark">禾</div><div><strong>知禾乡伴</strong><span>IP FIELD GUIDE</span></div></div>
      <div className="workspace-label">我的工作区 <button className="icon-button" aria-label="新建项目" onClick={() => setIsNewProjectOpen(true)}>＋</button></div>
      <button className="project-switcher" onClick={() => navigate('overview')}><span className="project-dot" /><span className="project-switcher-name">{project.name}</span><span className="chevron">⌄</span></button>
      <nav className="primary-nav" aria-label="项目导航">
        {navItems.slice(0, 7).map((item) => <button key={item.id} className={`nav-item ${activeView === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)}><span className="nav-icon">{item.icon}</span><span>{item.label}</span>{item.id === 'findings' && pendingCount > 0 && <em>{pendingCount}</em>}</button>)}
      </nav>
      <div className="sidebar-bottom"><button className={`nav-item ${activeView === 'settings' ? 'active' : ''}`} onClick={() => navigate('settings')}><span className="nav-icon">⚙</span><span>设置与开放</span></button><div className="privacy-note"><span className="lock-icon">⌑</span><div><strong>本地隐私模式</strong><small>材料不会离开此设备</small></div></div><div className="sidebar-version">MOCK PROVIDER · SEED-V1</div></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="breadcrumb"><span>知禾乡伴</span><b>/</b><strong>{navItems.find((item) => item.id === activeView)?.label}</strong></div><div className="topbar-actions"><span className="health-dot" /><span className="health-label">本地服务正常</span><span className="divider" /><StatusBadge tone="blue">Mock provider</StatusBadge><button className="help-button" aria-label="帮助">?</button><button className="avatar" aria-label="当前用户">知</button></div></header>
      <div className="content-scroll"><div className="content-inner">{renderView()}</div></div>
    </main>
    <input ref={uploadRef} type="file" hidden accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg" onChange={(event) => { handleUpload(event.target.files?.[0]); event.currentTarget.value = '' }} />
    {selectedEvidence && <EvidenceDrawer evidence={selectedEvidence} onClose={() => setSelectedEvidence(null)} />}
    {notice && <div className="toast"><span className="toast-check">✓</span>{notice}</div>}
    {isNewProjectOpen && <NewProjectModal onClose={() => setIsNewProjectOpen(false)} onCreate={(newProject) => { setProject(newProject); setIsNewProjectOpen(false); setNotice('新项目已创建，开始整理第一份材料吧。'); navigate('overview', newProject.id) }} />}
  </div>
}

function OverviewView({ project, assets, findings, pendingCount, confirmedEntities, parsedAssets, onNavigate, onAnalyze, isAnalyzing, onAsk, answer, question, setQuestion }: { project: Project; assets: Asset[]; findings: Finding[]; pendingCount: number; confirmedEntities: number; parsedAssets: number; onNavigate: (view: View) => void; onAnalyze: () => void; isAnalyzing: boolean; onAsk: (question?: string) => void; answer: string; question: string; setQuestion: (value: string) => void }) {
  const steps = [{ label: '建立项目', done: true, hint: '项目基本信息' }, { label: '整理材料', done: parsedAssets > 0, hint: `${parsedAssets} / 10 份材料已解析` }, { label: '确认要素', done: confirmedEntities >= 2, hint: `${confirmedEntities} 个要素已确认` }, { label: '生成初筛', done: findings.length > 0, hint: `${pendingCount} 项待处理风险` }]
  return <><SectionHeading eyebrow="PROJECT / OVERVIEW" title="项目总览" description="从材料到证据，逐步建立一份可复核的知识产权档案。" action={<div className="heading-actions"><button className="button secondary" onClick={() => onNavigate('assets')}>管理材料</button><button className="button primary" onClick={onAnalyze} disabled={isAnalyzing}>{isAnalyzing ? '分析中…' : '开始分析  →'}</button></div>} />
    <div className="hero-project"><div className="hero-project-main"><div className="project-kicker"><span className="project-dot" />进行中 <span className="hero-divider" />最后更新 今天 10:38</div><h2>{project.name}</h2><p>{project.description}</p><div className="hero-meta"><span>⌖ {project.region}</span><span>◈ {project.category}</span><span>⌑ 仅本地使用</span></div></div><ProgressRing value={0.74} /></div>
    <div className="stats-grid"><button className="stat-card" onClick={() => onNavigate('assets')}><span className="stat-icon green">▤</span><span className="stat-number">{assets.length}</span><span className="stat-label">项目材料</span><span className="stat-trend">{parsedAssets} 份已解析　→</span></button><button className="stat-card" onClick={() => onNavigate('entities')}><span className="stat-icon blue">✣</span><span className="stat-number">6</span><span className="stat-label">识别要素</span><span className="stat-trend">{confirmedEntities} 个已确认　→</span></button><button className="stat-card" onClick={() => onNavigate('findings')}><span className="stat-icon amber">△</span><span className="stat-number">{findings.length}</span><span className="stat-label">风险线索</span><span className="stat-trend warning">{pendingCount} 项待处理　→</span></button><button className="stat-card" onClick={() => onNavigate('reports')}><span className="stat-icon plum">▥</span><span className="stat-number">2</span><span className="stat-label">报告版本</span><span className="stat-trend">v1.1 最新　→</span></button></div>
    <div className="overview-grid"><section className="panel process-panel"><div className="panel-heading"><div><h3>分析进度</h3><p>完成每一步，结论才更接近可复核。</p></div><button className="text-button" onClick={() => onNavigate('analysis')}>查看工作台 →</button></div><div className="step-list">{steps.map((step, index) => <div className={`step-row ${step.done ? 'done' : ''}`} key={step.label}><div className="step-marker">{step.done ? '✓' : index + 1}</div><div className="step-copy"><strong>{step.label}</strong><span>{step.hint}</span></div>{step.done ? <StatusBadge tone="green">已完成</StatusBadge> : index === 2 ? <StatusBadge tone="amber">待确认</StatusBadge> : <StatusBadge>待开始</StatusBadge>}</div>)}</div></section><section className="panel findings-panel"><div className="panel-heading"><div><h3>需要关注</h3><p>来自最近一次 Mock 分析</p></div><button className="text-button" onClick={() => onNavigate('findings')}>全部风险 →</button></div><div className="mini-finding-list">{findings.slice(0, 3).map((finding) => <button className="mini-finding" key={finding.id} onClick={() => onNavigate('findings')}><RiskPill level={finding.level} /><span>{finding.title}</span><b>›</b></button>)}</div><div className="panel-callout"><span className="callout-icon">i</span><p>风险等级仅代表信息初筛，不构成法律意见。所有结论都需要人工复核。</p></div></section></div>
    <section className="assistant-strip"><div className="assistant-avatar">禾</div><div className="assistant-copy"><span className="eyebrow">AI 助手 · 当前项目</span><strong>从材料和证据出发，问我下一步该做什么。</strong>{answer && <p className="assistant-answer">{answer}</p>}</div><div className="assistant-input"><input value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && onAsk()} placeholder="例如：这个名称还需要核查什么？" /><button onClick={() => onAsk()}>发送</button></div></section>
  </>
}

function AssetsView({ assets, onUpload, onOpen }: { assets: Asset[]; onUpload: () => void; onOpen: (asset: Asset) => void }) {
  return <><SectionHeading eyebrow="PROJECT / ASSETS" title="材料库" description="材料只用于当前项目。先补全来源，再开始分析。" action={<button className="button primary" onClick={onUpload}>＋ 上传材料</button>} /><div className="upload-banner" onClick={onUpload} role="button" tabIndex={0} onKeyDown={(event) => event.key === 'Enter' && onUpload()}><div className="upload-symbol">↥</div><div><strong>拖拽文件到这里，或点击选择</strong><span>支持 PDF、DOCX、TXT、Markdown、PNG、JPG · 单文件不超过 20 MB</span></div><span className="upload-link">选择文件</span></div><section className="panel table-panel"><div className="panel-heading"><div><h3>项目材料 <span className="count-label">{assets.length}</span></h3><p>解析完成后可进入要素确认。</p></div><div className="table-filter">全部状态　⌄</div></div><div className="asset-table"><div className="table-head"><span>文件</span><span>来源与授权</span><span>解析状态</span><span>最近更新</span><span /></div>{assets.map((asset) => <div className="table-row" key={asset.id}><div className="file-cell"><span className={`file-icon file-${asset.type.toLowerCase()}`}>{asset.type === 'PDF' ? 'P' : asset.type === 'JPG' || asset.type === 'PNG' ? '◉' : 'T'}</span><div><strong>{asset.name}</strong><small>{asset.type} · {asset.size}</small></div></div><div><span>{asset.source}</span><small className={asset.authorization === '待补充' ? 'warning-text' : ''}>{asset.authorization === '待补充' ? '需补充授权信息' : asset.authorization}</small></div><div>{asset.status === 'succeeded' ? <StatusBadge tone="green">解析完成</StatusBadge> : asset.status === 'processing' ? <StatusBadge tone="blue">解析中…</StatusBadge> : asset.status === 'manual_required' ? <StatusBadge tone="amber">需人工补录</StatusBadge> : <StatusBadge tone="red">解析失败</StatusBadge>}</div><div className="muted">{asset.updatedAt}</div><button className="row-more" onClick={() => onOpen(asset)}>•••</button></div>)}</div></section></>
}

function EntitiesView({ entities, onUpdate }: { entities: Entity[]; onUpdate: (id: string, updates: Partial<Entity>) => void }) {
  return <><SectionHeading eyebrow="PROJECT / ENTITIES" title="要素确认" description="AI 已从材料中抽取这些线索，请在提交初筛前完成确认。" action={<div className="heading-actions"><button className="button secondary">导出要素</button><button className="button primary" onClick={() => entities.forEach((entity) => onUpdate(entity.id, { review: '已确认' }))}>全部确认</button></div>} /><div className="review-toolbar"><div><strong>{entities.length} 个要素</strong><span>· {entities.filter((entity) => entity.review !== '已确认').length} 个待处理</span></div><div className="segmented"><button className="selected">全部</button><button>待确认</button><button>已确认</button></div></div><div className="entity-grid">{entities.map((entity) => <article className={`entity-card ${entity.review === '已确认' ? 'confirmed' : ''}`} key={entity.id}><div className="entity-card-top"><span className="entity-type">{entity.type}</span>{entity.review === '已确认' ? <span className="checkmark">✓</span> : <span className="pending-dot" />}</div><h3>{entity.value}</h3><div className="entity-meta"><span>来源 {entity.source}</span><span>置信度 {Math.round(entity.confidence * 100)}%</span></div><div className="entity-actions"><button onClick={() => onUpdate(entity.id, { review: entity.review === '已确认' ? '待确认' : '已确认' })}>{entity.review === '已确认' ? '取消确认' : '确认要素'}</button><button className="quiet-button" onClick={() => onUpdate(entity.id, { review: '待核验' })}>标记待核验</button></div></article>)}</div></>
}

function AnalysisView({ project, isAnalyzing, onAnalyze, onAsk, answer, question, setQuestion }: { project: Project; isAnalyzing: boolean; onAnalyze: () => void; onAsk: (question?: string) => void; answer: string; question: string; setQuestion: (value: string) => void }) {
  return <><SectionHeading eyebrow="PROJECT / ANALYSIS" title="分析工作台" description="将已确认的要素转化为权利线索、证据和可执行的下一步。" action={<button className="button primary" onClick={onAnalyze} disabled={isAnalyzing}>{isAnalyzing ? '分析处理中…' : '重新生成初筛'}</button>} /><div className="analysis-intro"><div className="analysis-mark">◒</div><div><h2>{isAnalyzing ? '正在把材料整理成证据链' : '开始一次可复核的初筛'}</h2><p>{isAnalyzing ? 'Mock provider 将依次完成要素、检索与规则校验，请稍候。' : `当前项目已准备好 6 个要素和 4 条证据，可覆盖商标、版权、地理标志三类线索。`}</p></div></div><div className="analysis-flow"><AnalysisStage number="01" title="要素校正" text="确认名称、地点、产品和素材来源" done={!isAnalyzing} /><span className="flow-line" /><AnalysisStage number="02" title="混合检索" text="关键词 + 语义相似 + 来源过滤" done={!isAnalyzing} /><span className="flow-line" /><AnalysisStage number="03" title="风险规则" text="生成风险等级与行动建议" done={!isAnalyzing} /><span className="flow-line" /><AnalysisStage number="04" title="证据校验" text="确保每条结论都有可回溯依据" done={!isAnalyzing} /></div><div className="analysis-columns"><section className="panel scope-panel"><div className="panel-heading"><div><h3>本次分析范围</h3><p>可调整，但不会发送原始图片。</p></div><span className="scope-lock">⌑ 本地</span></div><label className="scope-option selected"><input type="checkbox" defaultChecked /> <span><strong>商标线索</strong><small>名称、图形、组合标识、服务品牌</small></span></label><label className="scope-option selected"><input type="checkbox" defaultChecked /> <span><strong>版权线索</strong><small>摄影、文案、地图和设计表达</small></span></label><label className="scope-option selected"><input type="checkbox" defaultChecked /> <span><strong>地理标志线索</strong><small>地域关联、质量特征、传统工艺</small></span></label><button className="button primary full-width" onClick={onAnalyze} disabled={isAnalyzing}>生成风险初筛　→</button></section><section className="panel assistant-panel"><div className="panel-heading"><div><h3>问 AI 助手</h3><p>仅使用当前项目材料与 seed-v1 证据。</p></div><span className="ai-badge">AI</span></div><div className="quick-prompts"><button onClick={() => onAsk('这个名称还需要核查什么？')}>这个名称还需要核查什么？</button><button onClick={() => onAsk('这批素材缺少哪些授权信息？')}>素材还缺哪些授权？</button></div><div className="assistant-input large"><input value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && onAsk()} placeholder="输入关于当前项目的问题…" /><button onClick={() => onAsk()}>发送</button></div>{answer && <div className="answer-box"><span>⌁</span><p>{answer}</p></div>}</section></div><p className="disclaimer">知禾乡伴提供知识产权信息整理与风险初筛辅助，不替代律师、代理师或行政机关的正式判断。</p></>
}

function AnalysisStage({ number, title, text, done }: { number: string; title: string; text: string; done: boolean }) {
  return <div className={`analysis-stage ${done ? 'done' : ''}`}><span>{done ? '✓' : number}</span><strong>{title}</strong><small>{text}</small></div>
}

function SearchView({ query, setQuery, results, onEvidence, onAddFinding }: { query: string; setQuery: (value: string) => void; results: Array<{ title: string; kind: string; region: string; match: number; source: string; evidence: string }>; onEvidence: (id: string) => void; onAddFinding: (title: string) => void }) {
  return <><SectionHeading eyebrow="PROJECT / SEARCH" title="检索中心" description="从本地开放样例和可引用来源中，找到值得人工核验的相似线索。" /><div className="search-box"><span>⌕</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && setQuery(event.currentTarget.value)} placeholder="输入名称、关键词、地域或产品类别" /><kbd>Enter</kbd><button onClick={() => setQuery(query)}>检索</button></div><div className="search-layout"><aside className="search-filters panel"><div className="panel-heading"><div><h3>筛选条件</h3><p>控制候选来源与范围</p></div><button className="text-button" onClick={() => setQuery('')}>清除</button></div><label>权利类型<select defaultValue="all"><option value="all">全部类型</option><option>商标</option><option>版权</option><option>地理标志</option></select></label><label>地区<select defaultValue="yunnan"><option value="yunnan">云南 · 普洱市</option><option>全国</option></select></label><label>来源状态<select defaultValue="verified"><option value="verified">已核验来源</option><option>全部来源</option></select></label><div className="filter-note"><span>i</span> 检索结果是线索，不是“可注册”结论。</div></aside><section className="search-results"><div className="result-toolbar"><strong>{results.length} 条匹配线索</strong><span>混合排序 · 来源可信度优先</span></div>{results.map((result, index) => <article className="result-card" key={result.title}><div className="result-score"><strong>{Math.round(result.match * 100)}<small>%</small></strong><span>相似度</span></div><div className="result-main"><div className="result-title"><h3>{result.title}</h3><StatusBadge tone={index === 0 ? 'amber' : 'blue'}>{result.kind}</StatusBadge></div><p>{result.evidence}</p><div className="result-meta"><span>⌖ {result.region}</span><span>◈ {result.source}</span><span>◷ 查询于今天</span></div></div><div className="result-actions"><button className="text-button" onClick={() => onEvidence(index === 0 ? 'ev-2' : index === 1 ? 'ev-1' : 'ev-1')}>查看证据</button><button onClick={() => onAddFinding(result.title)}>＋ 加入风险</button></div></article>)}{results.length === 0 && <div className="empty-state"><span>⌕</span><h3>没有找到匹配线索</h3><p>尝试换一个名称、地区或更短的关键词。</p></div>}</section></div></>
}

function FindingsView({ findings, onEvidence, onUpdate }: { findings: Finding[]; onEvidence: (id: string) => void; onUpdate: (id: string, updates: Partial<Finding>) => void }) {
  return <><SectionHeading eyebrow="PROJECT / FINDINGS" title="风险清单" description="逐项查看触发因素、证据与行动建议，留下人工复核痕迹。" action={<div className="heading-actions"><button className="button secondary">筛选　⌄</button><button className="button primary">导出清单</button></div>} /><div className="risk-summary"><div><span>当前共</span><strong>{findings.length}</strong><span>条线索</span></div><div className="risk-summary-bars"><span><i className="bar-high" />高风险 0</span><span><i className="bar-medium" />中风险 {findings.filter((f) => f.level === 'medium').length}</span><span><i className="bar-low" />低风险 {findings.filter((f) => f.level === 'low').length}</span><span><i className="bar-insufficient" />信息不足 {findings.filter((f) => f.level === 'insufficient').length}</span></div><span className="summary-date">最近分析 · 今天 10:42</span></div><div className="findings-list">{findings.map((finding) => <article className="finding-card" key={finding.id}><div className="finding-main"><div className="finding-title"><RiskPill level={finding.level} /><span className="finding-type">{finding.type}</span><h3>{finding.title}</h3></div><p className="finding-trigger"><strong>触发因素</strong>{finding.trigger}</p><div className="finding-evidence"><strong>证据</strong>{finding.evidence.map((id) => <button key={id} onClick={() => onEvidence(id)}>⌁ {id} 查看片段</button>)}</div><div className="finding-recommend"><span>→</span><p><strong>下一步</strong>{finding.recommendation}</p></div></div><div className="finding-side"><label>处理状态<select value={finding.status} onChange={(event) => onUpdate(finding.id, { status: event.target.value as Finding['status'] })}><option>待处理</option><option>已确认</option><option>已驳回</option></select></label><label>风险等级<select value={finding.level} onChange={(event) => onUpdate(finding.id, { level: event.target.value as RiskLevel })}><option value="high">高风险</option><option value="medium">中风险</option><option value="low">低风险</option><option value="insufficient">信息不足</option></select></label><button className="quiet-button">添加备注 ＋</button></div></article>)}</div></>
}

function ReportsView({ project, findings, entities, onExport }: { project: Project; findings: Finding[]; entities: Entity[]; onExport: (format: 'markdown' | 'json') => void }) {
  return <><SectionHeading eyebrow="PROJECT / REPORTS" title="报告中心" description="保留 AI 生成基线和人工修改版本，让每个结论都有来路。" action={<div className="heading-actions"><button className="button secondary" onClick={() => onExport('json')}>导出 JSON</button><button className="button primary" onClick={() => onExport('markdown')}>导出 Markdown　↓</button></div>} /><div className="report-layout"><section className="report-preview panel"><div className="report-paper"><div className="report-cover"><span className="report-logo">禾</span><span className="eyebrow">ZHIHE XIANGBAN · IP FIELD GUIDE</span><h2>{project.name}</h2><p>知识产权风险初筛报告</p><div><span>生成时间 2026-10-07 10:42</span><span>模型 Mock v1</span><span>知识库 seed-v1</span></div></div><div className="report-section"><div className="report-section-title"><span>01</span><h3>项目概况</h3></div><p>{project.description} 本报告整理当前材料中的权利线索、检索证据、风险项和建议行动。所有结论均需人工复核。</p></div><div className="report-section"><div className="report-section-title"><span>02</span><h3>识别到的权利线索</h3></div><div className="report-tags"><span>商标 · 名称与服务品牌</span><span>版权 · 文案与现场摄影</span><span>地理标志 · 地域关联待核验</span></div><p>共确认 {entities.filter((entity) => entity.review === '已确认').length} 个要素，发现 {findings.length} 条风险线索。</p></div><div className="report-section"><div className="report-section-title"><span>03</span><h3>风险与行动清单</h3></div>{findings.slice(0, 3).map((finding) => <div className="report-line" key={finding.id}><RiskPill level={finding.level} /><span>{finding.title}</span></div>)}</div><div className="report-footer">本结果仅用于信息整理和风险初筛，不构成法律意见。</div></div></section><aside className="report-sidebar"><div className="panel version-panel"><div className="panel-heading"><div><h3>报告版本</h3><p>AI 基线不会被覆盖</p></div><span className="count-label">2</span></div><button className="version-item current"><span><strong>v1.1</strong><small>人工复核版本</small></span><em>当前</em></button><button className="version-item"><span><strong>v1.0</strong><small>AI 生成基线</small></span><em>10:42</em></button><button className="button secondary full-width">＋ 新建版本</button></div><div className="panel export-panel"><h3>报告内容</h3><label><input type="checkbox" defaultChecked /> 项目概况与材料</label><label><input type="checkbox" defaultChecked /> 权利线索与检索证据</label><label><input type="checkbox" defaultChecked /> 风险矩阵与行动清单</label><label><input type="checkbox" defaultChecked /> 限制说明与人工复核</label><div className="export-safe"><span>⌑</span><p>导出前会自动检查个人信息、密钥和无权公开内容。</p></div></div></aside></div></>
}

function SettingsView({ project, externalAllowed, setExternalAllowed, onNotice }: { project: Project; externalAllowed: boolean; setExternalAllowed: (value: boolean) => void; onNotice: (message: string) => void }) {
  return <><SectionHeading eyebrow="WORKSPACE / SETTINGS" title="设置与开放" description="管理模型、数据保留、外发同意和开放成果边界。" /><div className="settings-grid"><section className="panel setting-panel"><div className="panel-heading"><div><h3>模型与隐私</h3><p>当前项目：{project.name}</p></div><StatusBadge tone="green">本地模式</StatusBadge></div><div className="setting-row"><div><strong>模型 provider</strong><span>无 API Key 也可完成离线演示</span></div><StatusBadge tone="blue">Mock provider</StatusBadge></div><div className="setting-row"><div><strong>知识库版本</strong><span>仓库内脱敏样例与官方来源元数据</span></div><StatusBadge>seed-v1</StatusBadge></div><div className="setting-row"><div><strong>项目隐私级别</strong><span>原始材料仅用于当前项目</span></div><StatusBadge tone="green">local_only</StatusBadge></div><div className="setting-row toggle-row"><div><strong>允许发送到第三方云 API</strong><span>开启前请确认材料会离开此设备，MVP 默认关闭</span></div><button className={`toggle ${externalAllowed ? 'on' : ''}`} aria-pressed={externalAllowed} onClick={() => { setExternalAllowed(!externalAllowed); onNotice(externalAllowed ? '已关闭第三方外发。' : '已开启外发选项，请在项目级确认后使用。') }}><span /></button></div></section><section className="panel setting-panel"><div className="panel-heading"><div><h3>用量与预算</h3><p>DeepSeek 外部调用会先经过预算闸门</p></div><button className="text-button">查看账本 →</button></div><div className="budget-total"><strong>¥ 0.00</strong><span>本项目实际成本 · 本月预算 ¥20.00</span><div className="budget-progress"><i /></div></div><div className="usage-grid"><div><strong>0</strong><span>输入 tokens</span></div><div><strong>0</strong><span>输出 tokens</span></div><div><strong>0</strong><span>外部请求</span></div></div></section><section className="panel setting-panel resource-panel"><div className="panel-heading"><div><h3>资源与开放清单</h3><p>记录实际使用的库、数据、模型与服务。</p></div><button className="button secondary">＋ 新增资源</button></div><div className="resource-item"><span className="resource-icon">◈</span><div><strong>React + Vite</strong><small>MIT · 前端运行时</small></div><StatusBadge tone="green">已核验</StatusBadge></div><div className="resource-item"><span className="resource-icon">⌁</span><div><strong>seed-v1 知识库</strong><small>团队整理 · 脱敏样例</small></div><StatusBadge tone="amber">待复核</StatusBadge></div><div className="resource-item"><span className="resource-icon">✦</span><div><strong>DeepSeek Flash</strong><small>第三方在线服务 · 仅可选</small></div><StatusBadge>已披露</StatusBadge></div><button className="text-button">导出资源许可证清单 →</button></section><section className="panel setting-panel danger-panel"><div><h3>数据与健康检查</h3><p>删除项目会清理原文件、解析文本、索引、报告和审计记录。</p></div><div className="danger-actions"><button className="button secondary">运行健康检查</button><button className="button danger">清理演示数据</button></div></section></div></>
}

function EvidenceDrawer({ evidence, onClose }: { evidence: Evidence; onClose: () => void }) {
  return <div className="drawer-backdrop" onClick={onClose}><aside className="evidence-drawer" onClick={(event) => event.stopPropagation()}><div className="drawer-header"><div><span className="eyebrow">EVIDENCE / SOURCE CHUNK</span><h2>证据详情</h2></div><button className="close-button" onClick={onClose} aria-label="关闭证据抽屉">×</button></div><div className="drawer-status"><StatusBadge tone={evidence.status === 'verified' ? 'green' : 'amber'}>{evidence.status === 'verified' ? '来源已核验' : '项目材料 · 待补录'}</StatusBadge><span>知识库 seed-v1</span></div><article className="evidence-paper"><span className="quote-mark">“</span><p>{evidence.excerpt}</p><span className="quote-mark closing">”</span></article><dl className="evidence-details"><div><dt>来源</dt><dd>{evidence.publisher}</dd></div><div><dt>标题</dt><dd>{evidence.title}</dd></div><div><dt>链接 / 位置</dt><dd className="source-link">{evidence.source}</dd></div><div><dt>发布日期 / 访问时间</dt><dd>{evidence.publishedAt}</dd></div></dl><div className="drawer-note"><label>人工备注<textarea placeholder="补充这条证据的核验结果…" /></label></div><div className="drawer-actions"><button className="button secondary">标记失效</button><button className="button primary" onClick={onClose}>保存并关闭</button></div></aside></div>
}

function NewProjectModal({ onClose, onCreate }: { onClose: () => void; onCreate: (project: Project) => void }) {
  const [name, setName] = useState('')
  const [region, setRegion] = useState('')
  const [description, setDescription] = useState('')
  return <div className="modal-backdrop" onClick={onClose}><div className="modal-card" onClick={(event) => event.stopPropagation()}><div className="modal-header"><div><span className="eyebrow">NEW PROJECT</span><h2>建立一个新项目</h2></div><button className="close-button" onClick={onClose}>×</button></div><p className="modal-lede">先填写最少信息，之后可以在项目总览中继续完善。</p><label>项目名称<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：云岭茶旅品牌" /></label><label>地区<input value={region} onChange={(event) => setRegion(event.target.value)} placeholder="例如：云南 · 普洱市" /></label><label>项目简介<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="描述产品、路线或活动…" /></label><div className="privacy-callout"><span>⌑</span><p><strong>默认本地隐私模式</strong><br />材料不会发送到第三方云 API，之后可在设置中单独开启。</p></div><div className="modal-actions"><button className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={!name.trim()} onClick={() => onCreate({ id: `project-${Date.now()}`, name: name.trim(), region: region.trim() || '待补充', category: '农文旅', description: description.trim() || '待补充项目简介。', status: 'draft', privacyLevel: 'local_only' })}>创建项目</button></div></div></div>
}

export default App
