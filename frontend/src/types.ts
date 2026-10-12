export type View = 'overview' | 'assets' | 'entities' | 'analysis' | 'search' | 'findings' | 'reports' | 'settings'
export type RiskLevel = 'high' | 'medium' | 'low' | 'insufficient'

export interface Project {
  id: string
  name: string
  region: string
  category: string
  description: string
  status: 'draft' | 'active' | 'archived'
  privacyLevel: 'local_only' | 'external_allowed'
  externalLlmConsent?: boolean
  assetsCount?: number
  createdAt?: string
  updatedAt?: string
}

export interface Asset {
  id: string
  name: string
  type: string
  size: string
  source: string
  status: 'succeeded' | 'processing' | 'failed' | 'manual_required'
  authorization: '已声明' | '待补充' | '已核验'
  updatedAt: string
  taskId?: string
  progress?: number
  errorMessage?: string
}

export interface Entity {
  id: string
  value: string
  type: string
  source: string
  confidence: number
  review: '待确认' | '已确认' | '待核验'
}

export interface Finding {
  id: string
  level: RiskLevel
  type: string
  title: string
  trigger: string
  evidence: string[]
  recommendation: string
  status: '待处理' | '已确认' | '已驳回'
}

export interface Evidence {
  id: string
  title: string
  publisher: string
  excerpt: string
  source: string
  publishedAt: string
  status: 'verified' | 'pending' | 'invalid'
  accessedAt?: string
  supports?: string[]
  limits?: string[]
}

export interface SearchResult {
  id: string
  title: string
  kind: string
  region: string
  match: string
  source: string
  evidenceId?: string
  evidence?: Evidence
}

export interface QaUsage {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  totalTokens: number
}

export interface QaCost {
  estimated: number
  actual: number
  currency: string
  pricingVersion: string
}

export interface QaBudgetStatus {
  state: 'ok' | 'exceeded' | 'not_applicable' | string
  allowed: boolean
  estimatedCost: number
  spent: { request: number; project: number; daily: number; monthly: number }
  limits: { request: number; project: number; daily: number; monthly: number }
  remaining: { request: number; project: number; daily: number; monthly: number }
}

export interface QaEvidenceCoverage {
  state: 'pass' | 'insufficient' | 'failed' | string
  factsTotal: number
  factsCited: number
  assessmentTotal: number
  assessmentCited: number
  allowedEvidenceIds: string[]
  invalidItems?: number
}

export interface QaAnswer {
  answer: string
  nextSteps: string[]
  evidenceIds: string[]
  sources?: Evidence[]
  facts?: Array<{ statement: string; evidenceIds: string[] }>
  assessment?: Array<{ statement: string; confidence: number; evidenceIds: string[]; reviewRequired: boolean }>
  uncertainties?: string[]
  expertiseScope?: string
  intent?: string
  usage?: QaUsage
  cost?: QaCost
  estimatedCost?: number
  actualCost?: number
  currency?: string
  pricingVersion?: string
  promptVersion?: string
  budgetStatus?: QaBudgetStatus
  evidenceCoverage?: QaEvidenceCoverage
  provider?: 'mock' | 'deepseek' | string
  modelVersion?: string
  knowledgeBaseVersion?: string
  generatedAt?: string
  disclaimer?: string
}

export interface AnalysisResult {
  summary: string
  provider?: 'mock' | 'deepseek' | string
  entities: Entity[]
  findings: Finding[]
  evidence: Evidence[]
  rightCandidates: Array<{ id: string; rightType: string; reason: string; confidence: number; reviewRequired: boolean }>
  missingInformation: string[]
  modelVersion?: string
  knowledgeBaseVersion?: string
  generatedAt?: string
  disclaimer?: string
}

export interface TaskState {
  taskId: string
  projectId?: string
  type?: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  progress: number
  stage?: string
  errorCode?: string | null
  errorMessage?: string | null
}

export interface Report {
  id: string
  projectId: string
  version: number
  content: string
  modelVersion?: string
  knowledgeBaseVersion?: string
  createdAt?: string
  analysis?: AnalysisResult
}
