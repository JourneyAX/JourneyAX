'use client';

import React, { useEffect, useRef, useState } from 'react';

import { JourneyMessage } from '@/lib/types';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import { sanitizeMessageText } from '../lib/sanitize';
import { WorkedSummary } from './shell/WorkedFold';
import { orderIdForRef, orderRef, rememberOrder } from './canvas/money';
import { readableUserText } from '@/lib/chat/readableText';
import { linkProps } from '@/lib/links';
import { useAuth } from '@/context/AuthContext';
import { isStaffRole } from '@journeyax/shared-types';
import { openOrderSurface } from '@/lib/shell/orderSurface';

export { sanitizeMessageText };

interface Props {
  message: JourneyMessage;
  /** Send this customer message again with new words, from where it was first sent. Given only where that is possible. */
  onEdit?: (text: string) => void;
  /** Ask for this reply again. Given only on the last reply, and only where that is possible. */
  onRetry?: () => void;
}

// A bullet line ("- a", "* a", "• a") or a numbered line ("1. a", "2) a"). The marker must be followed by a space, so "**bold** text" and
// "*italic*" at the start of a line are not mistaken for a list.
const BULLET_LINE = /^\s*[-*•–]\s+(.*)$/;
const NUMBERED_LINE = /^\s*(\d{1,3})[.)]\s+(.*)$/;
// A heading line ("### Installation"): shown as a bold line of its own, without the marks.
const HEADING_LINE = /^\s{0,3}#{1,6}\s+(\S.*)$/;

/** One list: its items, and under an item the lists that sit inside it. */
interface ListNode { ordered: boolean; start: number; items: Array<{ lines: string[]; sub: ListNode[] }> }

type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'text'; lines: string[] }
  | { kind: 'list'; list: ListNode };

const indentOf = (line: string) => (/^[ \t]*/.exec(line)?.[0] ?? '').replace(/\t/g, '    ').length;

/**
 * The lines of one paragraph as runs of plain lines and lists, in order. A list item indented further than the item above it sits
 * inside that item (a list within a list); a plain line indented under an item belongs to that item.
 */
function blocksOf(lines: string[]): Block[] {
  const blocks: Block[] = [];
  // The lists open at the moment, the outermost first, each with how far its markers are indented.
  let open: Array<{ indent: number; node: ListNode }> = [];
  const newList = (ordered: boolean, start: number): ListNode => ({ ordered, start, items: [] });
  for (const line of lines) {
    const heading = HEADING_LINE.exec(line);
    if (heading) { open = []; blocks.push({ kind: 'heading', text: heading[1] }); continue; }
    const bullet = BULLET_LINE.exec(line);
    const numbered = bullet ? null : NUMBERED_LINE.exec(line);
    if (bullet || numbered) {
      const indent = indentOf(line);
      const ordered = Boolean(numbered);
      const text = bullet ? bullet[1] : numbered![2];
      const start = numbered ? Number(numbered[1]) : 1;
      while (open.length > 1 && indent < open[open.length - 1].indent) open.pop();
      const top = open[open.length - 1];
      if (!top) {
        const node = newList(ordered, start);
        blocks.push({ kind: 'list', list: node });
        open = [{ indent, node }];
      } else if (indent > top.indent) {
        const parent = top.node.items[top.node.items.length - 1];
        const node = newList(ordered, start);
        parent.sub.push(node);
        open.push({ indent, node });
      } else if (top.node.ordered !== ordered) {
        // The kind of list changes at the same depth: a new list starts there (bullets and numbers stay separate lists).
        const node = newList(ordered, start);
        if (open.length === 1) blocks.push({ kind: 'list', list: node });
        else open[open.length - 2].node.items[open[open.length - 2].node.items.length - 1].sub.push(node);
        open[open.length - 1] = { indent, node };
      }
      open[open.length - 1].node.items.push({ lines: [text], sub: [] });
      continue;
    }
    if (open.length && /^\s+\S/.test(line)) {
      const items = open[open.length - 1].node.items;
      items[items.length - 1].lines.push(line.trim());
      continue;
    }
    open = [];
    const last = blocks[blocks.length - 1];
    if (last?.kind === 'text') last.lines.push(line);
    else blocks.push({ kind: 'text', lines: [line] });
  }
  return blocks;
}

function renderList(node: ListNode, key: React.Key, margin: string): React.ReactNode {
  const items = node.items.map((item, iIdx) => (
    <li key={iIdx}>
      {item.lines.map((line, lIdx) => (
        <span key={lIdx}>
          {lIdx > 0 && <br />}
          {parseBold(line)}
        </span>
      ))}
      {item.sub.map((inner, sIdx) => renderList(inner, `s${sIdx}`, '2px 0 0'))}
    </li>
  ));
  return node.ordered
    ? <ol key={key} className="msg__list" start={node.start} style={{ margin }}>{items}</ol>
    : <ul key={key} className="msg__list" style={{ margin }}>{items}</ul>;
}

// Simple markdown parser for chat messages — handles **bold**, *italic*, bullet and numbered lists, and line breaks
function renderMarkdown(text: string) {
  const sanitized = sanitizeMessageText(text);
  if (!sanitized) return null;

  // Split into paragraphs by double newlines
  const paragraphs = sanitized.split(/\n\n+/);

  return paragraphs.map((para, pIdx) => {
    // Handle single line breaks within a paragraph
    const lines = para.split('\n');

    // A paragraph with list lines becomes text and lists in order; any other paragraph renders exactly as it always has.
    if (lines.some((line) => BULLET_LINE.test(line) || NUMBERED_LINE.test(line) || HEADING_LINE.test(line))) {
      return (
        <div key={pIdx} style={{ margin: pIdx > 0 ? '10px 0 0' : 0 }}>
          {blocksOf(lines).map((block, bIdx) => {
            if (block.kind === 'heading') {
              return <p key={bIdx} className="msg__heading" style={{ margin: bIdx > 0 ? '10px 0 0' : 0 }}>{parseBold(block.text)}</p>;
            }
            if (block.kind === 'text') {
              return (
                <p key={bIdx} style={{ margin: bIdx > 0 ? '6px 0 0' : 0 }}>
                  {block.lines.map((line, lIdx) => (
                    <span key={lIdx}>
                      {lIdx > 0 && <br />}
                      {parseBold(line)}
                    </span>
                  ))}
                </p>
              );
            }
            return renderList(block.list, bIdx, bIdx > 0 ? '6px 0 0' : '0');
          })}
        </div>
      );
    }

    return (
      <p key={pIdx} style={{ margin: pIdx > 0 ? '10px 0 0' : 0 }}>
        {lines.map((line, lIdx) => (
          <span key={lIdx}>
            {lIdx > 0 && <br />}
            {parseBold(line)}
          </span>
        ))}
      </p>
    );
  });
}

// Parse **bold**, *italic* and links: [text](address) and a bare web address both become a tappable link that opens in a new tab.
// Only http(s) addresses are linked, and the text is never treated as markup.
const INLINE_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"])|\*\*(.+?)\*\*|\*(.+?)\*|\b(ord_[a-f0-9]{32})\b|#([A-F0-9]{8})\b/g;

/** A web address as a short readable label ("placemakers.co.nz/online/pergolas"). */
function shortAddress(url: string): string {
  const bare = url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
  return bare.length > 48 ? `${bare.slice(0, 47)}…` : bare;
}

function parseBold(text: string) {
  const parts: (string | React.ReactNode)[] = [];
  const regex = new RegExp(INLINE_RE.source, 'g');
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[1] && match[2]) {
      parts.push(<a key={match.index} className="msg__link" href={match[2]} {...linkProps}>{match[1]}</a>);
    } else if (match[3]) {
      parts.push(<a key={match.index} className="msg__link" href={match[3]} {...linkProps}>{shortAddress(match[3])}</a>);
    } else if (match[4]) {
      parts.push(<strong key={match.index}>{match[4]}</strong>);
    } else if (match[5]) {
      parts.push(<em key={match.index}>{match[5]}</em>);
    } else if (match[6] || match[7]) {
      // An order number opens the order (items, billing, shipping, summary) in the side panel.
      const orderId = match[6] || orderIdForRef(match[7]);
      if (orderId) {
        rememberOrder(orderId);
        parts.push(<OrderReference key={match.index} orderId={orderId} />);
      } else {
        parts.push(match[0]);
      }
    }
    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [text];
}

function OrderReference({ orderId }: { orderId: string }) {
  const cfg = useStorefrontConfig();
  const { user } = useAuth();
  return <button type="button" className="msg__link msg__link--btn" onClick={() => { void openOrderSurface(orderId, cfg.projectId, isStaffRole(user?.role)); }}>{`#${orderRef(orderId)}`}</button>;
}

/** "PlaceMakers (Fletcher Building)" → PM, "Caroma Industries Ltd" → CI:
 *  the capitals of a CamelCase brand, else the initials of its first words. */
function brandInitials(name: string): string {
  const base = (name || '').replace(/\(.*?\)/g, '').trim();
  if (!base) return 'AI';
  const caps = base.match(/[A-Z]/g) || [];
  if (caps.length >= 2) return caps.slice(0, 2).join('');
  return base.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

/** The customer's own words with an Edit control: the bubble turns into a box with the words in it, and sending replaces this turn. */
function UserMessage({ message, onEdit }: { message: JourneyMessage; onEdit?: (text: string) => void }) {
  const words = sanitizeMessageText(readableUserText(message.text));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(words);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) return;
    const el = box.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  const send = () => {
    const text = draft.trim();
    if (!text || !onEdit) return;
    setEditing(false);
    onEdit(text);
  };

  if (editing && onEdit) {
    return (
      <div className="msg msg--user msg--editing">
        <textarea
          ref={box}
          className="msg__edit-box"
          aria-label="Edit your message"
          value={draft}
          rows={Math.min(8, Math.max(2, draft.split('\n').length))}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
            if (e.key === 'Escape') { setEditing(false); setDraft(words); }
          }}
        />
        <div className="msg__edit-actions">
          <button type="button" className="msg__action" onClick={() => { setEditing(false); setDraft(words); }}>Cancel</button>
          <button type="button" className="msg__action msg__action--primary" onClick={send} disabled={!draft.trim()}>Send</button>
        </div>
      </div>
    );
  }

  return (
    <div className="msg msg--user">
      <div className="msg__bubble--user">{words}</div>
      {onEdit && (
        <div className="msg__actions">
          <button type="button" className="msg__action" onClick={() => { setDraft(words); setEditing(true); }} aria-label="Edit this message">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
            Edit
          </button>
        </div>
      )}
    </div>
  );
}

export default function MessageBubble({ message, onEdit, onRetry }: Props) {
  const cfg = useStorefrontConfig();

  if (message.role === 'user') {
    return <UserMessage message={message} onEdit={onEdit} />;
  }

  if (message.role === 'note') {
    return (
      <div className="msg msg--note">
        <div className="msg__note">
          <svg className="msg__note-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z" stroke="#A67C4E" strokeWidth="1.6" strokeLinejoin="round" />
          </svg>
          <div className="msg__note-content">
            {message.head && <b className="msg__note-head">{sanitizeMessageText(message.head)} </b>}
            {sanitizeMessageText(message.text)}
          </div>
        </div>
      </div>
    );
  }

  // Agent turn — brand-initials avatar beside plain running text, no bubble
  // box (the "PlaceMakers Conversation" mockup this layout follows). Rich
  // content for the same turn (cards) follows as its own block in the thread.
  const debugEngine =
    process.env.NEXT_PUBLIC_DEBUG_ENGINE === 'true' ||
    process.env.NEXT_PUBLIC_DEBUG_ENGINE === '1';

  return (
    <div className="msg msg--ai">
      <div className="msg__avatar" aria-hidden="true">{cfg.brandOverlay ? 'AI' : brandInitials(cfg.companyName)}</div>
      <div className="msg__body">
        {/* The name stays for screen readers; it is shown only when the engine badge is (debug builds). */}
        <div className={`msg__label${debugEngine ? ' msg__label--debug' : ''}`}>
          {cfg.systemName || 'Assistant'}
          {debugEngine && (message.engine || message.agentId) && (
            <span
              className="msg__engine-badge"
              data-testid="debug-engine-badge"
              style={{
                display: 'inline-block',
                marginLeft: '8px',
                padding: '1px 6px',
                fontSize: '11px',
                fontWeight: 600,
                borderRadius: '4px',
                backgroundColor: message.engine === 'agent' ? '#e6f4ea' : '#f1f3f4',
                color: message.engine === 'agent' ? '#137333' : '#5f6368',
                border: '1px solid currentColor',
                fontFamily: 'monospace',
                textTransform: 'lowercase',
              }}
            >
              engine={message.engine || 'unknown'}{message.agentId ? ` (${message.agentId})` : ''}
            </span>
          )}
        </div>
        {message.trace && <WorkedSummary trace={message.trace} />}
        <div className="msg__bubble--ai">{renderMarkdown(message.text)}</div>
        {onRetry && (
          <div className="msg__actions">
            <button type="button" className="msg__action" onClick={onRetry} aria-label="Ask for this answer again">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v4h-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
