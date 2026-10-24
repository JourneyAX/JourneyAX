'use client';

import React from 'react';

import { JourneyMessage } from '@/lib/types';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import { sanitizeMessageText } from '../lib/sanitize';
import { WorkedSummary } from './shell/WorkedFold';
import { openCanvas } from '@/lib/shell/sidePanelStore';
import { orderIdForRef, orderRef, rememberOrder } from './canvas/money';
import { readableUserText } from '@/lib/chat/readableText';

export { sanitizeMessageText };

interface Props {
  message: JourneyMessage;
}

// Simple markdown parser for chat messages — handles **bold**, *italic*, and line breaks
function renderMarkdown(text: string) {
  const sanitized = sanitizeMessageText(text);
  if (!sanitized) return null;

  // Split into paragraphs by double newlines
  const paragraphs = sanitized.split(/\n\n+/);

  return paragraphs.map((para, pIdx) => {
    // Handle single line breaks within a paragraph
    const lines = para.split('\n');

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
      parts.push(<a key={match.index} className="msg__link" href={match[2]} target="_blank" rel="noopener noreferrer">{match[1]}</a>);
    } else if (match[3]) {
      parts.push(<a key={match.index} className="msg__link" href={match[3]} target="_blank" rel="noopener noreferrer">{shortAddress(match[3])}</a>);
    } else if (match[4]) {
      parts.push(<strong key={match.index}>{match[4]}</strong>);
    } else if (match[5]) {
      parts.push(<em key={match.index}>{match[5]}</em>);
    } else if (match[6] || match[7]) {
      // An order number opens the order (items, billing, shipping, summary) in the side panel.
      const orderId = match[6] || orderIdForRef(match[7]);
      if (orderId) {
        rememberOrder(orderId);
        parts.push(<button key={match.index} type="button" className="msg__link msg__link--btn" onClick={() => openCanvas({ kind: 'order', orderId })}>{`#${orderRef(orderId)}`}</button>);
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

/** "PlaceMakers (Fletcher Building)" → PM, "Caroma Industries Ltd" → CI:
 *  the capitals of a CamelCase brand, else the initials of its first words. */
function brandInitials(name: string): string {
  const base = (name || '').replace(/\(.*?\)/g, '').trim();
  if (!base) return 'AI';
  const caps = base.match(/[A-Z]/g) || [];
  if (caps.length >= 2) return caps.slice(0, 2).join('');
  return base.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

export default function MessageBubble({ message }: Props) {
  const cfg = useStorefrontConfig();

  if (message.role === 'user') {
    return (
      <div className="msg msg--user">
        <div className="msg__bubble--user">{sanitizeMessageText(readableUserText(message.text))}</div>
      </div>
    );
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
      <div className="msg__avatar" aria-hidden="true">{brandInitials(cfg.companyName)}</div>
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
      </div>
    </div>
  );
}
