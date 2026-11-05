import { BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 10_000;

/** Only ordinary globally routable addresses. Private, mapped, transition and
 * reserved ranges cannot be used as an indirect route to an internal service. */
function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2)) || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) === 6) {
    const parts = address.toLowerCase().split(':');
    const first = parseInt(parts[0] || '0', 16);
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && first !== 0x3fff && !(first === 0x2001 && (parseInt(parts[1] || '0', 16) === 0 || parseInt(parts[1] || '0', 16) === 0xdb8));
  }
  return false;
}

interface ImageFetchDependencies {
  lookup?: typeof lookup;
  request?: typeof request;
}

/** Fetch an untrusted catalogue image without following redirects or resolving
 * a checked hostname a second time. No caller credentials/headers are forwarded. */
export async function fetchTryOnGarment(rawUrl: string, deps: ImageFetchDependencies = {}): Promise<{ buf: Buffer; mime: string }> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new BadRequestException('A public HTTPS garment image is required.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || /^(?:localhost|.*\.(?:localhost|local|internal|home\.arpa))\.?$/.test(host)) throw new BadRequestException('A public HTTPS garment image is required.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let addresses: { address: string; family: number }[];
  try {
    const resolved = isIP(host) ? Promise.resolve([{ address: host, family: isIP(host) }]) : (deps.lookup || lookup)(host, { all: true, verbatim: true });
    addresses = await Promise.race([resolved, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Image lookup timed out.')), IMAGE_TIMEOUT_MS); })]);
  } catch { throw new BadRequestException('The public garment image could not be reached.'); }
  finally { if (timer) clearTimeout(timer); }
  if (!addresses.length || addresses.some(value => !publicAddress(value.address))) throw new BadRequestException('A public HTTPS garment image is required.');
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    const fail = () => reject(new BadRequestException('The garment image could not be read safely.'));
    const req = (deps.request || request)(url, {
      method: 'GET', agent: false,
      headers: { accept: 'image/jpeg,image/png,image/webp' },
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      // Node may request a list for automatic family selection. Both shapes
      // use only the already checked address; DNS rebinding cannot replace it.
      lookup: ((_hostname: string, options: any, callback: any) => options?.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family)) as any,
    }, response => {
      const mime = String(response.headers['content-type'] || '').split(';')[0].toLowerCase().trim();
      const length = response.headers['content-length'];
      if (response.statusCode !== 200 || !['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(mime) || length && (!/^\d+$/.test(length) || Number(length) > MAX_IMAGE_BYTES)) {
        response.destroy(); fail(); return;
      }
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('error', fail);
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_IMAGE_BYTES) { response.destroy(); req.destroy(); fail(); return; }
        chunks.push(chunk);
      });
      response.on('end', () => bytes ? resolve({ buf: Buffer.concat(chunks), mime }) : fail());
    });
    req.on('error', fail);
    req.end();
  });
}
