'use strict'
// ─────────────────────────────────────────────────────────────────────────────
// grader.js — Letter grade computation + actionable recommendations
//
// Computes an overall A-F grade from consistency + quality + reliability,
// generates category-level grades, and produces specific recommendations.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute letter grade from a numeric score (0-100)
 */
function letterGrade(score) {
  if (score >= 93) return 'A'
  if (score >= 90) return 'A-'
  if (score >= 87) return 'B+'
  if (score >= 83) return 'B'
  if (score >= 80) return 'B-'
  if (score >= 77) return 'C+'
  if (score >= 73) return 'C'
  if (score >= 70) return 'C-'
  if (score >= 60) return 'D'
  return 'F'
}

/**
 * Compute grade color for PDF rendering
 */
function gradeColor(grade) {
  if (grade.startsWith('A')) return '#1a7f3c'
  if (grade.startsWith('B')) return '#0057b7'
  if (grade.startsWith('C')) return '#e07b00'
  if (grade.startsWith('D')) return '#c8102e'
  return '#c8102e'
}

/**
 * Generate actionable recommendations based on results
 */
function generateRecommendations(results) {
  const recs = []

  // Group results by category
  const byCategory = {}
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = []
    byCategory[r.category].push(r)
  }

  // Check for failed responses (bot didn't understand)
  const failedQuestions = results.filter(r =>
    r.quality && r.quality.scores.some(s => s.rating === 'failed')
  )
  if (failedQuestions.length > 0) {
    recs.push({
      priority: 'high',
      category: failedQuestions[0].category,
      title: 'Bot fails to understand common questions',
      text: `Your bot could not understand ${failedQuestions.length} of ${results.length} test questions, responding with "I didn't catch that" or similar. Consider expanding your bot's training data or intent recognition for: ${failedQuestions.map(q => '"' + q.question.slice(0, 50) + '"').join(', ')}.`,
    })
  }

  // Check for contradictory responses
  const contradictory = results.filter(r =>
    r.similarity && r.similarity.classification === 'contradictory'
  )
  if (contradictory.length > 0) {
    recs.push({
      priority: 'high',
      category: contradictory[0].category,
      title: 'Contradictory answers detected',
      text: `${contradictory.length} question(s) received significantly different answers across runs. This means customers asking the same question may get conflicting information — a trust-eroding experience. Affected areas: ${contradictory.map(q => q.category).filter((v, i, a) => a.indexOf(v) === i).join(', ')}.`,
    })
  }

  // Check for deflections
  const deflected = results.filter(r =>
    r.quality && r.quality.scores.some(s => s.rating === 'deflected')
  )
  if (deflected.length > 0) {
    recs.push({
      priority: 'medium',
      category: deflected[0].category,
      title: 'Generic deflections instead of answers',
      text: `${deflected.length} question(s) received deflective responses ("visit our help center") without specific guidance. Customers expect direct answers — add specific knowledge base content for: ${deflected.map(q => q.category).filter((v, i, a) => a.indexOf(v) === i).join(', ')}.`,
    })
  }

  // Check escalation handling
  const escalationQs = results.filter(r => r.category.includes('Escalation'))
  if (escalationQs.length > 0) {
    const noEscalation = escalationQs.filter(r =>
      r.quality && !r.quality.scores.some(s => s.flags.includes('escalation_offered'))
    )
    if (noEscalation.length > 0) {
      recs.push({
        priority: 'high',
        category: 'Escalation',
        title: 'No clear path to human agent',
        text: `When customers explicitly asked to speak with a human, ${noEscalation.length} of ${escalationQs.length} escalation questions did not offer a clear path to a live agent. Frustrated customers who can't reach a human are likely to churn.`,
      })
    }
  }

  // Check response times
  const avgTimes = results.map(r => {
    const times = r.runs.filter(run => !run.error).map(run => run.responseTimeMs)
    return times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0
  }).filter(t => t > 0)
  const overallAvg = avgTimes.length > 0 ? avgTimes.reduce((a, b) => a + b, 0) / avgTimes.length : 0
  if (overallAvg > 10000) {
    recs.push({
      priority: 'medium',
      category: 'Performance',
      title: 'Slow response times',
      text: `Average response time is ${(overallAvg / 1000).toFixed(1)}s, significantly above the 3-5 second industry standard. Slow bots frustrate customers and increase abandonment rates.`,
    })
  }

  // Check edge case handling
  const edgeQs = results.filter(r => r.category === 'Edge Case')
  if (edgeQs.length > 0) {
    const edgeFailed = edgeQs.filter(r =>
      r.quality && r.quality.scores.some(s => s.rating === 'failed')
    )
    if (edgeFailed.length > 0) {
      recs.push({
        priority: 'low',
        category: 'Edge Case',
        title: 'Graceful handling of unexpected input',
        text: `When given nonsensical input, the bot's error handling could be improved. Consider adding a friendlier fallback message that guides users toward valid questions.`,
      })
    }
  }

  // Sort by priority
  const priorityOrder = { high: 0, medium: 1, low: 2 }
  recs.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])

  return recs.slice(0, 5)  // Top 5 recommendations
}

/**
 * Generate executive summary text
 */
function generateExecutiveSummary(results, summary, categoryGrades) {
  const totalQ = results.length
  const goodCategories = Object.entries(categoryGrades)
    .filter(([, g]) => g.grade.startsWith('A') || g.grade.startsWith('B'))
    .map(([cat]) => cat)
  const weakCategories = Object.entries(categoryGrades)
    .filter(([, g]) => g.grade.startsWith('D') || g.grade === 'F')
    .map(([cat]) => cat)

  const parts = []
  parts.push(`Your support bot was tested with ${totalQ} questions, each asked ${Math.round(summary.totalRuns / totalQ)} times to check for consistency.`)

  if (goodCategories.length > 0 && weakCategories.length > 0) {
    parts.push(`It performs well on ${goodCategories.join(' and ')} questions but struggles with ${weakCategories.join(' and ')}.`)
  } else if (goodCategories.length > 0) {
    parts.push(`It performs consistently well across ${goodCategories.join(', ')}.`)
  } else if (weakCategories.length > 0) {
    parts.push(`It struggles with ${weakCategories.join(' and ')} questions, which are common customer support scenarios.`)
  }

  const errors = summary.errors || 0
  if (errors > 0) {
    parts.push(`${errors} run(s) resulted in errors or no response.`)
  }

  const avgTime = (summary.avgResponseTimeMs / 1000).toFixed(1)
  if (summary.avgResponseTimeMs > 8000) {
    parts.push(`Average response time is ${avgTime}s — above the 3-5s industry standard.`)
  } else {
    parts.push(`Average response time is ${avgTime}s.`)
  }

  return parts.join(' ')
}

/**
 * Compute grades for all results
 *
 * @param {object[]} results - Results array from tester (with similarity and quality data)
 * @param {object} summary - Summary object from tester
 * @returns {{ overallScore, overallGrade, categoryGrades, executiveSummary, recommendations }}
 */
function computeGrades(results, summary) {
  // ── Category-level grades ─────────────────────────────────────────────
  const byCategory = {}
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = []
    byCategory[r.category].push(r)
  }

  const categoryGrades = {}
  for (const [cat, catResults] of Object.entries(byCategory)) {
    // Consistency score: identical + equivalent = full marks, partial = half, contradictory = 0
    let consistencyPoints = 0
    for (const r of catResults) {
      if (!r.similarity) { consistencyPoints += r.consistent ? 100 : 0; continue }
      const cls = r.similarity.classification
      if (cls === 'identical') consistencyPoints += 100
      else if (cls === 'semantically_equivalent') consistencyPoints += 90
      else if (cls === 'partially_similar') consistencyPoints += 50
      else consistencyPoints += 10  // contradictory
    }
    const consistencyScore = consistencyPoints / catResults.length

    // Quality score: average quality * 20 (scale 1-5 → 20-100)
    let qualityScore = 60  // default if no quality data
    const qualityScores = catResults
      .filter(r => r.quality && r.quality.average > 0)
      .map(r => r.quality.average)
    if (qualityScores.length > 0) {
      qualityScore = (qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length) * 20
    }

    // Reliability: (runs without errors) / total runs
    const totalRuns = catResults.reduce((sum, r) => sum + r.runs.length, 0)
    const errorRuns = catResults.reduce((sum, r) => sum + r.runs.filter(run => run.error).length, 0)
    const reliabilityScore = totalRuns > 0 ? ((totalRuns - errorRuns) / totalRuns) * 100 : 0

    // Weighted: consistency 40%, quality 40%, reliability 20%
    const score = Math.round(consistencyScore * 0.4 + qualityScore * 0.4 + reliabilityScore * 0.2)
    const grade = letterGrade(score)

    categoryGrades[cat] = { score, grade, color: gradeColor(grade), questionCount: catResults.length }
  }

  // ── Overall grade ─────────────────────────────────────────────────────
  const catEntries = Object.values(categoryGrades)
  const overallScore = Math.round(
    catEntries.reduce((sum, c) => sum + c.score, 0) / catEntries.length
  )
  const overallGrade = letterGrade(overallScore)

  // ── Recommendations ───────────────────────────────────────────────────
  const recommendations = generateRecommendations(results)

  // ── Executive summary ─────────────────────────────────────────────────
  const executiveSummary = generateExecutiveSummary(results, summary, categoryGrades)

  return {
    overallScore,
    overallGrade,
    overallColor: gradeColor(overallGrade),
    categoryGrades,
    executiveSummary,
    recommendations,
  }
}

module.exports = { computeGrades, letterGrade, gradeColor }
