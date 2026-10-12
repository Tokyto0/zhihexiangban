import type { AnalysisResult, Asset, Entity, Evidence, Finding, Project, QaAnswer, Report, SearchResult, TaskState } from './types'

type ApiRecord = Record<string, any>

const configuredBase = (import.meta.env.VITE_API_BASE_URL || '/api/v1').trim().replace(/\/+$/, '')
export const API_BASE_URL = configuredBase.endsWith('/api/v1')
  ? configuredBase
  : configuredBase.endsWith('/api')
    ? `${configuredBase}/v1`
    : `${configuredBase}/api/v1`

export class ApiClientError extends Error {
  status: number
  code: string
  details: unknown
  requestId?: string

  constructor(message: string, status: number, code = 'API_ERROR', details: unknown = {}, requestId?: string) {
    super(message)
    this.name = 'ApiClientError'
    this.status = status
    this.code = code
    this.details = details
    this.requestId = requestId
  }
}

function formatDate(value?: string | null) {
  if (!value) return '待补充'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
}

function formatBytes(value?: number) {
  if (value === undefined || !Number.isFinite(value)) return '待补充'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`
  return `${(value / 1024 / 1024).toFixed(2)} MB`
}

function typeFromMime(mime = '', filename = '') {
  const extension = filename.split('.').pop()?.toUpperCase()
  if (extension) return extension
  if (mime.includes('pdf')) return 'PDF'
  if (mime.includes('word')) return 'DOCX'
  if (mime.includes('markdown')) return 'MD'
  if (mime.includes('text')) return 'TXT'
  if (mime.includes('png')) return 'PNG'
  if (mime.includes('jpeg')) return 'JPG'
  return 'FILE'
}

function mapProject(raw: ApiRecord): Project {
  return {
    id: String(raw.id),
    name: String(raw.name || ''),
    region: String(raw.region || '待补充'),
    category: String(raw.category || '农文旅'),
    description: String(raw.description || '待补充项目简介。'),
    status: raw.status === 'active' || raw.status === 'archived' ? raw.status : 'draft',
    privacyLevel: raw.privacy_level === 'external_allowed' ? 'external_allowed' : 'local_only',
    externalLlmConsent: Boolean(raw.external_llm_consent),
    assetsCount: Number(raw.assets_count || 0),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  }
}

function mapAsset(raw: ApiRecord): Asset {
  const parseStatus = String(raw.parse_status || raw.status || 'queued')
  const authorizationStatus = String(raw.authorization_status || 'pending')
  return {
    id: String(raw.id),
    name: String(raw.filename || raw.name || '未命名材料'),
    type: typeFromMime(raw.mime_type, raw.filename),
    size: formatBytes(Number(raw.size_bytes)),
    source: String(raw.source_note || '未填写来源'),
    status: parseStatus === 'failed' ? 'failed' : parseStatus === 'manual_required' ? 'manual_required' : parseStatus === 'succeeded' ? 'succeeded' : 'processing',
    authorization: authorizationStatus === 'verified' ? '已核验' : authorizationStatus === 'declared' ? '已声明' : '待补充',
    updatedAt: formatDate(raw.updated_at || raw.created_at),
    taskId: raw.task_id || raw.parse_task_id ? String(raw.task_id || raw.parse_task_id) : undefined,
    progress: Number(raw.progress ?? (parseStatus === 'succeeded' ? 100 : 0)),
    errorMessage: raw.error_message || undefined,
  }
}

function mapEntity(raw: ApiRecord): Entity {
  const review = String(raw.review_status || raw.review || 'unreviewed')
  return {
    id: String(raw.id),
    value: String(raw.value || '待补充要素'),
    type: String(raw.type || '未分类'),
    source: String(raw.source_chunk_id || raw.source || '项目分析'),
    confidence: Number(raw.confidence || 0),
    review: review === 'confirmed' || review === '已确认' ? '已确认' : review === 'needs_review' || review === '待核验' ? '待核验' : '待确认',
  }
}

function mapFinding(raw: ApiRecord): Finding {
  const status = String(raw.status || 'open')
  const level = raw.level === 'high' || raw.level === 'low' || raw.level === 'insufficient' ? raw.level : 'medium'
  return {
    id: String(raw.id),
    level,
    type: String(raw.type || (level === 'insufficient' ? '材料完整性' : '权利线索')),
    title: String(raw.title || (level === 'insufficient' ? '作者与授权凭证待补录' : '名称或核心词待核验')),
    trigger: String(raw.trigger || '当前项目存在待核验信息'),
    evidence: Array.isArray(raw.evidence_ids) ? raw.evidence_ids.map(String) : [],
    recommendation: String(raw.recommendation || '补充材料并进行人工核验。'),
    status: status === 'confirmed' || status === '已确认' ? '已确认' : status === 'rejected' || status === '已驳回' ? '已驳回' : '待处理',
  }
}

function mapEvidence(raw: ApiRecord): Evidence {
  return {
    id: String(raw.id),
    title: String(raw.title || '项目来源片段'),
    publisher: String(raw.publisher || '当前项目材料'),
    excerpt: String(raw.excerpt || raw.reason || '暂无原文摘录。'),
    source: String(raw.url || raw.source || raw.source_type || raw.publisher || '项目材料'),
    publishedAt: raw.published_at ? formatDate(raw.published_at) : '项目材料',
    status: raw.status === 'verified' || raw.status === 'invalid' ? raw.status : 'pending',
    accessedAt: raw.retrieved_at ? formatDate(raw.retrieved_at) : undefined,
    supports: raw.reason ? [String(raw.reason)] : ['当前项目保存了这段可引用信息'],
    limits: raw.status === 'verified' ? ['不能单独证明正式权利结论'] : ['不能证明作者、创作时间或完整授权范围'],
  }
}

function mapAnalysis(raw: ApiRecord | null | undefined): AnalysisResult | null {
  if (!raw || raw.status === 'not_started') return null
  return {
    summary: String(raw.summary || '已完成离线 Mock 初筛，请结合证据和待核验事项进行人工复核。'),
    provider: raw.provider || (raw.model_version === 'mock-v1' ? 'mock' : undefined),
    entities: Array.isArray(raw.entities) ? raw.entities.map(mapEntity) : [],
    findings: Array.isArray(raw.findings) ? raw.findings.map(mapFinding) : [],
    evidence: Array.isArray(raw.sources) ? raw.sources.map(mapEvidence) : [],
    rightCandidates: Array.isArray(raw.right_candidates) ? raw.right_candidates.map((item: ApiRecord) => ({ id: String(item.id), rightType: String(item.right_type), reason: String(item.reason || ''), confidence: Number(item.confidence || 0), reviewRequired: Boolean(item.review_required) })) : [],
    missingInformation: Array.isArray(raw.missing_information) ? raw.missing_information.map(String) : [],
    modelVersion: raw.model_version,
    knowledgeBaseVersion: raw.knowledge_base_version,
    generatedAt: raw.generated_at,
    disclaimer: raw.disclaimer,
  }
}

function mapSearchResult(raw: ApiRecord): SearchResult {
  return {
    id: String(raw.id || `search-${Math.random().toString(36).slice(2)}`),
    title: String(raw.title || '项目来源片段'),
    kind: String(raw.kind || 'project_material'),
    region: String(raw.region || '待补充'),
    match: String(raw.match || '项目证据记录'),
    source: String(raw.source || '当前项目材料'),
    evidenceId: raw.evidence_id ? String(raw.evidence_id) : undefined,
    evidence: raw.evidence ? mapEvidence(raw.evidence) : undefined,
  }
}

function mapQaAnswer(raw: ApiRecord): QaAnswer {
  return {
    answer: String(raw.answer || '当前证据不足以回答这个问题。'),
    nextSteps: Array.isArray(raw.next_steps) ? raw.next_steps.map(String) : [],
    evidenceIds: Array.isArray(raw.evidence_ids) ? raw.evidence_ids.map(String) : [],
    sources: Array.isArray(raw.sources) ? raw.sources.map(mapEvidence) : undefined,
    facts: Array.isArray(raw.facts) ? raw.facts.filter((item: ApiRecord) => item && item.statement).map((item: ApiRecord) => ({ statement: String(item.statement), evidenceIds: Array.isArray(item.evidence_ids) ? item.evidence_ids.map(String) : [] })) : undefined,
    assessment: Array.isArray(raw.assessment) ? raw.assessment.filter((item: ApiRecord) => item && item.statement).map((item: ApiRecord) => ({ statement: String(item.statement), confidence: Number(item.confidence || 0), evidenceIds: Array.isArray(item.evidence_ids) ? item.evidence_ids.map(String) : [], reviewRequired: item.review_required !== false })) : undefined,
    uncertainties: Array.isArray(raw.uncertainties) ? raw.uncertainties.map(String) : undefined,
    expertiseScope: raw.expertise_scope ? String(raw.expertise_scope) : undefined,
    intent: raw.intent ? String(raw.intent) : undefined,
    usage: raw.usage && typeof raw.usage === 'object' ? { promptTokens: Number((raw.usage as ApiRecord).prompt_tokens || 0), completionTokens: Number((raw.usage as ApiRecord).completion_tokens || 0), cachedTokens: Number((raw.usage as ApiRecord).cached_tokens || 0), totalTokens: Number((raw.usage as ApiRecord).total_tokens || 0) } : undefined,
    cost: raw.cost && typeof raw.cost === 'object' ? (() => { const cost = raw.cost as ApiRecord; return { estimated: Number(cost.estimated || 0), actual: Number(cost.actual || 0), currency: String(cost.currency || raw.currency || 'CNY'), pricingVersion: String(cost.pricing_version || raw.pricing_version || '') } })() : undefined,
    estimatedCost: raw.estimated_cost == null ? undefined : Number(raw.estimated_cost),
    actualCost: raw.actual_cost == null ? undefined : Number(raw.actual_cost),
    currency: raw.currency ? String(raw.currency) : undefined,
    pricingVersion: raw.pricing_version ? String(raw.pricing_version) : undefined,
    promptVersion: raw.prompt_version ? String(raw.prompt_version) : undefined,
    budgetStatus: raw.budget_status && typeof raw.budget_status === 'object' ? (() => { const budget = raw.budget_status as ApiRecord; const spent = (budget.spent || {}) as ApiRecord; const limits = (budget.limits || {}) as ApiRecord; const remaining = (budget.remaining || {}) as ApiRecord; return { state: String(budget.state || 'unknown'), allowed: budget.allowed !== false, estimatedCost: Number(budget.estimated_cost || 0), spent: { request: Number(spent.request || 0), project: Number(spent.project || 0), daily: Number(spent.daily || 0), monthly: Number(spent.monthly || 0) }, limits: { request: Number(limits.request || 0), project: Number(limits.project || 0), daily: Number(limits.daily || 0), monthly: Number(limits.monthly || 0) }, remaining: { request: Number(remaining.request || 0), project: Number(remaining.project || 0), daily: Number(remaining.daily || 0), monthly: Number(remaining.monthly || 0) } } })() : undefined,
    evidenceCoverage: raw.evidence_coverage && typeof raw.evidence_coverage === 'object' ? (() => { const coverage = raw.evidence_coverage as ApiRecord; const allowed = Array.isArray(coverage.allowed_evidence_ids) ? coverage.allowed_evidence_ids.map(String) : []; return { state: String(coverage.state || 'unknown'), factsTotal: Number(coverage.facts_total || 0), factsCited: Number(coverage.facts_cited || 0), assessmentTotal: Number(coverage.assessment_total || 0), assessmentCited: Number(coverage.assessment_cited || 0), allowedEvidenceIds: allowed, invalidItems: Number(coverage.invalid_items || 0) } })() : undefined,
    provider: raw.provider,
    modelVersion: raw.model_version,
    knowledgeBaseVersion: raw.knowledge_base_version,
    generatedAt: raw.generated_at,
    disclaimer: raw.disclaimer,
  }
}

function mapTask(raw: ApiRecord): TaskState {
  return {
    taskId: String(raw.task_id),
    projectId: raw.project_id ? String(raw.project_id) : undefined,
    type: raw.type,
    status: raw.status === 'running' || raw.status === 'succeeded' || raw.status === 'failed' || raw.status === 'cancelled' ? raw.status : 'queued',
    progress: Number(raw.progress || 0),
    stage: raw.stage,
    errorCode: raw.error_code,
    errorMessage: raw.error_message,
  }
}

function mapReport(raw: ApiRecord): Report {
  return {
    id: String(raw.id),
    projectId: String(raw.project_id),
    version: Number(raw.version || 1),
    content: String(raw.content || ''),
    modelVersion: raw.model_version,
    knowledgeBaseVersion: raw.knowledge_base_version,
    createdAt: raw.created_at,
    analysis: mapAnalysis(raw.analysis) || undefined,
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers })
  } catch (error) {
    throw new ApiClientError('无法连接本地 API，请先启动 backend/run.py。', 0, 'NETWORK_ERROR', error)
  }
  const contentType = response.headers.get('content-type') || ''
  const payload = response.status === 204 ? null : contentType.includes('application/json') ? await response.json() : await response.text()
  if (!response.ok) {
    const body = payload && typeof payload === 'object' ? payload as ApiRecord : {}
    throw new ApiClientError(body.message || `API 请求失败（${response.status}）`, response.status, body.code || 'API_ERROR', body.details, body.request_id)
  }
  return payload as T
}

function itemsOf<T>(payload: ApiRecord): T[] {
  return Array.isArray(payload?.items) ? payload.items : []
}

export interface UploadProgress {
  loaded: number
  total: number
  percent: number
}

export const api = {
  async health() {
    return request<ApiRecord>('/health')
  },
  async listProjects() {
    const payload = await request<ApiRecord>('/projects?page=1&page_size=100')
    return itemsOf<ApiRecord>(payload).map(mapProject)
  },
  async getProject(id: string) {
    return mapProject(await request<ApiRecord>(`/projects/${encodeURIComponent(id)}`))
  },
  async createProject(input: { name: string; region: string; category: string; description: string; privacyLevel?: Project['privacyLevel']; externalLlmConsent?: boolean }) {
    const privacyLevel = input.privacyLevel || 'local_only'
    const raw = await request<ApiRecord>('/projects', { method: 'POST', body: JSON.stringify({ name: input.name, region: input.region, category: input.category, description: input.description, privacy_level: privacyLevel, external_llm_consent: privacyLevel === 'external_allowed' && Boolean(input.externalLlmConsent) }) })
    return mapProject(raw)
  },
  async updateProject(id: string, input: Partial<Pick<Project, 'name' | 'region' | 'category' | 'description' | 'status'>>) {
    const raw = await request<ApiRecord>(`/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ ...input }) })
    return mapProject(raw)
  },
  async updatePrivacy(id: string, requestedPrivacyLevel: Project['privacyLevel'], externalLlmConsent: boolean) {
    const raw = await request<ApiRecord>(`/projects/${encodeURIComponent(id)}/privacy`, { method: 'PATCH', body: JSON.stringify({ privacy_level: requestedPrivacyLevel, external_llm_consent: externalLlmConsent }) })
    const privacyLevel: Project['privacyLevel'] = raw.privacy_level === 'external_allowed' ? 'external_allowed' : 'local_only'
    return { privacyLevel, externalLlmConsent: Boolean(raw.external_llm_consent) }
  },
  async getSettings() {
    return request<ApiRecord>('/settings')
  },
  async getUsageSummary(projectId?: string) {
    const suffix = projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''
    return request<ApiRecord>(`/usage/summary${suffix}`)
  },
  async listAssets(projectId: string) {
    const payload = await request<ApiRecord>(`/projects/${encodeURIComponent(projectId)}/assets?page=1&page_size=100`)
    return itemsOf<ApiRecord>(payload).map(mapAsset)
  },
  async getAsset(id: string) {
    return mapAsset(await request<ApiRecord>(`/assets/${encodeURIComponent(id)}`))
  },
  uploadAsset(projectId: string, file: File, metadata: { sourceNote?: string; authorizationStatus?: string } = {}, onProgress?: (progress: UploadProgress) => void) {
    return new Promise<{ asset: Asset; task: TaskState }>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${API_BASE_URL}/projects/${encodeURIComponent(projectId)}/assets`)
      xhr.responseType = 'json'
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.({ loaded: event.loaded, total: event.total, percent: Math.round(event.loaded / event.total * 100) })
      }
      xhr.onerror = () => reject(new ApiClientError('上传请求失败，请检查本地 API。', 0, 'NETWORK_ERROR'))
      xhr.onabort = () => reject(new ApiClientError('上传已取消。', 0, 'ABORTED'))
      xhr.onload = () => {
        const payload = xhr.response || {}
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new ApiClientError(payload.message || `上传失败（${xhr.status}）`, xhr.status, payload.code || 'UPLOAD_ERROR', payload.details, payload.request_id))
          return
        }
        resolve({ asset: mapAsset(payload.asset || payload), task: mapTask(payload.task || { task_id: payload.task_id, status: 'queued', progress: 0 }) })
      }
      const form = new FormData()
      form.append('file', file)
      if (metadata.sourceNote) form.append('source_note', metadata.sourceNote)
      if (metadata.authorizationStatus) form.append('authorization_status', metadata.authorizationStatus)
      xhr.send(form)
    })
  },
  async deleteAsset(id: string) {
    await request<void>(`/assets/${encodeURIComponent(id)}?confirm=true`, { method: 'DELETE' })
  },
  async retryTask(id: string) {
    const raw = await request<ApiRecord>(`/tasks/${encodeURIComponent(id)}/retry`, { method: 'POST', body: JSON.stringify({}) })
    return mapTask(raw)
  },
  async getTask(id: string) {
    return mapTask(await request<ApiRecord>(`/tasks/${encodeURIComponent(id)}`))
  },
  async getAnalysis(projectId: string) {
    return mapAnalysis(await request<ApiRecord>(`/projects/${encodeURIComponent(projectId)}/analysis`))
  },
  async searchProject(projectId: string, query: string) {
    const payload = await request<ApiRecord>(`/projects/${encodeURIComponent(projectId)}/search`, { method: 'POST', body: JSON.stringify({ query }) })
    return { items: itemsOf<ApiRecord>(payload).map(mapSearchResult), total: Number(payload.total || 0), provider: String(payload.provider || 'mock-search'), knowledgeBaseVersion: payload.knowledge_base_version }
  },
  async askProject(projectId: string, question: string) {
    return mapQaAnswer(await request<ApiRecord>(`/projects/${encodeURIComponent(projectId)}/ask`, { method: 'POST', body: JSON.stringify({ question }) }))
  },
  async listEntities(projectId: string) {
    const payload = await request<ApiRecord>(`/projects/${encodeURIComponent(projectId)}/entities?page=1&page_size=100`)
    return itemsOf<ApiRecord>(payload).map(mapEntity)
  },
  async listFindings(projectId: string) {
    const payload = await request<ApiRecord>(`/projects/${encodeURIComponent(projectId)}/findings?page=1&page_size=100`)
    return itemsOf<ApiRecord>(payload).map(mapFinding)
  },
  async patchEntity(projectId: string, entityId: string, updates: Partial<Entity>) {
    const raw = await request<ApiRecord>(`/projects/${encodeURIComponent(projectId)}/entities/${encodeURIComponent(entityId)}`, { method: 'PATCH', body: JSON.stringify({ value: updates.value, review_status: updates.review === '已确认' ? 'confirmed' : updates.review === '待核验' ? 'needs_review' : 'unreviewed' }) })
    return mapEntity(raw)
  },
  async patchFinding(projectId: string, findingId: string, updates: Partial<Finding>) {
    const raw = await request<ApiRecord>(`/projects/${encodeURIComponent(projectId)}/findings/${encodeURIComponent(findingId)}`, { method: 'PATCH', body: JSON.stringify({ level: updates.level, status: updates.status === '已确认' ? 'confirmed' : updates.status === '已驳回' ? 'rejected' : 'open' }) })
    return mapFinding(raw)
  },
  async startAnalysis(projectId: string, rightTypes = ['trademark', 'copyright', 'geographical_indication']) {
    const raw = await request<ApiRecord>(`/projects/${encodeURIComponent(projectId)}/analysis`, { method: 'POST', body: JSON.stringify({ right_types: rightTypes }) })
    return { task: mapTask({ task_id: raw.task_id, project_id: projectId, status: raw.status, progress: raw.status === 'succeeded' ? 100 : 0 }), raw }
  },
  async listReports(projectId: string) {
    const payload = await request<ApiRecord>(`/projects/${encodeURIComponent(projectId)}/reports?page=1&page_size=100`)
    return itemsOf<ApiRecord>(payload).map(mapReport)
  },
  async generateReport(projectId: string, format: 'markdown' | 'json' = 'markdown') {
    const raw = await request<ApiRecord>(`/projects/${encodeURIComponent(projectId)}/reports`, { method: 'POST', body: JSON.stringify({ format }) })
    return { task: mapTask({ task_id: raw.task_id, project_id: projectId, status: raw.status, progress: raw.status === 'succeeded' ? 100 : 0 }), reportId: raw.report_id ? String(raw.report_id) : undefined }
  },
  async getReport(id: string) {
    return mapReport(await request<ApiRecord>(`/reports/${encodeURIComponent(id)}`))
  },
  async exportReport(id: string, format: 'md' | 'json') {
    const response = await fetch(`${API_BASE_URL}/reports/${encodeURIComponent(id)}/export?format=${format}`)
    if (!response.ok) throw new ApiClientError('报告导出失败。', response.status, 'EXPORT_ERROR')
    return response.blob()
  },
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export { mapAnalysis, mapAsset, mapEntity, mapEvidence, mapFinding, mapProject, mapReport, mapTask }
