// Answers are reports of what happened, shared here, not leads for middlemen
// (docs/GRAPHINITY_BIBLE.md §21.2: "DM me on WhatsApp +91... for guaranteed
// clearance"). Customs and visa questions draw exactly that. An answer that
// asks people to make contact elsewhere is refused with a plain reason
// rather than silently edited: changing someone's words without telling
// them isn't honest, and the reason tells them what to fix. The database
// repeats the rule (db/schema.sql, app.has_contact_details).

/**
 * A phone number: 10 or more digits, optionally after "+", allowing spaces,
 * dashes and brackets between them. Amounts ("₹1,40,000"), tariff codes
 * ("9101.21.00"), dates and years don't qualify: commas and dots break a run.
 */
const PHONE = /(?:\+\s?)?\(?\d(?:[\s()-]{0,2}\d){9,}/;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/u;
/** Links and handles on messaging apps, and invitations to use them. */
const MESSAGING = /\b(?:wa\.me|t\.me|telegram\.me|chat\.whatsapp\.com|signal\.me)\/|(?:\b(?:dm|message|msg|ping|text|contact|whatsapp|telegram|call)\s+(?:me|us)\b)|(?:\b(?:whatsapp|telegram|signal)\s+(?:me|us|on|at|number|no\.?)\b)/iu;

export type Solicitation = 'phone' | 'email' | 'messaging';

/** What kind of contact detail the text holds, or null when it holds none. */
export function contactDetails(text: string): Solicitation | null {
  const clean = text.normalize('NFKC');
  if (PHONE.test(clean)) return 'phone';
  if (EMAIL.test(clean)) return 'email';
  if (MESSAGING.test(clean)) return 'messaging';
  return null;
}

export const solicitationMessage = 'Keep contact details out of answers: no phone numbers, email addresses or invitations to message elsewhere. Share what happened here, where everyone can see it.';
