'use strict'
// ─────────────────────────────────────────────────────────────────────────────
// similarity.js — Semantic similarity scoring for bot responses
//
// Classifies response consistency as:
//   identical / semantically_equivalent / partially_similar / contradictory
//
// Uses token-based cosine similarity (no external APIs needed)
// ─────────────────────────────────────────────────────────────────────────────

// Common UI artifacts captured by Playwright that aren't part of the actual response
const UI_ARTIFACTS = [
  /\bUser Response:\s*/gi,
  /\bMessage sent\b/gi,
  /\bStill loading\b/gi,
  /\bYou received a new message\.?\s*Press "?Tab"? to focus it\.?/gi,
  /\bSent\s*·\s*(Just now|\d+:\d+\s*(AM|PM)?)/gi,
  /\bWas this helpful\?\s*/gi,
  /\bWas I able to help you resolve your question\?\s*/gi,
  /\bYes,?\s*thank you!?\s*/gi,
  /\bNo,?\s*I need more help\.?\s*/gi,
  /\bVirtual Agent to .+?:\s*/gi,
  /\bMessage from .+?:\s*/gi,
  /\bYou said:\s*/gi,
  /\bThe assistant said:\s*/gi,
  /\bEmail received\s*/gi,
  /\balert\s*$/gi,
  /\b\d+ Sources?\b/gi,
  /\bAI can make mistakes\.?\s*Review for accuracy\.?\s*/gi,
]

// Stopwords to remove for better similarity comparison
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or',
  'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each',
  'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some',
  'such', 'no', 'only', 'own', 'same', 'than', 'too', 'very',
  'just', 'also', 'about', 'up', 'out', 'if', 'then', 'that',
  'this', 'these', 'those', 'it', 'its', 'i', 'me', 'my', 'we',
  'our', 'you', 'your', 'he', 'she', 'they', 'them', 'their',
  'what', 'which', 'who', 'whom', 'when', 'where', 'how', 'why',
  'here', 'there', 'please', 'thanks', 'thank', 'hi', 'hello',
])

/**
 * Normalize a bot response by removing UI artifacts and noise
 */
function normalizeResponse(text) {
  if (!text) return ''
  let normalized = text
  for (const pattern of UI_ARTIFACTS) {
    normalized = normalized.replace(pattern, ' ')
  }
  return normalized
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, ' ')
    .toLowerCase()
    .trim()
}

/**
 * Tokenize text into meaningful words (no stopwords)
 */
function tokenize(text) {
  return normalizeResponse(text)
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w))
}

/**
 * Compute Jaccard similarity between two token arrays
 */
function jaccardSimilarity(tokensA, tokensB) {
  if (tokensA.length === 0 && tokensB.length === 0) return 1.0
  if (tokensA.length === 0 || tokensB.length === 0) return 0.0
  const setA = new Set(tokensA)
  const setB = new Set(tokensB)
  const intersection = new Set([...setA].filter(t => setB.has(t)))
  const union = new Set([...setA, ...setB])
  return intersection.size / union.size
}

/**
 * Compute TF-IDF vectors and cosine similarity between two token arrays
 * Uses the two documents themselves as the corpus
 */
function cosineSimilarity(tokensA, tokensB) {
  if (tokensA.length === 0 && tokensB.length === 0) return 1.0
  if (tokensA.length === 0 || tokensB.length === 0) return 0.0

  // Build term frequency maps
  const tfA = {}
  const tfB = {}
  for (const t of tokensA) tfA[t] = (tfA[t] || 0) + 1
  for (const t of tokensB) tfB[t] = (tfB[t] || 0) + 1

  // All unique terms
  const allTerms = new Set([...tokensA, ...tokensB])

  // IDF (2-document corpus)
  const idf = {}
  for (const term of allTerms) {
    const df = (tfA[term] ? 1 : 0) + (tfB[term] ? 1 : 0)
    idf[term] = Math.log(2 / df) + 1  // smoothed IDF
  }

  // TF-IDF vectors
  let dotProduct = 0
  let magA = 0
  let magB = 0
  for (const term of allTerms) {
    const a = (tfA[term] || 0) * idf[term]
    const b = (tfB[term] || 0) * idf[term]
    dotProduct += a * b
    magA += a * a
    magB += b * b
  }

  const magnitude = Math.sqrt(magA) * Math.sqrt(magB)
  if (magnitude === 0) return 0
  return dotProduct / magnitude
}

/**
 * Classify the consistency of a set of responses
 *
 * @param {string[]} responses - Array of response strings from multiple runs
 * @returns {{ classification: string, score: number, explanation: string, pairScores: object[] }}
 */
function classifyConsistency(responses) {
  const valid = responses.filter(r => r && r.trim())
  if (valid.length === 0) {
    return { classification: 'no_response', score: 0, explanation: 'No responses received', pairScores: [] }
  }
  if (valid.length === 1) {
    return { classification: 'single_response', score: 1, explanation: 'Only one valid response', pairScores: [] }
  }

  // Check exact match first
  const allIdentical = valid.every(r => normalizeResponse(r) === normalizeResponse(valid[0]))
  if (allIdentical) {
    return { classification: 'identical', score: 1.0, explanation: 'All responses are identical', pairScores: [] }
  }

  // Compute pairwise similarity
  const pairScores = []
  let totalCosine = 0
  let totalJaccard = 0
  let pairCount = 0

  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const tokA = tokenize(valid[i])
      const tokB = tokenize(valid[j])
      const cosine = cosineSimilarity(tokA, tokB)
      const jaccard = jaccardSimilarity(tokA, tokB)
      pairScores.push({ i, j, cosine: Math.round(cosine * 100) / 100, jaccard: Math.round(jaccard * 100) / 100 })
      totalCosine += cosine
      totalJaccard += jaccard
      pairCount++
    }
  }

  const avgCosine = totalCosine / pairCount
  const avgJaccard = totalJaccard / pairCount
  // Weighted composite: cosine is better at semantic similarity, Jaccard catches word overlap
  const score = Math.round((avgCosine * 0.7 + avgJaccard * 0.3) * 100) / 100

  let classification, explanation
  if (score >= 0.85) {
    classification = 'semantically_equivalent'
    explanation = 'Responses convey the same information with minor wording differences'
  } else if (score >= 0.55) {
    classification = 'partially_similar'
    explanation = 'Responses address the same topic but include different information or advice'
  } else {
    classification = 'contradictory'
    explanation = 'Responses provide significantly different or conflicting information'
  }

  return { classification, score, explanation, pairScores }
}

module.exports = { classifyConsistency, normalizeResponse, tokenize, cosineSimilarity, jaccardSimilarity }
