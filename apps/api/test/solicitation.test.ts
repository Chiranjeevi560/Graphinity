import { describe, expect, it } from 'vitest';
import { contactDetails } from '../src/solicitation.ts';

describe('contact details in answers (Bible §21.2)', () => {
  it('finds phone numbers however they are written', () => {
    for (const t of ['DM me on +91 98765 43210 for clearance', 'call 9876543210', 'ring (022) 2345-6789-12 today', '+1-415-555-0199-22']) {
      expect(contactDetails(t), t).toBe('phone');
    }
  });

  it('finds email addresses and messaging invitations', () => {
    expect(contactDetails('write to agent.raj@example.com')).toBe('email');
    expect(contactDetails('Join wa.me/919876 for help')).toBe('messaging');
    expect(contactDetails('t.me/fastclearance')).toBe('messaging');
    expect(contactDetails('Just DM me and I will sort it')).toBe('messaging');
    expect(contactDetails('WhatsApp me for guaranteed clearance')).toBe('messaging');
    expect(contactDetails('message us for a quote')).toBe('messaging');
  });

  it('leaves real reports alone: amounts, tariff codes, dates, form numbers, plain mentions', () => {
    for (const t of [
      'Paid ₹1,40,000 in duty at Chennai in March 2026.',
      'The HS code was 9101.21.00 and the form BOE-II.',
      'It took 14 days; reference 2026-10-19.',
      'The customs officer called me twice before release.',
      'I used WhatsApp to send the invoice to the courier, they replied in a day.',
      'Paid $1,200.50 at JFK, receipt 123456.',
    ]) {
      expect(contactDetails(t), t).toBeNull();
    }
  });

  it('isn’t fooled by full-width digits', () => {
    expect(contactDetails('call ９８７６５４３２１０')).toBe('phone');
  });
});
