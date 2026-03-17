'use strict'
// ─────────────────────────────────────────────────────────────────────────────
// quality-scorer.js — Rule-based response quality assessment
//
// Rates each bot response on helpfulness, actionability, and appropriateness.
// No external APIs — all pattern matching.
// ─────────────────────────────────────────────────────────────────────────────

const { normalizeResponse } = require('./similarity')

const FAILED_PATTERNS = [
  /i didn'?t (catch|understand|get) that/i,
  /could you (please )?(rephrase|try again|say it another way)/i,
  /i'?m not sure (what|how) you mean/i,
  /i can'?t help with that/i,
  /i don'?t have (information|an answer)/i,
  /sorry.{0,20}(didn'?t understand|can'?t help|unable to)/i,
  /please try again/i,
  /i'?m unable to process/i,
]

const ESCALATION_PATTERNS = [
  /connect you (to|with) (a )?(human|live|real|support) (agent|person|representative|specialist|team)/i,
  /transfer (you )?(to|over)/i,
  /escalat(e|ed|ing)/i,
  /speak (to|with) (a )?(human|agent|person|representative)/i,
  /hand(ing)? you (off|over)/i,
  /support (team|specialist) (will|can)/i,
  /create a (support )?ticket/i,
  /open a (support )?case/i,
]

const DEFLECTION_PATTERNS = [
  /visit (our|the) (help|support) (center|page|site)/i,
  /check (our|the) (help|support|faq|knowledge)/i,
  /go to (our|the|www\.)/i,
  /contact (us|our team|support) (at|via|through)/i,
  /reach out to (us|our|support)/i,
  /see (our|the) (website|docs|documentation|help)/i,
]

const EMPATHY_PATTERNS = [
  /i'?m sorry (to hear|about|for)/i,
  /i understand (your|that|how)/i,
  /i apologize/i,
  /that must be (frustrating|concerning|worrying)/i,
  /i can see (this|that|how)/i,
  /thank(s| you) for (reaching out|contacting|letting us know|your patience)/i,
]

const ACTIONABLE_PATTERNS = [
  /\b(step|steps)\s*\d/i,
  /\b(first|1\.|1\))\b.+\b(then|2\.|2\)|next|second)\b/is,
  /\bfollow these steps\b/i,
  /\bhere'?s how\b/i,
  /\bgo to\b.+\b(and|then)\b/i,
  /\bclick (on )?(the |")/i,
  /\bnavigate to\b/i,
  /\blog in(to)?\b/i,
]

const LINK_PATTERNS = [
  /https?:\/\/\S+/i,
  /\bclick here\b/i,
  /↗/,
  /\blink\b.+\b(below|above|here)\b/i,
]

/**
 * Score a single bot response for quality
 *
 * @param {string} question - The question that was asked
 * @param {string} expectation - What a good response should do
 * @param {string} response - The bot's response
 * @returns {{ rating: string, score: number, flags: string[], issues: string[] }}
 */
function scoreResponseQuality(question, expectation, response) {
  if (!response || !response.trim()) {
    return { rating: 'failed', score: 1, flags: [], issues: ['no_response'] }
  }

  const flags = []
  const issues = []
  const lower = response.toLowerCase()
  const normalized = normalizeResponse(response)

  // Check for failure
  const isFailed = FAILED_PATTERNS.some(p => p.test(response))
  if (isFailed) {
    return { rating: 'failed', score: 1, flags: [], issues: ['bot_did_not_understand'] }
  }

  // Check for pure escalation
  const isEscalation = ESCALATION_PATTERNS.some(p => p.test(response))
  if (isEscalation) flags.push('escalation_offered')

  // Check for deflection
  const isDeflection = DEFLECTION_PATTERNS.some(p => p.test(response))
  if (isDeflection) flags.push('deflection')

  // Check for empathy
  const hasEmpathy = EMPATHY_PATTERNS.some(p => p.test(response))
  if (hasEmpathy) flags.push('empathy')

  // Check for actionable steps
  const hasActionableSteps = ACTIONABLE_PATTERNS.some(p => p.test(response))
  if (hasActionableSteps) flags.push('actionable_steps')

  // Check for links
  const hasLinks = LINK_PATTERNS.some(p => p.test(response))
  if (hasLinks) flags.push('links_provided')

  // Determine if the response addresses the question topic
  const questionKeywords = question.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3)
  const topicOverlap = questionKeywords.filter(kw => lower.includes(kw)).length / Math.max(questionKeywords.length, 1)

  // Score calculation
  let score = 2.5  // baseline

  // Topic relevance
  if (topicOverlap >= 0.3) score += 0.5
  else issues.push('low_topic_relevance')

  // Response length (very short = probably not helpful)
  if (normalized.split(/\s+/).length >= 20) score += 0.5
  else if (normalized.split(/\s+/).length < 10) { score -= 0.5; issues.push('very_short_response') }

  // Actionable content
  if (hasActionableSteps) score += 0.5
  else issues.push('no_actionable_steps')

  // Empathy
  if (hasEmpathy) score += 0.25

  // Links/resources
  if (hasLinks) score += 0.25

  // Penalties
  if (isDeflection && !hasActionableSteps && !isEscalation) {
    score -= 1.0
    issues.push('generic_deflection')
  }

  // Pure escalation without trying to help first
  if (isEscalation && !hasActionableSteps && normalized.split(/\s+/).length < 30) {
    score -= 0.5
    issues.push('immediate_escalation_without_help')
  }

  // Clamp score
  score = Math.max(1, Math.min(5, Math.round(score * 10) / 10))

  // Determine rating
  let rating
  if (isEscalation && !hasActionableSteps) rating = 'escalated'
  else if (isDeflection && !hasActionableSteps) rating = 'deflected'
  else if (score >= 3.5) rating = 'answered'
  else rating = 'partial'

  return { rating, score, flags, issues }
}

/**
 * Score all runs for a question and compute aggregate
 */
function scoreQuestion(question, expectation, runs) {
  const scores = runs.map(run =>
    scoreResponseQuality(question, expectation, run.response)
  )
  const validScores = scores.filter(s => s.score > 0)
  const average = validScores.length > 0
    ? Math.round(validScores.reduce((sum, s) => sum + s.score, 0) / validScores.length * 10) / 10
    : 0

  return { scores, average }
}

module.exports = { scoreResponseQuality, scoreQuestion }
