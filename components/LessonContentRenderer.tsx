'use client'

import { useState } from 'react'

export default function LessonContentRenderer({ content }: { content: string }) {
  const blocks = content.split(/\n\n+/).filter(b => b.trim())

  const getHeading = (block: string) => {
    const lines = block.split('\n').filter(l => l.trim())
    if (lines.length === 0) return null
    if (lines[0].trim() === 'SVG_GRAPHIC:') return null
    const first = lines[0].trim()
    const isHeading =
      first.length < 70 &&
      !first.endsWith('.') &&
      !/^\d+\.\s/.test(first)
    return isHeading ? first : null
  }

  type Item =
    | { type: 'block'; block: string }
    | { type: 'reveal'; blocks: string[]; key: number }

  const items: Item[] = []
  let i = 0
  let groupKey = 0
  while (i < blocks.length) {
    const heading = getHeading(blocks[i])
    if (heading === 'Model Interview Answer') {
      const group: string[] = []
      while (i < blocks.length) {
        const h = getHeading(blocks[i])
        if (h && /^Case\s+\d+/i.test(h) && group.length > 0) break
        group.push(blocks[i])
        i++
      }
      items.push({ type: 'reveal', blocks: group, key: groupKey })
      groupKey++
    } else {
      items.push({ type: 'block', block: blocks[i] })
      i++
    }
  }

  const [revealed, setRevealed] = useState<Record<number, boolean>>({})
  const [answerRevealed, setAnswerRevealed] = useState<Record<string, boolean>>({})

  const renderBlock = (block: string, blockIdx: number | string) => {
    const lines = block.split('\n').filter(l => l.trim())
    if (lines.length === 0) return null

    // Check for the SVG graphic marker FIRST, on the raw first line, before
    // any heading logic runs - otherwise "SVG_GRAPHIC:" itself gets consumed
    // as a heading title and stripped off before this check ever sees it.
    if (lines[0].trim() === 'SVG_GRAPHIC:') {
      const svgMarkup = lines.slice(1).join('\n')
      return (
        <div
          key={blockIdx}
          className="w-full overflow-x-auto bg-white rounded-xl border border-gray-200 p-3 sm:p-4"
          dangerouslySetInnerHTML={{ __html: svgMarkup }}
        />
      )
    }

    const firstLine = lines[0].trim()
    const isHeading =
      firstLine.length < 70 &&
      !firstLine.endsWith('.') &&
      !/^\d+\.\s/.test(firstLine)

    const bodyLines = isHeading ? lines.slice(1) : lines

    const isTable = bodyLines[0]?.trim() === 'TABLE:'
    const isNumberedList = !isTable && bodyLines.length > 1 && bodyLines.every(l => /^\d+\.\s/.test(l.trim()))
    const labelValuePattern = /^([A-Za-z][^:]{2,40}):\s(.+)$/
    const isReferenceList =
      !isTable &&
      !isNumberedList &&
      bodyLines.length >= 3 &&
      bodyLines.every(l => labelValuePattern.test(l.trim()))

    // Detect an "Answer:" line inside a plain-text block (used for in-lesson
    // Knowledge Check questions) and hide it behind a reveal toggle, so
    // learners can attempt the question before seeing the answer.
    const answerLineIdx = (!isTable && !isNumberedList && !isReferenceList)
      ? bodyLines.findIndex(l => /^Answer:/.test(l.trim()))
      : -1
    const hasHiddenAnswer = answerLineIdx !== -1
    const answerKey = `answer-${blockIdx}`
    const isAnswerRevealed = !!answerRevealed[answerKey]

    return (
      <div key={blockIdx}>
        {isHeading && (
          <h3 className="text-lg sm:text-xl font-bold text-purple-700 mb-3 mt-2">
            {firstLine}
          </h3>
        )}

        {isTable ? (
          (() => {
            const rows = bodyLines.slice(1).map(l => l.split('|').map(cell => cell.trim()))
            const [header, ...dataRows] = rows
            return (
              <div className="overflow-x-auto -mx-1 px-1">
                <table className="w-full border-collapse text-xs sm:text-sm">
                  <thead>
                    <tr>
                      {header.map((h, idx) => (
                        <th key={idx} className={`text-left font-bold text-white bg-purple-600 px-3 py-2.5 ${idx === 0 ? 'rounded-tl-lg' : ''} ${idx === header.length - 1 ? 'rounded-tr-lg' : ''}`}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {dataRows.map((row, rIdx) => (
                      <tr key={rIdx} className={rIdx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                        {row.map((cell, cIdx) => (
                          <td key={cIdx} className={`px-3 py-2.5 border-b border-gray-100 text-gray-700 align-top ${cIdx === 0 ? 'font-semibold text-gray-900' : ''}`}>
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          })()
        ) : isReferenceList ? (
          <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 sm:p-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
              {bodyLines.map((line, idx) => {
                const match = line.trim().match(labelValuePattern)
                if (!match) return null
                return (
                  <div key={idx} className="flex justify-between items-baseline border-b border-gray-200 pb-2 sm:border-0 sm:pb-0">
                    <span className="text-gray-500 text-xs sm:text-sm font-medium">{match[1]}</span>
                    <span className="text-gray-900 text-sm sm:text-base font-semibold ml-3 text-right">{match[2]}</span>
                  </div>
                )
              })}
            </div>
          </div>
        ) : isNumberedList ? (
          <ol className="space-y-3 pl-1">
            {bodyLines.map((line, idx) => {
              const match = line.trim().match(/^(\d+)\.\s(.*)/)
              const label = match ? match[1] : String(idx + 1)
              const text = match ? match[2] : line
              const boldMatch = text.match(/^([^-]+?)\s*-\s*(.*)/)
              return (
                <li key={idx} className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-purple-100 text-purple-700 text-xs font-bold flex items-center justify-center mt-0.5">
                    {label}
                  </span>
                  <span className="text-gray-700 text-sm sm:text-base leading-relaxed">
                    {boldMatch ? (
                      <>
                        <strong className="text-gray-900">{boldMatch[1]}</strong>
                        {' - ' + boldMatch[2]}
                      </>
                    ) : text}
                  </span>
                </li>
              )
            })}
          </ol>
        ) : hasHiddenAnswer ? (
          <div>
            {bodyLines.slice(0, answerLineIdx).map((line, idx) => (
              <p key={idx} className="text-gray-700 text-sm sm:text-base leading-relaxed mb-3 last:mb-0">
                {line}
              </p>
            ))}
            {!isAnswerRevealed ? (
              <button
                onClick={() => setAnswerRevealed(prev => ({ ...prev, [answerKey]: true }))}
                className="mt-1 px-4 py-2 bg-purple-100 text-purple-700 text-sm font-semibold rounded-lg hover:bg-purple-200 transition"
              >
                Reveal Answer
              </button>
            ) : (
              <div className="mt-2 bg-green-50 border border-green-200 rounded-xl p-3 sm:p-4">
                {bodyLines.slice(answerLineIdx).map((line, idx) => (
                  <p key={idx} className="text-green-900 text-sm sm:text-base leading-relaxed mb-2 last:mb-0">
                    {line}
                  </p>
                ))}
                <button
                  onClick={() => setAnswerRevealed(prev => ({ ...prev, [answerKey]: false }))}
                  className="mt-1 text-purple-600 text-xs font-semibold hover:underline"
                >
                  Hide answer
                </button>
              </div>
            )}
          </div>
        ) : (
          bodyLines.map((line, idx) => {
            const labelMatch = line.match(/^([A-Z][^:]{2,60}):\s(.*)/)
            return (
              <p key={idx} className="text-gray-700 text-sm sm:text-base leading-relaxed mb-3 last:mb-0">
                {labelMatch ? (
                  <>
                    <strong className="text-gray-900">{labelMatch[1]}:</strong>
                    {' ' + labelMatch[2]}
                  </>
                ) : line}
              </p>
            )
          })
        )}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {items.map((item, idx) => {
        if (item.type === 'block') {
          return renderBlock(item.block, idx)
        }

        const isRevealed = !!revealed[item.key]
        return (
          <div key={`reveal-${item.key}`}>
            {!isRevealed ? (
              <button
                onClick={() => setRevealed(prev => ({ ...prev, [item.key]: true }))}
                className="w-full flex items-center justify-center gap-2 px-6 py-4 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition"
              >
                🔍 Reveal Model Answer
              </button>
            ) : (
              <div className="space-y-6">
                {item.blocks.map((b, bi) => renderBlock(b, `${item.key}-${bi}`))}
                <button
                  onClick={() => setRevealed(prev => ({ ...prev, [item.key]: false }))}
                  className="text-purple-600 text-sm font-semibold hover:underline"
                >
                  Hide answer
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
