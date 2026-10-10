import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiClientError, saveBlob } from './api'
import { assets as seedAssets, entities as seedEntities, evidence as seedEvidence, findings as seedFindings, project as seedProject } from './mock'
import type { AnalysisResult, Asset, Entity, Evidence, Finding, Project, QaAnswer, Report, RiskLevel, SearchResult, TaskState, View } from './types'
import './styles.css'

type Page = View | 'projects' | 'new'
type RouteState = { page: Page; projectId?: string }
type UploadItem = { id: string; name: string; file: File; progress: number; status: 'uploading' | 'processing' | 'failed'; error?: string; taskId?: string }

const navItems: Array<{ id: View; label: string; icon: string }> = [
  { id: 'overview', label: '项目档案', icon: '禾' },
  { id: 'assets', label: '材料', icon: '页' },
  { id: 'entities', label: '要素', icon: '结' },
  { id: 'analysis', label: '分析', icon: '线' },
  { id: 'search', label: '检索', icon: '印' },
  { id: 'findings', label: '风险', icon: '埂' },
  { id: 'reports', label: '报告', icon: '册' },
  { id: 'settings', label: '设置', icon: '章' },
]
const riskLabels: Record<RiskLevel, string> = { high: '高风险', medium: '中风险', low: '低风险', insufficient: '信息不足' }
const seedAnalysis: AnalysisResult = {
  summary: '当前显示的是本地 Mock 档案。启动后端后，项目、材料、分析和报告会从 JsonStore 恢复。',
  entities: seedEntities,
  findings: seedFindings,
  evidence: seedEvidence,
  rightCandidates: [],
  missingInformation: ['素材作者、来源、许可证和授权凭证'],
  modelVersion: 'mock-v1',
  knowledgeBaseVersion: 'seed-v1',
}

function routeFromLocation(): RouteState {
  const parts = window.location.pathname.split('/').filter(Boolean)
  if (parts[0] === 'settings') return { page: 'settings' }
  if (!parts.length || parts[0] === 'projects' && parts.length === 1) return { page: 'projects' }
  if (parts[0] === 'projects' && parts[1] === 'new') return { page: 'new' }
  if (parts[0] === 'projects' && parts[1]) return { page: (parts[2] as Page) || 'overview', projectId: parts[1] }
  return { page: 'projects' }
}
function pathForRoute(page: Page, projectId?: string) { return page === 'projects' ? '/projects' : page === 'new' ? '/projects/new' : page === 'settings' ? '/settings' : `/projects/${projectId}/${page}` }
function RiskPill({ level }: { level: RiskLevel }) { return <span className={`risk-pill risk-${level}`}><i />{riskLabels[level]}</span> }
function StatusBadge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'green' | 'amber' | 'red' | 'blue' }) { return <span className={`status-badge tone-${tone}`}>{children}</span> }
function SectionHeading({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: React.ReactNode }) { return <div className="section-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div> }
function formatError(error: unknown) { return error instanceof ApiClientError ? error.message : error instanceof Error ? error.message : '操作失败，请稍后重试。' }

function App() {
  const [route, setRoute] = useState<RouteState>(routeFromLocation)
  const [projects, setProjects] = useState<Project[]>([])
  const [project, setProject] = useState<Project | null>(null)
  const [assets, setAssets] = useState<Asset[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [findings, setFindings] = useState<Finding[]>([])
  const [evidence, setEvidence] = useState<Evidence[]>([])
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null)
  const [reports, setReports] = useState<Report[]>([])
  const [currentReport, setCurrentReport] = useState<Report | null>(null)
  const [selectedEvidence, setSelectedEvidence] = useState<Evidence | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [offlineMode, setOfflineMode] = useState(false)
  const [providerLabel, setProviderLabel] = useState('Mock provider')
  const [loading, setLoading] = useState(false)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [uploads, setUploads] = useState<Record<string, UploadItem>>({})
  const [assistantQuestion, setAssistantQuestion] = useState('')
  const [assistantAnswer, setAssistantAnswer] = useState<QaAnswer | null>(null)
  const [qaLoading, setQaLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const uploadRef = useRef<HTMLInputElement>(null)

  const navigate = useCallback((page: Page, projectId = project?.id) => {
    const next = { page, projectId }
    window.history.pushState({}, '', pathForRoute(page, projectId))
    setRoute(next)
  }, [project?.id])

  useEffect(() => { const onPop = () => setRoute(routeFromLocation()); window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop) }, [])
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 3800); return () => window.clearTimeout(timer) }, [notice])
  useEffect(() => { api.getSettings().then((settings) => setProviderLabel(settings.provider === 'deepseek' ? 'DeepSeek Flash' : 'Mock provider')).catch(() => undefined) }, [])
  useEffect(() => {
    let cancelled = false
    setError('')
    if (route.page === 'projects' || route.page === 'new') {
      setProject(null); setLoading(true)
      api.listProjects().then((items) => { if (!cancelled) { setProjects(items.length ? items : [seedProject]); setOfflineMode(false) } }).catch(() => { if (!cancelled) { setProjects([seedProject]); setOfflineMode(true) } }).finally(() => { if (!cancelled) setLoading(false) })
      return () => { cancelled = true }
    }
    if (!route.projectId) return
    setLoading(true)
    Promise.all([api.getProject(route.projectId), api.listAssets(route.projectId), api.getAnalysis(route.projectId), api.listReports(route.projectId)])
      .then(([nextProject, nextAssets, nextAnalysis, nextReports]) => { if (cancelled) return; setProject(nextProject); setAssets(nextAssets); setAnalysis(nextAnalysis); setEntities(nextAnalysis?.entities || []); setFindings(nextAnalysis?.findings || []); setEvidence(nextAnalysis?.evidence || []); setReports(nextReports); setCurrentReport(nextReports[0] || null) })
      .catch((e) => { if (!cancelled) { if (route.projectId === seedProject.id) { setProject(seedProject); setAssets(seedAssets); setEntities(seedEntities); setFindings(seedFindings); setEvidence(seedEvidence); setAnalysis(seedAnalysis); setReports([]); setCurrentReport(null); setOfflineMode(true) } else setError(formatError(e)) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [route])

  const refreshProject = useCallback(async (silent = false) => {
    if (!route.projectId) return
    if (!silent) setLoading(true)
    try {
      const [nextProject, nextAssets, nextAnalysis, nextReports] = await Promise.all([api.getProject(route.projectId), api.listAssets(route.projectId), api.getAnalysis(route.projectId), api.listReports(route.projectId)])
      setProject(nextProject); setAssets(nextAssets); setAnalysis(nextAnalysis); setEntities(nextAnalysis?.entities || []); setFindings(nextAnalysis?.findings || []); setEvidence(nextAnalysis?.evidence || []); setReports(nextReports); setCurrentReport(nextReports[0] || null)
    } catch (e) { setError(formatError(e)) } finally { if (!silent) setLoading(false) }
  }, [route.projectId])

  async function waitForTask(taskId: string, onProgress?: (task: TaskState) => void) {
    for (let attempt = 0; attempt < 35; attempt += 1) {
      const task = await api.getTask(taskId); onProgress?.(task)
      if (task.status === 'succeeded') return task
      if (task.status === 'failed' || task.status === 'cancelled') throw new Error(task.errorMessage || '任务失败')
      await new Promise((resolve) => window.setTimeout(resolve, 400))
    }
    throw new Error('任务处理超时，请稍后刷新页面查看状态。')
  }
  async function uploadFile(file: File) {
    if (!project) return
    const id = `${Date.now()}-${file.name}`
    setUploads((current) => ({ ...current, [id]: { id, name: file.name, file, progress: 0, status: 'uploading' } }))
    try {
      const result = await api.uploadAsset(project.id, file, { authorizationStatus: 'pending' }, (progress) => setUploads((current) => ({ ...current, [id]: { ...current[id], progress: progress.percent } })))
      setUploads((current) => ({ ...current, [id]: { ...current[id], progress: 100, status: 'processing', taskId: result.task.taskId } }))
      await waitForTask(result.task.taskId, (task) => setUploads((current) => ({ ...current, [id]: { ...current[id], progress: task.progress, status: task.status === 'failed' ? 'failed' : 'processing', error: task.errorMessage || undefined } })))
      setUploads((current) => { const next = { ...current }; delete next[id]; return next })
      await refreshProject(true); setNotice(`${file.name} 已上传并完成解析。`)
    } catch (e) { setUploads((current) => ({ ...current, [id]: { ...current[id], status: 'failed', error: formatError(e) } })); setError(formatError(e)) }
  }
  async function beginAnalysis() {
    if (!project) return
    setIsAnalyzing(true); setError('')
    try { const result = await api.startAnalysis(project.id); await waitForTask(result.task.taskId); await refreshProject(true); setNotice('分析完成，已生成带证据的风险线索。'); navigate('findings', project.id) } catch (e) { setError(formatError(e)) } finally { setIsAnalyzing(false) }
  }
  async function saveEntity(id: string, updates: Partial<Entity>) { if (!project) return; setEntities((items) => items.map((item) => item.id === id ? { ...item, ...updates } : item)); try { await api.patchEntity(project.id, id, updates); setNotice('要素确认已保存。') } catch (e) { setError(formatError(e)); await refreshProject(true) } }
  async function saveFinding(id: string, updates: Partial<Finding>) { if (!project) return; setFindings((items) => items.map((item) => item.id === id ? { ...item, ...updates } : item)); try { await api.patchFinding(project.id, id, updates); setNotice('风险处理状态已保存。') } catch (e) { setError(formatError(e)); await refreshProject(true) } }
  async function generateReport() { if (!project) return; setIsGenerating(true); try { const result = await api.generateReport(project.id); await waitForTask(result.task.taskId); await refreshProject(true); setNotice('报告已生成。') } catch (e) { setError(formatError(e)) } finally { setIsGenerating(false) } }
  async function exportReport(format: 'md' | 'json') { if (!project) return; try { let report = currentReport; if (!report) { await generateReport(); const next = await api.listReports(project.id); report = next[0] || null; setCurrentReport(report) } if (!report) throw new Error('请先生成一份报告。'); saveBlob(await api.exportReport(report.id, format), `zhihe-xiangban-${project.id}.${format}`); setNotice(`已导出 ${format.toUpperCase()} 报告。`) } catch (e) { setError(formatError(e)) } }
  async function askAssistant(question = assistantQuestion) {
    const text = question.trim()
    if (!text || !project) return
    setAssistantQuestion(text); setQaLoading(true); setError('')
    try {
      const result = await api.askProject(project.id, text)
      setAssistantAnswer(result)
    } catch (e) {
      setError(formatError(e))
    } finally {
      setQaLoading(false)
    }
  }
  async function searchProject(query = searchQuery) {
    if (!project) return
    const text = query.trim()
    setSearchQuery(query); setSearchLoading(true); setError('')
    try {
      const result = await api.searchProject(project.id, text)
      setSearchResults(result.items)
    } catch (e) {
      const needle = text.toLowerCase()
      const fallback = evidence.filter((item) => !needle || `${item.title}${item.publisher}${item.excerpt}`.toLowerCase().includes(needle)).map((item) => ({ id: `local-${item.id}`, title: item.title, kind: 'project_material', region: project.region, match: '离线证据记录', source: item.publisher, evidenceId: item.id, evidence: item }))
      setSearchResults(fallback); setOfflineMode(true); setError(formatError(e))
    } finally {
      setSearchLoading(false)
    }
  }

  if (route.page === 'projects') return <ProjectsPage projects={projects} loading={loading} error={error} offlineMode={offlineMode} onOpen={(id) => navigate('overview', id)} onNew={() => navigate('new')} />
  if (route.page === 'new') return <NewProjectPage onCancel={() => navigate('projects')} onCreated={(created) => { setProjects((items) => [created, ...items]); navigate('overview', created.id); setNotice('新项目已创建。') }} />
  if (route.page === 'settings' && !project) return <WorkspaceSettings />
  if (!project) return <div className="app-shell"><main className="main-area"><div className="content-inner"><div className="async-state">{loading ? '正在打开项目档案…' : error || '项目不存在。'}<button className="button secondary" onClick={() => navigate('projects')}>返回项目列表</button></div></div></main></div>
  const pending = findings.filter((item) => item.status === '待处理').length
  const pageTitle = navItems.find((item) => item.id === route.page)?.label || '项目档案'
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand-lockup"><img className="brand-image" src="/brand/zhihe-xiangban-logo-v1.png" alt="知禾乡伴" /><div><strong>知禾乡伴</strong><span>IP FIELD GUIDE</span></div></div>
      <div className="workspace-label">我的工作区 <button className="icon-button" onClick={() => navigate('new')}>＋</button></div>
      <button className="project-switcher" onClick={() => navigate('projects')}><span className="project-dot" /><span className="project-switcher-name">{project.name}</span><span className="chevron">⌄</span></button>
      <nav className="primary-nav" aria-label="项目导航">{navItems.slice(0, 7).map((item) => <button key={item.id} className={`nav-item ${route.page === item.id ? 'active' : ''}`} onClick={() => navigate(item.id, project.id)}><span className="nav-icon">{item.icon}</span><span>{item.label}</span>{item.id === 'findings' && pending > 0 && <em>{pending}</em>}</button>)}</nav>
      <div className="sidebar-bottom"><button className={`nav-item ${route.page === 'settings' ? 'active' : ''}`} onClick={() => navigate('settings', project.id)}><span className="nav-icon">章</span><span>设置与开放</span></button><div className="privacy-note"><span className="lock-icon">⌑</span><div><strong>本地隐私模式</strong><small>材料不会离开此设备</small></div></div><div className="sidebar-version">MOCK PROVIDER · SEED-V1</div></div>
    </aside>
    <main className="main-area"><header className="topbar"><div className="breadcrumb"><span>知禾乡伴</span><b>/</b><strong>{pageTitle}</strong></div><div className="topbar-actions"><span className={`health-dot ${offlineMode ? 'offline' : ''}`} /><span className="health-label">{offlineMode ? '离线演示档案' : '本地服务'}</span><span className="divider" /><StatusBadge tone={providerLabel === 'DeepSeek Flash' ? 'amber' : 'blue'}>{providerLabel}</StatusBadge><button className="avatar">知</button></div></header><div className="content-scroll"><div className="content-inner">{offlineMode && <div className="offline-note">本地 API 暂未连接，当前保留 seed-v1 档案用于离线演示。启动 <code>python backend/run.py</code> 后刷新即可继续使用真实项目数据。</div>}{error && <div className="inline-error">{error}<button onClick={() => setError('')}>×</button></div>}{loading && <div className="loading-line">正在同步项目档案…</div>}{route.page === 'overview' && <OverviewView project={project} assets={assets} findings={findings} evidence={evidence} onNavigate={(page) => navigate(page, project.id)} onAnalyze={beginAnalysis} isAnalyzing={isAnalyzing} onEdit={() => navigate('settings', project.id)} />}{route.page === 'assets' && <AssetsView assets={assets} uploads={uploads} onPick={() => uploadRef.current?.click()} onFiles={(files) => files.forEach(uploadFile)} onDelete={async (asset) => { try { await api.deleteAsset(asset.id); await refreshProject(true); setNotice('材料已删除。') } catch (e) { setError(formatError(e)) } }} onRetry={async (asset) => { if (!asset.taskId) return; try { await api.retryTask(asset.taskId); await refreshProject(true); setNotice('已重新加入解析队列。') } catch (e) { setError(formatError(e)) } }} />}{route.page === 'entities' && <EntitiesView entities={entities} onUpdate={saveEntity} />}{route.page === 'analysis' && <AnalysisView project={project} analysis={analysis} isAnalyzing={isAnalyzing} qaLoading={qaLoading} onAnalyze={beginAnalysis} question={assistantQuestion} setQuestion={setAssistantQuestion} answer={assistantAnswer} onAsk={askAssistant} />}{route.page === 'search' && <SearchView query={searchQuery} results={searchResults} loading={searchLoading} onQuery={setSearchQuery} onSearch={searchProject} onEvidence={(item) => item.evidence && setSelectedEvidence(item.evidence)} />}{route.page === 'findings' && <FindingsView findings={findings} evidence={evidence} onEvidence={setSelectedEvidence} onUpdate={saveFinding} />}{route.page === 'reports' && <ReportsView project={project} reports={reports} currentReport={currentReport} isGenerating={isGenerating} onGenerate={generateReport} onSelect={setCurrentReport} onExport={exportReport} />}{route.page === 'settings' && <SettingsView project={project} onSaved={(next) => { setProject(next); setNotice('项目档案已保存。') }} />}</div></div></main>
    <input ref={uploadRef} type="file" hidden multiple accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg" onChange={(event) => { Array.from(event.target.files || []).forEach(uploadFile); event.currentTarget.value = '' }} />
    {selectedEvidence && <EvidenceDrawer evidence={selectedEvidence} onClose={() => setSelectedEvidence(null)} />}{notice && <div className="toast"><span className="toast-check">✓</span>{notice}</div>}
  </div>
}

function ProjectsPage({ projects, loading, error, offlineMode, onOpen, onNew }: { projects: Project[]; loading: boolean; error: string; offlineMode: boolean; onOpen: (id: string) => void; onNew: () => void }) {
  return <div className="app-shell"><aside className="sidebar"><div className="brand-lockup"><img className="brand-image" src="/brand/zhihe-xiangban-logo-v1.png" alt="知禾乡伴" /><div><strong>知禾乡伴</strong><span>IP FIELD GUIDE</span></div></div><div className="workspace-label">我的工作区 <button className="icon-button" onClick={onNew}>＋</button></div><button className="project-switcher project-switcher-muted" onClick={onNew}><span className="project-dot" /><span className="project-switcher-name">选择或建立项目</span><span className="chevron">⌄</span></button><nav className="primary-nav" aria-label="工作区导航"><button className="nav-item active" onClick={() => undefined}><span className="nav-icon">禾</span><span>项目档案</span></button><button className="nav-item" onClick={onNew}><span className="nav-icon">＋</span><span>建立项目</span></button></nav><div className="sidebar-bottom"><div className="privacy-note"><span className="lock-icon">⌑</span><div><strong>本地隐私模式</strong><small>材料不会离开此设备</small></div></div><div className="sidebar-version">MOCK PROVIDER · SEED-V1</div></div></aside><main className="main-area projects-area"><header className="topbar"><div className="breadcrumb"><span>知禾乡伴</span><b>/</b><strong>项目档案</strong></div><div className="topbar-actions"><span className={`health-dot ${offlineMode ? 'offline' : ''}`} /><span className="health-label">{offlineMode ? '离线演示档案' : '本地服务'}</span><span className="divider" /><StatusBadge tone="blue">Mock provider</StatusBadge><button className="avatar">知</button></div></header><div className="content-scroll"><div className="content-inner"><SectionHeading eyebrow="WORKSPACE / PROJECTS" title="项目档案" description="每一个项目都是一份可追溯的农文旅知识产权案卷。" action={<button className="button primary" onClick={onNew}>＋ 建立项目</button>} />{offlineMode && <div className="offline-note">本地 API 暂未连接，先显示 seed-v1 档案。启动后端并刷新页面即可恢复真实项目列表。</div>}{loading && <div className="async-state">正在读取项目档案…</div>}{error && <div className="inline-error">{error}</div>}{!loading && !projects.length && <div className="empty-state project-empty"><span>禾</span><h3>还没有项目档案</h3><p>从一个项目名称和地区开始，逐步整理材料与证据。</p><button className="button primary" onClick={onNew}>建立第一份档案</button></div>}<div className="projects-list">{projects.map((item) => <button className="project-record" key={item.id} onClick={() => onOpen(item.id)}><span className="record-index">{item.id.slice(-4).toUpperCase()}</span><span className="record-copy"><strong>{item.name}</strong><span>{item.region} · {item.category}</span><small>{item.description}</small></span><span className="record-meta"><StatusBadge tone={item.status === 'active' ? 'green' : 'amber'}>{item.status === 'active' ? '进行中' : '草稿'}</StatusBadge><span>{item.assetsCount || 0} 份材料</span>→</span></button>)}</div></div></div></main></div>
}

function ProjectForm({ initial, submitLabel, onSubmit, onCancel }: { initial?: Partial<Project>; submitLabel: string; onSubmit: (value: { name: string; region: string; category: string; description: string; privacyLevel: Project['privacyLevel']; externalLlmConsent: boolean }) => Promise<void>; onCancel?: () => void }) {
  const [name, setName] = useState(initial?.name || '')
  const [region, setRegion] = useState(initial?.region || '')
  const [category, setCategory] = useState(initial?.category || '农文旅')
  const [description, setDescription] = useState(initial?.description || '')
  const [externalAllowed, setExternalAllowed] = useState(initial?.privacyLevel === 'external_allowed' && Boolean(initial?.externalLlmConsent))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  return <form className="project-form" onSubmit={async (event) => { event.preventDefault(); if (!name.trim()) return; setSaving(true); setError(''); try { await onSubmit({ name: name.trim(), region: region.trim() || '待补充', category: category.trim() || '农文旅', description: description.trim() || '待补充项目简介。', privacyLevel: externalAllowed ? 'external_allowed' : 'local_only', externalLlmConsent: externalAllowed }) } catch (e) { setError(formatError(e)) } finally { setSaving(false) } }}><label>项目名称<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：云岭茶旅品牌" required /></label><label>地区<input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="例如：云南 · 普洱市" /></label><label>项目类别<input value={category} onChange={(e) => setCategory(e.target.value)} /></label><label>项目简介<textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="描述产品、路线或活动…" /></label><label className="privacy-checkbox"><input type="checkbox" checked={externalAllowed} onChange={(e) => setExternalAllowed(e.target.checked)} /><span><strong>允许发送脱敏项目字段到 DeepSeek</strong><small>仅发送结构化字段和材料元数据；原始图片不会上传。开启后会记录项目级外发同意。</small></span></label>{error && <div className="inline-error">{error}</div>}<div className="form-actions">{onCancel && <button type="button" className="button secondary" onClick={onCancel}>取消</button>}<button className="button primary" disabled={saving || !name.trim()}>{saving ? '保存中…' : submitLabel}</button></div></form>
}
function NewProjectPage({ onCancel, onCreated }: { onCancel: () => void; onCreated: (project: Project) => void }) { return <div className="app-shell"><main className="main-area"><div className="content-inner"><SectionHeading eyebrow="WORKSPACE / NEW PROJECT" title="建立项目档案" description="先写下项目本身，再把材料、要素与证据放进案卷。" /><ProjectForm submitLabel="创建项目" onCancel={onCancel} onSubmit={async (value) => onCreated(await api.createProject(value))} /></div></main></div> }
function WorkspaceSettings() { const [settings, setSettings] = useState<{ provider?: string; knowledge_base_version?: string } | null>(null); useEffect(() => { api.getSettings().then(setSettings).catch(() => setSettings(null)) }, []); return <div className="app-shell"><main className="main-area"><div className="content-inner"><SectionHeading eyebrow="WORKSPACE / SETTINGS" title="设置与开放" description="管理本地服务和知识库版本。" /><div className="settings-grid"><section className="panel setting-panel"><div className="panel-heading"><div><h3>运行环境</h3><p>默认保持离线 Mock provider。</p></div><StatusBadge tone="green">本地模式</StatusBadge></div><div className="setting-row"><div><strong>模型 provider</strong><span>{settings?.provider || 'mock'}</span></div><StatusBadge tone="blue">Mock</StatusBadge></div><div className="setting-row"><div><strong>知识库版本</strong><span>{settings?.knowledge_base_version || 'seed-v1'}</span></div></div><div className="setting-row"><div><strong>项目级设置</strong><span>请从项目档案进入设置，编辑项目名称、地区和简介。</span></div></div></section></div></div></main></div> }

function OverviewView({ project, assets, findings, evidence, onNavigate, onAnalyze, isAnalyzing, onEdit }: { project: Project; assets: Asset[]; findings: Finding[]; evidence: Evidence[]; onNavigate: (page: View) => void; onAnalyze: () => void; isAnalyzing: boolean; onEdit: () => void }) {
  const parsed = assets.filter((item) => item.status === 'succeeded').length; const pending = findings.filter((item) => item.status === '待处理').length; const steps = [{ label: '材料', hint: `${parsed} / ${assets.length || 0} 份已解析`, done: parsed > 0 }, { label: '要素', hint: '从材料抽取可核验线索', done: Boolean(findings.length || evidence.length) }, { label: '证据', hint: `${evidence.length} 条可回溯来源`, done: evidence.length > 0 }, { label: '风险', hint: `${pending} 项待处理`, done: findings.length > 0 }, { label: '报告', hint: '形成可导出的项目档案', done: false }]
  return <><SectionHeading eyebrow="PROJECT / DOSSIER" title="项目档案首页" description="从材料到证据，再到风险和报告，项目本身是这份案卷的主角。" action={<div className="heading-actions"><button className="button secondary" onClick={onEdit}>编辑档案</button><button className="button primary" disabled={isAnalyzing} onClick={onAnalyze}>{isAnalyzing ? '分析中…' : '开始分析 →'}</button></div>} /><section className="dossier-hero"><div><div className="archive-code">PROJECT / {project.id.slice(-8).toUpperCase()}</div><h2>{project.name}</h2><p>{project.description}</p><div className="hero-meta"><span>坐标 · {project.region}</span><span>类别 · {project.category}</span><StatusBadge tone="green">{project.status === 'active' ? '进行中' : '草稿'}</StatusBadge></div></div><div className="seal-mark">知禾<br /><small>LOCAL</small></div></section><div className="dossier-grid"><section className="process-panel archive-section"><div className="section-label">案卷进度</div><div className="vertical-progress">{steps.map((step, index) => <button key={step.label} className={`progress-step ${step.done ? 'done' : ''}`} onClick={() => onNavigate((['assets', 'entities', 'analysis', 'findings', 'reports'][index]) as View)}><span className="step-marker">{step.done ? '✓' : String(index + 1).padStart(2, '0')}</span><span><strong>{step.label}</strong><small>{step.hint}</small></span><i>→</i></button>)}</div></section><aside className="priority-column archive-section"><div className="section-label">优先处理</div>{findings.slice(0, 3).map((item) => <button className="archive-list-item" key={item.id} onClick={() => onNavigate('findings')}><RiskPill level={item.level} /><span>{item.title}</span></button>)}{!findings.length && <p className="muted">分析后会在这里显示风险线索。</p>}<div className="missing-note"><strong>待补材料</strong><span>{analysisMissing(findings)} 项信息需补录作者、授权或来源。</span></div></aside></div><div className="recent-grid"><section className="archive-section"><div className="section-label">最近材料 <button onClick={() => onNavigate('assets')}>查看全部 →</button></div>{assets.slice(0, 3).map((asset) => <div className="archive-row" key={asset.id}><span className="paper-symbol">页</span><span><strong>{asset.name}</strong><small>{asset.source} · {asset.updatedAt}</small></span><StatusBadge tone={asset.status === 'succeeded' ? 'green' : 'amber'}>{asset.status === 'succeeded' ? '已解析' : '处理中'}</StatusBadge></div>)}</section><section className="archive-section"><div className="section-label">最近证据 <button onClick={() => onNavigate('findings')}>查看来源 →</button></div>{evidence.slice(0, 3).map((item) => <button className="archive-row evidence-row" key={item.id} onClick={() => onNavigate('findings')}><span className="evidence-index">{item.id}</span><span><strong>{item.title}</strong><small>{item.publisher} · {item.publishedAt}</small></span><span>›</span></button>)}</section></div></>
}
function analysisMissing(findings: Finding[]) { return findings.filter((item) => item.level === 'insufficient').length }

function AssetsView({ assets, uploads, onPick, onFiles, onDelete, onRetry }: { assets: Asset[]; uploads: Record<string, UploadItem>; onPick: () => void; onFiles: (files: File[]) => void; onDelete: (asset: Asset) => void; onRetry: (asset: Asset) => void }) {
  const [dragging, setDragging] = useState(false); const uploadItems = Object.values(uploads)
  return <><SectionHeading eyebrow="PROJECT / ASSETS" title="材料档案" description="材料只用于当前项目。补全来源与授权，再进入分析。" action={<button className="button primary" onClick={onPick}>＋ 上传材料</button>} /><div className={`upload-banner ${dragging ? 'dragging' : ''}`} onClick={onPick} onDragOver={(e) => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={(e) => { e.preventDefault(); setDragging(false); onFiles(Array.from(e.dataTransfer.files)) }}><div className="upload-symbol">页</div><div><strong>拖拽文件到这里，或点击选择</strong><span>支持 PDF、DOCX、TXT、Markdown、PNG、JPG · 单文件不超过 20 MB</span></div><span className="upload-link">选择文件</span></div>{uploadItems.length > 0 && <section className="upload-queue">{uploadItems.map((item) => <div className="upload-item" key={item.id}><span className="paper-symbol">页</span><div><strong>{item.name}</strong><small>{item.status === 'failed' ? item.error : item.status === 'processing' ? '正在解析材料…' : `正在上传 ${item.progress}%`}</small><div className="upload-progress"><i style={{ width: `${item.progress}%` }} /></div></div>{item.status === 'failed' && <button className="text-button" onClick={() => onFiles([item.file])}>重试</button>}</div>)}</section>}<section className="archive-section table-panel"><div className="section-label">项目材料 <span>{assets.length}</span></div>{!assets.length && <div className="empty-state"><span>页</span><h3>还没有材料</h3><p>上传项目介绍、授权凭证或公开来源文件。</p></div>}<div className="asset-table">{assets.map((asset) => <div className="table-row" key={asset.id}><div className="file-cell"><span className="file-icon">页</span><div><strong>{asset.name}</strong><small>{asset.type} · {asset.size}</small></div></div><div><span>{asset.source}</span><small className={asset.authorization === '待补充' ? 'warning-text' : ''}>{asset.authorization}</small></div><div>{asset.status === 'succeeded' ? <StatusBadge tone="green">解析完成</StatusBadge> : asset.status === 'failed' ? <StatusBadge tone="red">解析失败</StatusBadge> : <StatusBadge tone="blue">解析中 {asset.progress || 0}%</StatusBadge>}</div><div className="muted">{asset.updatedAt}</div><div className="row-actions">{asset.status === 'failed' && <button onClick={() => onRetry(asset)}>重试</button>}<button className="row-delete" onClick={() => onDelete(asset)}>删除</button></div></div>)}</div></section></>
}

function EntitiesView({ entities, onUpdate }: { entities: Entity[]; onUpdate: (id: string, updates: Partial<Entity>) => void }) { return <><SectionHeading eyebrow="PROJECT / ENTITIES" title="要素确认" description="确认名称、地点、产品和素材来源，为后续风险判断留下人工痕迹。" action={<button className="button primary" onClick={() => entities.forEach((item) => onUpdate(item.id, { review: '已确认' }))}>全部确认</button>} /><div className="review-toolbar"><strong>{entities.length} 个要素</strong><span>· {entities.filter((item) => item.review !== '已确认').length} 个待处理</span></div><div className="entity-grid">{entities.map((item) => <article className={`entity-card ${item.review === '已确认' ? 'confirmed' : ''}`} key={item.id}><div className="entity-card-top"><span className="entity-type">{item.type}</span>{item.review === '已确认' ? <span className="checkmark">✓</span> : <span className="pending-dot" />}</div><h3>{item.value}</h3><div className="entity-meta"><span>来源 {item.source}</span><span>置信度 {Math.round(item.confidence * 100)}%</span></div><div className="entity-actions"><button onClick={() => onUpdate(item.id, { review: item.review === '已确认' ? '待确认' : '已确认' })}>{item.review === '已确认' ? '取消确认' : '确认要素'}</button><button className="quiet-button" onClick={() => onUpdate(item.id, { review: '待核验' })}>标记待核验</button></div></article>)}</div></> }

function AnalysisView({ project, analysis, isAnalyzing, qaLoading, onAnalyze, question, setQuestion, answer, onAsk }: { project: Project; analysis: AnalysisResult | null; isAnalyzing: boolean; qaLoading: boolean; onAnalyze: () => void; question: string; setQuestion: (value: string) => void; answer: QaAnswer | null; onAsk: () => void }) { const provider = analysis?.provider === 'deepseek' ? 'DeepSeek Flash' : 'Mock provider'; return <><SectionHeading eyebrow="PROJECT / ANALYSIS" title="分析工作台" description="将已确认的要素转化为权利线索、证据和下一步行动。" action={<button className="button primary" disabled={isAnalyzing} onClick={onAnalyze}>{isAnalyzing ? '分析处理中…' : '重新生成初筛'}</button>} /><div className="analysis-intro"><div className="analysis-mark">线</div><div><h2>{isAnalyzing ? '正在整理证据链' : analysis ? '最近一次分析已完成' : '开始一次可复核的初筛'}</h2><p>{analysis?.summary || `当前项目：${project.name}。当前 provider：${provider}。`}</p><small className="provider-caption">本次结果由 {provider} 生成，仍需结合证据进行人工复核。</small></div></div><div className="analysis-flow">{['要素校正', '混合检索', '风险规则', '证据校验'].map((label, index) => <div className="analysis-stage done" key={label}><span>0{index + 1}</span><strong>{label}</strong><small>{['确认名称和素材来源', '关键词与来源过滤', '生成风险等级', '保留可回溯依据'][index]}</small></div>)}</div><section className="archive-section evidence-action"><div><div className="section-label">下一步建议</div><h3>补充素材作者和授权凭证，或打开官方检索来源。</h3><p>AI 是档案工作的助手，最终结论仍需人工复核。</p></div><div className="assistant-input large"><input value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onAsk()} placeholder="询问当前证据 / 查找下一步" /><button disabled={qaLoading} onClick={onAsk}>{qaLoading ? '查询中…' : '查找'}</button></div>{answer && <div className="assistant-answer"><p>{answer.answer}</p>{answer.nextSteps.length > 0 && <ul>{answer.nextSteps.map((step) => <li key={step}>{step}</li>)}</ul>}<small className="provider-caption">{answer.provider === 'deepseek' ? 'DeepSeek Flash' : 'Mock provider'} · 关联证据 {answer.evidenceIds.length ? answer.evidenceIds.join('、') : '待补充'}</small></div>}</section></> }

function SearchView({ query, results, loading, onQuery, onSearch, onEvidence }: { query: string; results: SearchResult[]; loading: boolean; onQuery: (value: string) => void; onSearch: () => void; onEvidence: (item: SearchResult) => void }) { return <><SectionHeading eyebrow="PROJECT / SEARCH" title="检索中心" description="从当前项目的可引用来源中找到值得人工核验的相似线索。" /><div className="search-box"><span>印</span><input value={query} onChange={(e) => onQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onSearch()} placeholder="输入名称、关键词、地域或产品类别" /><button disabled={loading} onClick={onSearch}>{loading ? '检索中…' : '检索'}</button></div><div className="search-results">{results.map((item) => <article className="result-card" key={item.id}><div className="result-main"><div className="result-title"><h3>{item.title}</h3><StatusBadge tone="amber">项目证据</StatusBadge></div><p>{item.evidence?.excerpt || '暂无原文摘录。'}</p><div className="result-meta"><span>地名印记 · {item.source}</span><span>{item.region} · 命中 {item.match}</span></div></div><div className="result-actions"><button className="text-button" disabled={!item.evidence} onClick={() => onEvidence(item)}>查看来源档案</button></div></article>)}{!results.length && <div className="empty-state"><span>印</span><h3>{query ? '没有找到匹配线索' : '输入关键词开始检索'}</h3><p>检索结果会保留证据编号，并可打开来源档案页复核。</p></div>}</div></> }

function FindingsView({ findings, evidence, onEvidence, onUpdate }: { findings: Finding[]; evidence: Evidence[]; onEvidence: (item: Evidence) => void; onUpdate: (id: string, updates: Partial<Finding>) => void }) { return <><SectionHeading eyebrow="PROJECT / FINDINGS" title="风险清单" description="逐项查看触发因素、证据与行动建议，留下人工复核痕迹。" /><div className="risk-summary"><div><span>当前共</span><strong>{findings.length}</strong><span>条线索</span></div><div className="risk-summary-bars"><span>高风险 {findings.filter((f) => f.level === 'high').length}</span><span>中风险 {findings.filter((f) => f.level === 'medium').length}</span><span>信息不足 {findings.filter((f) => f.level === 'insufficient').length}</span></div></div><div className="findings-list">{findings.map((item) => <article className="finding-card" key={item.id}><div className="finding-main"><div className="finding-title"><RiskPill level={item.level} /><span className="finding-type">{item.type}</span><h3>{item.title}</h3></div><p className="finding-trigger"><strong>触发因素</strong>{item.trigger}</p><div className="finding-evidence"><strong>证据</strong>{item.evidence.map((id) => { const source = evidence.find((entry) => entry.id === id); return <button key={id} onClick={() => source && onEvidence(source)}>结 · {id} 查看片段</button> })}</div><div className="finding-recommend"><span>→</span><p><strong>下一步</strong>{item.recommendation}</p></div></div><div className="finding-side"><label>处理状态<select value={item.status} onChange={(e) => onUpdate(item.id, { status: e.target.value as Finding['status'] })}><option>待处理</option><option>已确认</option><option>已驳回</option></select></label><label>风险等级<select value={item.level} onChange={(e) => onUpdate(item.id, { level: e.target.value as RiskLevel })}><option value="high">高风险</option><option value="medium">中风险</option><option value="low">低风险</option><option value="insufficient">信息不足</option></select></label></div></article>)}</div>{!findings.length && <div className="empty-state"><span>埂</span><h3>还没有风险线索</h3><p>完成一次分析后，风险会以可复核条目出现。</p></div>}</> }

function ReportsView({ project, reports, currentReport, isGenerating, onGenerate, onSelect, onExport }: { project: Project; reports: Report[]; currentReport: Report | null; isGenerating: boolean; onGenerate: () => void; onSelect: (report: Report) => void; onExport: (format: 'md' | 'json') => void }) { return <><SectionHeading eyebrow="PROJECT / REPORTS" title="报告中心" description="保留每次生成的基线与版本，让结论有来路。" action={<div className="heading-actions"><button className="button secondary" onClick={() => onExport('json')}>导出 JSON</button><button className="button secondary" onClick={() => onExport('md')}>导出 Markdown</button><button className="button primary" onClick={onGenerate} disabled={isGenerating}>{isGenerating ? '生成中…' : '生成报告'}</button></div>} /><div className="report-layout"><section className="report-preview panel"><div className="report-paper"><div className="report-cover"><img src="/brand/zhihe-xiangban-logo-v1.png" alt="知禾乡伴" /><span className="eyebrow">ZHIHE XIANGBAN · DOSSIER</span><h2>{project.name}</h2><p>知识产权风险初筛报告</p></div>{currentReport ? <div className="report-content"><pre>{currentReport.content}</pre></div> : <div className="empty-state"><span>册</span><h3>还没有报告版本</h3><p>生成报告后，这里会保留可阅读的 Markdown 档案。</p></div>}</div></section><aside className="report-sidebar"><div className="panel version-panel"><div className="panel-heading"><div><h3>报告版本</h3><p>AI 基线不会被覆盖</p></div></div>{reports.map((item) => <button className={`version-item ${currentReport?.id === item.id ? 'current' : ''}`} key={item.id} onClick={() => onSelect(item)}><span><strong>v{item.version}</strong><small>{item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : '刚刚'}</small></span><em>{currentReport?.id === item.id ? '当前' : '打开'}</em></button>)}</div></aside></div></> }

function SettingsView({ project, onSaved }: { project: Project; onSaved: (project: Project) => void }) { const [editing, setEditing] = useState(false); const [usage, setUsage] = useState<{ project_cost?: number; monthly_cost?: number; budgets?: { project?: number; monthly?: number } } | null>(null); useEffect(() => { api.getUsageSummary(project.id).then(setUsage).catch(() => setUsage(null)) }, [project.id]); return <><SectionHeading eyebrow="WORKSPACE / SETTINGS" title="设置与开放" description="管理项目档案和本地隐私边界。" action={<button className="button secondary" onClick={() => setEditing((value) => !value)}>{editing ? '关闭编辑' : '编辑档案'}</button>} />{editing ? <ProjectForm initial={project} submitLabel="保存档案" onCancel={() => setEditing(false)} onSubmit={async (value) => { const next = await api.updateProject(project.id, { name: value.name, region: value.region, category: value.category, description: value.description }); const privacy = await api.updatePrivacy(project.id, value.privacyLevel, value.externalLlmConsent); onSaved({ ...next, ...privacy }); setEditing(false) }} /> : <div className="settings-grid"><section className="panel setting-panel"><div className="panel-heading"><div><h3>项目与隐私</h3><p>{project.name}</p></div><StatusBadge tone={project.privacyLevel === 'external_allowed' ? 'amber' : 'green'}>{project.privacyLevel === 'external_allowed' ? '已同意外发' : '本地模式'}</StatusBadge></div><div className="setting-row"><div><strong>项目编号</strong><span>{project.id}</span></div></div><div className="setting-row"><div><strong>项目地区</strong><span>{project.region}</span></div></div><div className="setting-row"><div><strong>当前 provider</strong><span>{project.privacyLevel === 'external_allowed' ? '可使用后端配置的 DeepSeek' : 'Mock provider'}</span></div><StatusBadge tone={project.privacyLevel === 'external_allowed' ? 'amber' : 'blue'}>{project.privacyLevel === 'external_allowed' ? 'DeepSeek 可选' : 'Mock'}</StatusBadge></div><div className="setting-row"><div><strong>外发同意</strong><span>{project.externalLlmConsent ? '已记录项目级同意，调用前仍会执行预算和脱敏检查。' : '未同意第三方外发，分析保持在本地 Mock provider。'}</span></div><StatusBadge tone={project.externalLlmConsent ? 'amber' : 'green'}>{project.externalLlmConsent ? 'external_allowed' : 'local_only'}</StatusBadge></div><div className="setting-row"><div><strong>DeepSeek 用量</strong><span>项目 ¥{(usage?.project_cost || 0).toFixed(4)} · 本月 ¥{(usage?.monthly_cost || 0).toFixed(4)}</span></div><small>预算 ¥{(usage?.budgets?.project || 0.2).toFixed(2)} / ¥{(usage?.budgets?.monthly || 20).toFixed(2)}</small></div><button className="button secondary" onClick={() => setEditing(true)}>编辑外发与项目设置</button></section></div>}</> }

function EvidenceDrawer({ evidence, onClose }: { evidence: Evidence; onClose: () => void }) { return <div className="drawer-backdrop" onClick={onClose}><aside className="evidence-drawer" onClick={(e) => e.stopPropagation()}><div className="drawer-header"><div><span className="eyebrow">EVIDENCE / SOURCE RECORD</span><h2>来源档案页</h2></div><button className="close-button" onClick={onClose}>×</button></div><div className="drawer-status"><strong>{evidence.id}</strong><span>{evidence.publisher}</span><StatusBadge tone={evidence.status === 'verified' ? 'green' : 'amber'}>{evidence.status === 'verified' ? '来源已核验' : '待复核'}</StatusBadge></div><article className="evidence-paper"><span className="quote-mark">“</span><p>{evidence.excerpt}</p><span className="quote-mark closing">”</span></article><dl className="evidence-details"><div><dt>发布机构</dt><dd>{evidence.publisher}</dd></div><div><dt>来源域名 / 位置</dt><dd className="source-link">{evidence.source}</dd></div><div><dt>发布日期</dt><dd>{evidence.publishedAt}</dd></div><div><dt>访问时间</dt><dd>{evidence.accessedAt || '当前项目记录'}</dd></div></dl><div className="drawer-support"><strong>支持哪些结论</strong><ul>{(evidence.supports || []).map((item) => <li key={item}>{item}</li>)}</ul><strong>还不能证明什么</strong><ul>{(evidence.limits || []).map((item) => <li key={item}>{item}</li>)}</ul></div><div className="drawer-actions"><button className="button primary" onClick={onClose}>关闭档案</button></div></aside></div> }

export default App
