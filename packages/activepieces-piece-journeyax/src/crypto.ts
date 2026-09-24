import * as crypto from 'crypto';

export interface SignedWebhookPayload {
  signature: string;
  timestamp: string;
  nonce: string;
  bodyString: string;
}

/**
 * Cryptographically signs an outbound webhook payload using HMAC-SHA256.
 */
export function signWebhookPayload(
  payload: Record<string, any>,
  secret: string,
  timestamp = Date.now(),
  nonce: string = crypto.randomUUID()
): SignedWebhookPayload {
  const bodyString = JSON.stringify(payload);
  const tsStr = String(timestamp);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${tsStr}.${nonce}.${bodyString}`)
    .digest('hex');

  return { signature, timestamp: tsStr, nonce, bodyString };
}

/**
 * Validates inbound webhook HMAC-SHA256 signature with constant-time equality check.
 */
export function verifyWebhookSignature(
  signatureHeader: string,
  timestampHeader: string,
  nonceHeader: string,
  rawBody: string,
  secret: string,
  maxSkewMs = 5 * 60 * 1000
): { valid: boolean; reason?: string } {
  const ts = Number(timestampHeader);
  if (isNaN(ts)) {
    return { valid: false, reason: 'Invalid timestamp header' };
  }

  const now = Date.now();
  if (Math.abs(now - ts) > maxSkewMs) {
    return { valid: false, reason: 'Timestamp outside acceptable skew tolerance' };
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${timestampHeader}.${nonceHeader}.${rawBody}`)
    .digest('hex');

  const sigBuf = Buffer.from(signatureHeader, 'utf8');
  const expBuf = Buffer.from(expectedSignature, 'utf8');

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, reason: 'HMAC signature verification failed' };
  }

  return { valid: true };
}
