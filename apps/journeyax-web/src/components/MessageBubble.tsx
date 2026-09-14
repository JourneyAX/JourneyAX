'use client';

import React from 'react';

import { JourneyMessage } from '@/lib/types';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';

interface Props {
  message: JourneyMessage;
}

// Simple markdown parser for chat messages — handles **bold**, *italic*, and line breaks
function renderMarkdown(text: string) {
  // Split into paragraphs by double newlines
  const paragraphs = text.split(/\n\n+/);

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

// Parse **bold** and *italic* markers
function parseBold(text: string) {
  const parts: (string | React.ReactNode)[] = [];
  const regex = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    // Bold
    if (match[1]) {
      parts.push(<strong key={match.index}>{match[1]}</strong>);
    }
    // Italic
    else if (match[2]) {
      parts.push(<em key={match.index}>{match[2]}</em>);
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
        <div className="msg__bubble--user">{message.text}</div>
      </div>
    );
  }

  if (message.role === 'note') {
    return (
      <div className="msg msg--note">
        <div className="msg__note">
          <svg className="msg__note-icon" width="15" height="15" viewBox="0 0 24 24" fill="none">
            <path d="M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z" stroke="#A67C4E" strokeWidth="1.6" strokeLinejoin="round" />
          </svg>
          <div className="msg__note-content">
            {message.head && <b className="msg__note-head">{message.head} </b>}
            {message.text}
          </div>
        </div>
      </div>
    );
  }

  // Agent turn — brand-initials avatar beside plain running text, no bubble
  // box (the "PlaceMakers Conversation" mockup this layout follows). Rich
  // content for the same turn (cards) follows as its own block in the thread.
  return (
    <div className="msg msg--ai">
      <div className="msg__avatar" aria-hidden="true">{brandInitials(cfg.companyName)}</div>
      <div className="msg__body">
        <div className="msg__label">{cfg.systemName || 'Consultant'}</div>
        <div className="msg__bubble--ai">{renderMarkdown(message.text)}</div>
      </div>
    </div>
  );
}
