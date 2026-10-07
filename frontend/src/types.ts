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
}
