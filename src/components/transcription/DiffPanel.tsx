/**
 * 段落差异对比面板
 * 展示单个段落的字级 diff，高亮差异并提供 AI 解释 Popover
 * 同时展示参考稿本身的问题（AI 分析得出）供用户决断
 * 支持"采纳修正"按钮一键应用参考稿/AI 建议的正确文本
 */
import { useState } from 'react'
import { Info, Check, AlertTriangle } from 'lucide-react'
import { Popover } from '@/components/ui/Popover'
import type { SegmentDiff } from '@/types/reference'

interface DiffPanelProps {
  diff: SegmentDiff
  onAcceptAll?: () => void
  mode?: 'reference' | 'ai'
}

export function DiffPanel({ diff, onAcceptAll, mode = 'reference' }: DiffPanelProps) {
  const [expanded, setExpanded] = useState(false)

  if (!diff.hasDifference && diff.referenceIssues.length === 0) return null

  const hasDiff = diff.hasDifference
  const issueCount = diff.referenceIssues.length

  return (
    <div className="diff-panel">
      <div className="diff-panel__header" onClick={() => setExpanded(!expanded)}>
        <span className="diff-panel__toggle">{expanded ? '▾' : '▸'}</span>
        {hasDiff && (
          <span className="diff-panel__count">{diff.totalChanges} 处差异</span>
        )}
        {issueCount > 0 && (
          <span className="diff-panel__issue-count">
            <AlertTriangle size={12} /> {issueCount} 处参考稿疑问
          </span>
        )}
        <span className="diff-panel__label">{mode === 'ai' ? 'AI 纠错' : '参考稿对比'}</span>
        {onAcceptAll && hasDiff && (
          <button
            className="diff-panel__accept-all-btn"
            onClick={(e) => { e.stopPropagation(); onAcceptAll() }}
          >
            <Check size={12} /> 采纳修正
          </button>
        )}
      </div>

      {expanded && (
        <div className="diff-panel__body">
          {hasDiff && (
            <div className="diff-panel__chunks">
              {diff.chunks.map((chunk, idx) => {
                if (chunk.type === 'equal') {
                  return <span key={idx} className="diff-panel__chunk--equal">{chunk.value}</span>
                }

                const explanation = diff.explanations[idx]
                const content = (
                  <span
                    key={idx}
                    className={`diff-panel__chunk diff-panel__chunk--${chunk.type}`}
                  >
                    {chunk.value}
                  </span>
                )

                if (explanation) {
                  return (
                    <Popover
                      key={idx}
                      content={
                        <div className="diff-panel__popover">
                          <p className="diff-panel__explanation">{explanation.explanation}</p>
                          {explanation.dictionaryHint && (
                            <p className="diff-panel__dict">{explanation.dictionaryHint}</p>
                          )}
                        </div>
                      }
                      trigger="click"
                      placement="top"
                    >
                      {content}
                    </Popover>
                  )
                }

                return (
                  <Popover
                    key={idx}
                    content={<span className="diff-panel__no-explanation"><Info size={12} /> 暂无解释</span>}
                    trigger="click"
                    placement="top"
                  >
                    {content}
                  </Popover>
                )
              })}
            </div>
          )}

          {issueCount > 0 && (
            <div className="diff-panel__reference-issues">
              <div className="diff-panel__issues-title">
                <AlertTriangle size={12} /> 参考稿疑问
              </div>
              {diff.referenceIssues.map((issue, idx) => (
                <div key={idx} className="diff-panel__issue-item">
                  <div className="diff-panel__issue-text">
                    <span className="diff-panel__issue-label">原文</span>
                    <span className="diff-panel__issue-value">{issue.text}</span>
                    {issue.suggestion && (
                      <>
                        <span className="diff-panel__issue-arrow">→</span>
                        <span className="diff-panel__issue-label">建议</span>
                        <span className="diff-panel__issue-suggestion">{issue.suggestion}</span>
                      </>
                    )}
                  </div>
                  <div className="diff-panel__issue-explanation">
                    {issue.explanation}
                  </div>
                  {issue.dictionaryHint && (
                    <div className="diff-panel__issue-dict">
                      {issue.dictionaryHint}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
