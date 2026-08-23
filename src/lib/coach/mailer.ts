/**
 * Email delivery.
 *
 * Sends over SMTP via nodemailer when `SMTP_HOST` is configured. Without it,
 * falls back to a dev-only stub that logs the message and keeps the last one
 * so the access page can show the code on screen — the behaviour this whole
 * module used to be, and still is out of the box.
 *
 * The two modes are deliberately not silent about which one is active:
 * sending for real without saying so would make a broken SMTP config look
 * like a UI bug; falling back to the stub without saying so would make a
 * real deployment think it was sending mail when nobody ever received one.
 */

import nodemailer, { type Transporter } from 'nodemailer';
import { logger } from '../logger';

const log = logger('coach/mailer');

export interface CoachMessage {
  to: string;
  subject: string;
  body: string;
  sentAt: string;
}

const lastByEmail = new Map<string, CoachMessage>();
const isProd = process.env.NODE_ENV === 'production';

// ── SMTP transport ───────────────────────────────────────────────────────
let transporter: Transporter | null = null;
let transporterError: string | null = null;

function isConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

/**
 * Build the transporter once and reuse it — nodemailer pools connections,
 * and re-creating it per send would open a new SMTP connection per email.
 */
function getTransporter(): Transporter {
  if (transporter) return transporter;

  const port = Number(process.env.SMTP_PORT || 587);
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // 465 is implicit TLS; 587 and everything else negotiate TLS via STARTTLS.
    // Getting this backwards is the single most common SMTP misconfiguration.
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return transporter;
}

/**
 * Verify the SMTP connection and credentials without sending anything.
 * Cheap enough to call at startup or from a health check; failures here are
 * exactly the ones that otherwise only surface as a coach never getting
 * their code.
 */
export async function verifyMailer(): Promise<{ ok: boolean; error?: string }> {
  if (!isConfigured()) return { ok: false, error: 'SMTP not configured' };
  try {
    await getTransporter().verify();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return { ok: false, error: message };
  }
}

// ── Sending ──────────────────────────────────────────────────────────────
export function send(message: Omit<CoachMessage, 'sentAt'>): void {
  const full: CoachMessage = { ...message, sentAt: new Date().toISOString() };

  if (!isConfigured()) {
    if (isProd) {
      // A real deployment reaching this line is a misconfiguration, not a
      // routine event — the coach is waiting for a code nobody is sending.
      log.error(
        `NO SMTP CONFIGURED — a message for ${message.to} was generated but not delivered. ` +
        'Set SMTP_HOST, SMTP_USER, SMTP_PASS (and MAIL_FROM) to send for real.',
      );
      return;
    }
    log.debug(`(not sent — SMTP unconfigured)\n  to: ${full.to}\n  ${full.subject}\n  ${full.body}`);
    lastByEmail.set(full.to.toLowerCase(), full);
    return;
  }

  const from = process.env.MAIL_FROM || process.env.SMTP_USER!;

  // Fire-and-forget by design: every caller already treats delivery as best
  // effort, and a coach waiting on the confirmation screen should not stall
  // on an SMTP round-trip. Failures are logged, not thrown.
  getTransporter()
    .sendMail({ from, to: full.to, subject: full.subject, text: full.body })
    .then(() => log.info(`sent to ${full.to}`))
    .catch((err) => {
      transporterError = err instanceof Error ? err.message : 'unknown error';
      log.error(`send failed for ${full.to}: ${transporterError}`);
    });

  // In development, still keep the message for the on-screen fallback — an
  // SMTP account that is slow, rate-limited, or landing in spam during a demo
  // should not strand the flow with no way to read the code.
  if (!isProd) lastByEmail.set(full.to.toLowerCase(), full);
}

/**
 * The last message for an address. Development only — in production this
 * always returns null, so a demo affordance can never leak a live code.
 */
export function lastMessageFor(email: string): CoachMessage | null {
  if (isProd) return null;
  return lastByEmail.get(email.trim().toLowerCase()) ?? null;
}

export function mailerStatus(): { configured: boolean; lastError: string | null } {
  return { configured: isConfigured(), lastError: transporterError };
}

export function __clearMessages() {
  lastByEmail.clear();
}
