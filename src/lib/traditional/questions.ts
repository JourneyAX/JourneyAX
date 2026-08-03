import type { DynamicQuestion } from '@/lib/types';

export type Intent =
  | 'bathroom_shower'
  | 'bathroom_full'
  | 'kitchen'
  | 'laundry'
  | 'troubleshoot'
  | 'warranty'
  | 'unknown';

export const QUESTIONS: Record<Exclude<Intent, 'unknown' | 'warranty'>, DynamicQuestion[]> = {
  bathroom_shower: [
    {
      id: 'mode',
      title: 'Renovating, or building new?',
      options: ['Renovating', 'Building new', 'Replacing fixtures'],
    },
    {
      id: 'shower',
      title: 'Shower experience?',
      options: ['Rain overhead', 'Handheld on rail', 'Rail + overhead'],
    },
    {
      id: 'style',
      title: 'Overall style?',
      options: ['Minimalist', 'Soft & curved', 'No preference'],
    },
    {
      id: 'finish',
      title: 'Finish?',
      options: ['Matte Black', 'Chrome', 'Brushed Brass'],
    },
  ],
  bathroom_full: [
    {
      id: 'mode',
      title: 'Renovating, or building new?',
      options: ['Renovating', 'Building new', 'Replacing fixtures'],
    },
    {
      id: 'scope',
      title: "What's in scope?",
      options: ['Just the shower', 'Shower + tapware', 'The whole bathroom'],
    },
    {
      id: 'style',
      title: 'Overall style?',
      options: ['Minimalist', 'Soft & curved', 'No preference'],
    },
    {
      id: 'finish',
      title: 'Finish?',
      options: ['Matte Black', 'Chrome', 'Brushed Brass'],
    },
  ],
  kitchen: [
    {
      id: 'need',
      title: 'What do you need in the kitchen?',
      options: ['Sink mixer only', 'Sink + mixer', 'Full kitchen wet zone'],
    },
    {
      id: 'finish',
      title: 'Finish?',
      options: ['Chrome', 'Matte Black', 'No preference'],
    },
  ],
  laundry: [
    {
      id: 'need',
      title: 'Laundry setup?',
      options: ['Tub only', 'Tub + bypass plumbing', 'Replace existing tub'],
    },
  ],
  troubleshoot: [
    {
      id: 'symptom',
      title: 'What is happening?',
      options: ['Drip / leak at shower', 'Low water pressure', 'Mixer not switching', 'General install help'],
    },
    {
      id: 'diy',
      title: 'Who will fix it?',
      options: ['DIY', 'I need a plumber'],
    },
  ],
};

export function detectIntent(text: string): Intent {
  const t = text.toLowerCase();

  if (
    /\b(leak|drip|troubleshoot|fix|not working|pressure|blocked|clog|warranty look)/i.test(t) ||
    /\bhelp on step\b/i.test(t) ||
    /\bwhat'?s next\b/i.test(t)
  ) {
    return 'troubleshoot';
  }
  if (/\bwarranty\b|\bsku\b|\b853010mw\b|\bdimensions?\b/i.test(t)) {
    return 'warranty';
  }
  if (/\blaundry\b/.test(t)) return 'laundry';
  if (/\bkitchen\b|\bsink mixer\b|\bgooseneck\b/.test(t)) return 'kitchen';
  if (
    /\bfull bathroom\b|\bwhole bathroom\b|\bmatching finishes\b|\bbuilding new\b/.test(t) ||
    /\bspec a full\b/.test(t)
  ) {
    return 'bathroom_full';
  }
  if (/\bshower\b|\brenovat/.test(t)) return 'bathroom_shower';
  if (/\bbathroom\b|\bbasin\b|\btoilet\b|\btapware\b/.test(t)) return 'bathroom_full';

  return 'unknown';
}
