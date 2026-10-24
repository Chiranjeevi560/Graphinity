/** Public page-context only: no user id, history, or commercial payout input exists in this API. */
export interface CommercialEvidence {
  title: string;
  consensusSummary?: string | null;
  expertAnswers?: readonly string[];
  supportingEvidence?: readonly string[];
  tags?: readonly string[];
  field?: string | null;
  country?: string | null;
  pageConfidence?: number | null;
}

export const INTENT_DIMENSIONS = [
  'purchase',
  'upgrade',
  'replacement',
  'import',
  'travel',
  'education',
  'financial',
  'insurance',
  'healthcare_educational',
  'developer_tooling',
  'enterprise_procurement',
  'hiring',
  'subscription',
  'service',
] as const;

export type IntentDimension = (typeof INTENT_DIMENSIONS)[number];

const vocabulary: Record<IntentDimension, readonly [string, RegExp][]> = {
  purchase: [
    ['buy', /\b(?:buy|buying|purchase|purchasing|shop|shopping)\b/giu],
    ['price', /\b(?:price|pricing|cost|budget|afford)\b/giu],
    ['retailer', /\b(?:retailer|store|seller|where to buy)\b/giu],
  ],
  upgrade: [
    ['upgrade', /\b(?:upgrade|upgrading|new model|next generation)\b/giu],
    ['performance gain', /\b(?:faster|more capacity|better performance|improve performance)\b/giu],
  ],
  replacement: [
    ['replace', /\b(?:replace|replacement|replacing|instead of)\b/giu],
    ['repair or end of life', /\b(?:repair|broken|failed|end of life|wear out)\b/giu],
  ],
  import: [
    ['import', /\b(?:import|importing|customs|duty|tariff|clearance)\b/giu],
    ['cross-border delivery', /\b(?:ship internationally|international shipping|freight|cross.border)\b/giu],
  ],
  travel: [
    ['travel', /\b(?:travel|trip|flight|hotel|accommodation|itinerary)\b/giu],
    ['destination', /\b(?:visa|airport|tourism|destination|booking)\b/giu],
  ],
  education: [
    ['education', /\b(?:learn|learning|course|class|degree|certification|study|training)\b/giu],
    ['institution', /\b(?:school|college|university|tuition|curriculum)\b/giu],
  ],
  financial: [
    ['finance', /\b(?:finance|financial|invest|investment|loan|credit|tax|banking)\b/giu],
    ['money decision', /\b(?:interest rate|return|savings|forex|currency|budget)\b/giu],
  ],
  insurance: [
    ['insurance', /\b(?:insurance|insurer|insured|premium|deductible|coverage|claim)\b/giu],
    ['risk protection', /\b(?:warranty coverage|liability cover|risk cover)\b/giu],
  ],
  healthcare_educational: [
    ['health topic', /\b(?:health|medical|medicine|symptom|treatment|diagnosis|clinical)\b/giu],
    ['health education', /\b(?:healthcare|hospital|therapy|patient|doctor|nursing)\b/giu],
  ],
  developer_tooling: [
    ['software development', /\b(?:developer|programming|software|code|coding|api|sdk)\b/giu],
    ['engineering tool', /\b(?:framework|database|ide|compiler|cloud platform|devops)\b/giu],
  ],
  enterprise_procurement: [
    ['procurement', /\b(?:procurement|vendor|enterprise|bulk purchase|purchase order)\b/giu],
    ['business operations', /\b(?:organization|business|b2b|deployment|contract|tender)\b/giu],
  ],
  hiring: [
    ['hiring', /\b(?:hire|hiring|recruit|recruitment|job opening|vacancy)\b/giu],
    ['employment', /\b(?:candidate|career|employment|salary|interview|staffing)\b/giu],
  ],
  subscription: [
    ['subscription', /\b(?:subscription|subscribe|monthly plan|annual plan|membership)\b/giu],
    ['recurring billing', /\b(?:recurring|per month|per year|renewal|tier)\b/giu],
  ],
  service: [
    ['service provider', /\b(?:service|service provider|consultant|professional help)\b/giu],
    ['installation or support', /\b(?:installation|maintenance|support|repair service|delivery service)\b/giu],
  ],
};

export interface IntentScore {
  confidence: number;
  matchedSignals: string[];
  explanation: string;
}

export interface CommercialIntentResult {
  version: 'lexical-v1';
  dimensions: Record<IntentDimension, IntentScore>;
}

/**
 * Reproducible lexical baseline for public question context. Each of the 14
 * dimensions receives its own bounded score and explanation. No tracking or
 * machine-learning provider is called.
 */
export function classifyCommercialIntent(evidence: CommercialEvidence): CommercialIntentResult {
  const confidence = evidence.pageConfidence == null ? 0.5 : clamp(evidence.pageConfidence);
  const haystack = [
    evidence.title,
    evidence.consensusSummary ?? '',
    ...(evidence.expertAnswers ?? []),
    ...(evidence.supportingEvidence ?? []),
    ...(evidence.tags ?? []),
    evidence.field ?? '',
    evidence.country ?? '',
  ]
    .join(' ')
    .normalize('NFKC')
    .toLowerCase();

  const dimensions = Object.fromEntries(
    INTENT_DIMENSIONS.map(dimension => {
      const matchedSignals = vocabulary[dimension]
        .filter(([, pattern]) => {
          pattern.lastIndex = 0;
          return pattern.test(haystack);
        })
        .map(([label]) => label);
      // Each independent signal contributes 0.35. Page confidence adjusts
      // evidence strength by at most ±12.5%; no output can exceed one.
      const raw = Math.min(1, matchedSignals.length * 0.35);
      const score = clamp(raw * (0.875 + confidence * 0.25));
      return [
        dimension,
        {
          confidence: round(score),
          matchedSignals,
          explanation: matchedSignals.length
            ? `Public page context matched: ${matchedSignals.join(', ')}.`
            : 'No matching public page-context signals.',
        },
      ];
    }),
  ) as Record<IntentDimension, IntentScore>;

  return { version: 'lexical-v1', dimensions };
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
