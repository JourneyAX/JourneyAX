/**
 * Reads a skill from a text file a person picks ("Upload a skill file"): a SKILL.md with a small header (`name:` and `description:`
 * between two `---` lines) and the instructions underneath, or plain markdown. Nothing is saved: the file only fills in the skill form,
 * as a draft, so the person still chooses who has it and which assistants carry it before anything goes live.
 */
import { EMPTY_SKILL, type SkillDraftInput } from './skillDrafts';
import { SKILL_LIMITS } from './skillEdit';

export const MAX_SKILL_FILE_BYTES = 60_000;

export type SkillFileResult = { ok: true; seed: SkillDraftInput; note: string } | { ok: false; error: string };

const unquote = (value: string): string => value.trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim();

/** `key: value` lines of the header; a value written as `>` or `|` takes the indented lines under it. */
function readHeader(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const key = match[1].toLowerCase();
    let value = match[2];
    if (/^[>|][+-]?$/.test(value.trim())) {
      const folded: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) { i += 1; folded.push(lines[i].trim()); }
      value = folded.join(' ');
    }
    out[key] = unquote(value);
  }
  return out;
}

const firstSentence = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = end >= 0 ? flat.slice(0, end + 1) : flat;
  return sentence.length > SKILL_LIMITS.description ? `${sentence.slice(0, SKILL_LIMITS.description - 1).trimEnd()}…` : sentence;
};

export function parseSkillFile(text: string, fileName = ''): SkillFileResult {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'The file is empty.' };
  if (text.includes('\u0000')) return { ok: false, error: 'This does not look like a text file. Pick a SKILL.md or another markdown file.' };
  if (text.length > MAX_SKILL_FILE_BYTES) return { ok: false, error: `The file is too long for a skill (more than ${Math.round(MAX_SKILL_FILE_BYTES / 1000)} thousand characters).` };

  const framed = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(text);
  const header = framed ? readHeader(framed[1]) : {};
  const body = (framed ? framed[2] ?? '' : text).trim();

  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const fromFile = fileName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
  const name = header.name || heading || (/^skill$/i.test(fromFile) ? '' : fromFile);
  if (!name) return { ok: false, error: 'The file does not say what the skill is called. Add a line “name: …” at the top, or a first line starting with “# ”.' };
  if (name.length > SKILL_LIMITS.name) return { ok: false, error: `The skill name is longer than ${SKILL_LIMITS.name} characters.` };

  const paragraph = body.split(/\r?\n\s*\r?\n/).map((part) => part.trim()).find((part) => part && !part.startsWith('#'));
  const description = header.description || (paragraph ? firstSentence(paragraph) : '');
  if (body.length > SKILL_LIMITS.instructions) return { ok: false, error: `The instructions are longer than ${SKILL_LIMITS.instructions} characters.` };
  if (!body) return { ok: false, error: 'The file has a header but no instructions under it.' };

  return {
    ok: true,
    seed: { ...EMPTY_SKILL, name, description, instructions: body },
    note: header.description ? '' : 'The file had no description, so the first sentence was used. Check it says when the assistant should use the skill.',
  };
}
