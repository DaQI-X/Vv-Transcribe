/**
 * 常见中文语音识别同音/近音错误映射表
 *
 * 拆成两张表是因为这两类数据的安全处理方式完全不同：
 * - ASR_ERROR_MAP：wrong 形态本身是错别字（不是词），可以无脑全局替换
 * - ASR_USAGE_DISTINCTIONS：wrong 和 correct 都是合法词，只是语义不同。
 *   这条链路是顺序全局替换，互逆词对会互相抵消（权利→权力→权利），
 *   还会把本来正确的用字改反，所以只做提示、不参与替换。
 */

export interface ASRErrorEntry {
  wrong: string
  correct: string
  category: string
  note?: string
}

/** 确定性修正表：命中即替换 */
export const ASR_ERROR_MAP: ASRErrorEntry[] = [
  { wrong: '决性', correct: '觉性', category: '同音字' },
  { wrong: '再急', correct: '在即', category: '同音字' },
  { wrong: '在见', correct: '再见', category: '同音字' },
  { wrong: '以经', correct: '已经', category: '同音字' },
  { wrong: '做用', correct: '作用', category: '同音字' },
  { wrong: '象是', correct: '像是', category: '同音字' },
  { wrong: '那末', correct: '那么', category: '同音字' },
  { wrong: '交待', correct: '交代', category: '同音字' },
  { wrong: '好象', correct: '好像', category: '同音字' },
  { wrong: '简炼', correct: '简练', category: '同音字' },
  { wrong: '精萃', correct: '精粹', category: '同音字' },
  { wrong: '罗嗦', correct: '啰嗦', category: '同音字' },
  { wrong: '冒然', correct: '贸然', category: '同音字' },
  { wrong: '名信片', correct: '明信片', category: '同音字' },
  { wrong: '气慨', correct: '气概', category: '同音字' },
  { wrong: '震憾', correct: '震撼', category: '同音字' },
  { wrong: '编篡', correct: '编纂', category: '同音字' },
  { wrong: '了望', correct: '瞭望', category: '同音字' },
  { wrong: '了如', correct: '瞭如', category: '同音字' },
  { wrong: '材华', correct: '才华', category: '同音字' },
  { wrong: '苍海', correct: '沧海', category: '同音字' },
  { wrong: '层峦迭嶂', correct: '层峦叠嶂', category: '同音字' },
  { wrong: '插科打浑', correct: '插科打诨', category: '同音字' },
  { wrong: '蝉连', correct: '蝉联', category: '同音字' },
  { wrong: '惨忍', correct: '残忍', category: '同音字' },
  { wrong: '侧隐', correct: '恻隐', category: '同音字' },
  { wrong: '叉路', correct: '岔路', category: '同音字' },
  { wrong: '茶坐', correct: '茶座', category: '同音字' },
  { wrong: '馋言', correct: '谗言', category: '同音字' },
  { wrong: '产除', correct: '铲除', category: '同音字' },
  { wrong: '尝式', correct: '尝试', category: '同音字' },
  { wrong: '愁怅', correct: '惆怅', category: '同音字' },
  { wrong: '仇狠', correct: '仇恨', category: '同音字' },
  { wrong: '揣摸', correct: '揣摩', category: '同音字' },
  { wrong: '串连', correct: '串联', category: '同音字' },
  { wrong: '默守成规', correct: '墨守成规', category: '成语错误' },
  { wrong: '迫不急待', correct: '迫不及待', category: '成语错误' },
  { wrong: '走头无路', correct: '走投无路', category: '成语错误' },
  { wrong: '再接再励', correct: '再接再厉', category: '成语错误' },
  { wrong: '一愁莫展', correct: '一筹莫展', category: '成语错误' },
  { wrong: '穿流不息', correct: '川流不息', category: '成语错误' },
  { wrong: '天翻地复', correct: '天翻地覆', category: '成语错误' },
  { wrong: '言简意骇', correct: '言简意赅', category: '成语错误' },
  { wrong: '察颜观色', correct: '察言观色', category: '成语错误' },
  { wrong: '帐号', correct: '账号', category: '用词规范' },
  { wrong: '其它', correct: '其他', category: '用词规范' },
]

/** 同音近义词辨析表：只注入 prompt 供模型判断，不参与替换 */
export const ASR_USAGE_DISTINCTIONS: ASRErrorEntry[] = [
  { wrong: '权力', correct: '权利', category: '同音字', note: '政治力量用「权力」，法律权益用「权利」' },
  { wrong: '反映', correct: '反应', category: '同音字', note: '表达意见用「反映」，机体受刺激用「反应」' },
  { wrong: '包含', correct: '包涵', category: '同音字', note: '里面含有用「包含」，请人原谅用「包涵」' },
  { wrong: '必须', correct: '必需', category: '同音字', note: '一定要用「必须」，不可少用「必需」' },
  { wrong: '不齿', correct: '不耻', category: '同音字', note: '不愿提到用「不齿」，不以……为耻用「不耻」' },
  { wrong: '不止', correct: '不只', category: '同音字', note: '继续不停用「不止」，不但用「不只」' },
  { wrong: '须要', correct: '需要', category: '同音字', note: '「须要」强调一定要，「需要」强调有所要求' },
  { wrong: '汇合', correct: '会合', category: '同音字', note: '水流聚合用「汇合」，人员聚集用「会合」' },
  { wrong: '合拢', correct: '合龙', category: '同音字', note: '桥梁施工完成用「合龙」，开合的「合拢」是另一个词' },
  { wrong: '化装', correct: '化妆', category: '同音字', note: '美容用「化妆」，伪装改扮用「化装」' },
]
