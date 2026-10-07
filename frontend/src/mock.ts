import type { Asset, Entity, Evidence, Finding, Project } from './types'

export const project: Project = {
  id: 'project-tea-001',
  name: '云岭茶旅品牌保护初筛',
  region: '云南 · 普洱市',
  category: '农文旅',
  description: '围绕古树茶、茶园民宿与山野体验路线建立品牌资产档案。',
  status: 'active',
  privacyLevel: 'local_only',
}

export const assets: Asset[] = [
  { id: 'a-1', name: '云岭茶旅品牌说明.pdf', type: 'PDF', size: '2.4 MB', source: '团队自有材料', status: 'succeeded', authorization: '已声明', updatedAt: '今天 10:32' },
  { id: 'a-2', name: '山野茶席宣传文案.docx', type: 'DOCX', size: '86 KB', source: '运营团队', status: 'succeeded', authorization: '待补充', updatedAt: '今天 10:35' },
  { id: 'a-3', name: '茶园入口标识.jpg', type: 'JPG', size: '1.1 MB', source: '项目现场拍摄', status: 'manual_required', authorization: '已声明', updatedAt: '今天 10:38' },
]

export const entities: Entity[] = [
  { id: 'e-1', value: '云岭茶旅', type: '品牌名称', source: '品牌说明 · p1', confidence: 0.98, review: '已确认' },
  { id: 'e-2', value: '普洱市景迈山', type: '产地/地名', source: '品牌说明 · p1', confidence: 0.94, review: '已确认' },
  { id: 'e-3', value: '古树茶体验', type: '产品服务', source: '品牌说明 · p2', confidence: 0.91, review: '待确认' },
  { id: 'e-4', value: '山野茶席', type: '活动名称', source: '宣传文案 · p1', confidence: 0.88, review: '待确认' },
  { id: 'e-5', value: '茶园入口图形标识', type: '视觉元素', source: '入口标识.jpg', confidence: 0.76, review: '待核验' },
  { id: 'e-6', value: '雨林慢生活', type: '宣传口号', source: '宣传文案 · p2', confidence: 0.84, review: '待确认' },
]

export const findings: Finding[] = [
  { id: 'f-1', level: 'medium', type: '商标', title: '名称含地域与产品通用词', trigger: '“云岭”“茶旅”均可能属于地域或行业常用表达，独特识别部分尚需核验。', evidence: ['ev-1', 'ev-2'], recommendation: '按商品/服务类别拆分检索同名与近似名称，保留检索截图。', status: '待处理' },
  { id: 'f-2', level: 'medium', type: '版权', title: '宣传文案缺少作者与授权凭证', trigger: '当前材料只记录了文案来源团队，未记录具体作者、创作时间和权利归属。', evidence: ['ev-3'], recommendation: '补充作者、创作时间、职务创作或委托创作约定。', status: '待处理' },
  { id: 'f-3', level: 'insufficient', type: '地理标志', title: '地域关联线索尚不足以确认', trigger: '已识别产地，但缺少质量特征、传统工艺或官方登记来源。', evidence: ['ev-1'], recommendation: '补充产品质量特征与官方公告来源，交由专业人员复核。', status: '待处理' },
  { id: 'f-4', level: 'low', type: '素材授权', title: '现场照片已有来源声明', trigger: '文件标记为项目现场拍摄，但拍摄者和可公开范围尚未填写。', evidence: ['ev-4'], recommendation: '补充拍摄者、拍摄日期及对外发布范围。', status: '已确认' },
]

export const evidence: Evidence[] = [
  { id: 'ev-1', title: '地理标志查询服务 · 查询说明', publisher: '国家知识产权局', excerpt: '地理标志相关权利线索需要结合地域关联、产品质量特色和官方登记信息进行进一步核验。', source: 'cnipa.gov.cn/col/col256/index.html', publishedAt: '2025-08-12', status: 'verified' },
  { id: 'ev-2', title: '商标审查审理指南（节选）', publisher: '国家知识产权局', excerpt: '判断标志显著性时，应综合考虑标志构成、指定商品或服务以及相关公众的认知。', source: 'cnipa.gov.cn', publishedAt: '2024-11-01', status: 'verified' },
  { id: 'ev-3', title: '项目材料 · 山野茶席宣传文案', publisher: '当前项目材料', excerpt: '“雨林慢生活，从一席茶开始。”（作者、创作时间待补录）', source: '山野茶席宣传文案.docx · p2', publishedAt: '访问于 2026-10-07', status: 'pending' },
  { id: 'ev-4', title: '项目材料 · 茶园入口标识', publisher: '当前项目材料', excerpt: '文件元数据：JPG，1.1 MB。来源备注：项目现场拍摄。', source: '茶园入口标识.jpg', publishedAt: '访问于 2026-10-07', status: 'pending' },
]
