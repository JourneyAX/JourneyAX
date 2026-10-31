/**
 * Makes an illustration of a customer's project ("my patio with these pavers") and keeps it for the storefront to show.
 *
 * The picture is made by an image model from words only: the customer's scene and the names of the products chosen. It is an
 * illustration, never the exact product, and the card that shows it says so (the wording is the tenant's data, pack
 * `extensions.visualiser`). Files are named by tenant and an unguessable id, and served only through the runtime's internal route.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface VisualiserConfig {
  /** Image model name; defaults to the VISUALISER_MODEL environment variable. */
  model?: string;
  /** `low` is fast and cheap enough for a conversation; `medium` and `high` take longer. */
  quality?: 'low' | 'medium' | 'high';
  size?: '1024x1024' | '1536x1024' | '1024x1536';
  /** The prompt, with {scene} and {products} where the customer's words and the product names go. */
  promptTemplate?: string;
  /** Shown under the picture. */
  disclaimer?: string;
  maxProducts?: number;
}

export interface MadeVisual { id: string; tenantId: string; bytes: number; model: string; prompt: string; urlPath: string }

const MAX_SCENE_CHARS = 500;
const MAX_TITLE_CHARS = 120;
export const DEFAULT_VISUAL_PROMPT = 'An illustration of {scene}. It uses these products: {products}. Natural daylight, realistic materials, no text, no logos.';
const ID_PATTERN = /^[a-f0-9]{32}$/;
const TENANT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function visualStoreDir(): string {
  return process.env.VISUAL_STORE_DIR || path.join(process.cwd(), 'tmp', 'visuals');
}

const fileFor = (dir: string, tenantId: string, id: string) => path.join(dir, `${tenantId}__${id}.png`);

export function buildVisualPrompt(scene: string, productTitles: string[], template?: string): string {
  const cleanScene = String(scene || '').replace(/\s+/g, ' ').trim().slice(0, MAX_SCENE_CHARS);
  const products = productTitles.map((title) => String(title).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS)).filter(Boolean).join('; ');
  return (template || DEFAULT_VISUAL_PROMPT).replace('{scene}', cleanScene).replace('{products}', products || 'the products the customer chose');
}

export async function generateVisual(params: {
  tenantId: string;
  scene: string;
  productTitles: string[];
  config?: VisualiserConfig;
  apiKey?: string;
  storeDir?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<MadeVisual> {
  const { tenantId } = params;
  if (!TENANT_PATTERN.test(tenantId)) throw new Error('invalid tenant');
  const apiKey = params.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('no image model key is configured');
  const config = params.config || {};
  const model = config.model || process.env.VISUALISER_MODEL || 'gpt-image-1.5';
  const prompt = buildVisualPrompt(params.scene, params.productTitles.slice(0, config.maxProducts ?? 5), config.promptTemplate);
  const response = await (params.fetchImpl || fetch)('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, prompt, size: config.size || '1024x1024', quality: config.quality || 'low', n: 1 }),
    signal: params.signal,
  });
  const body: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`the image model refused the request (${response.status}${body?.error?.code ? `: ${body.error.code}` : ''})`);
  const b64 = body?.data?.[0]?.b64_json;
  if (typeof b64 !== 'string' || b64.length === 0) throw new Error('the image model returned no picture');
  const bytes = Buffer.from(b64, 'base64');
  const id = randomBytes(16).toString('hex');
  const dir = params.storeDir || visualStoreDir();
  await mkdir(dir, { recursive: true });
  await writeFile(fileFor(dir, tenantId, id), bytes);
  return { id, tenantId, bytes: bytes.length, model, prompt, urlPath: `/api/visuals/${tenantId}/${id}` };
}

/** The stored picture, or null for an id or tenant that is malformed or has no file (never a path outside the store). */
export async function readVisual(tenantId: string, id: string, storeDir = visualStoreDir()): Promise<Buffer | null> {
  if (!TENANT_PATTERN.test(tenantId) || !ID_PATTERN.test(id)) return null;
  try { return await readFile(fileFor(storeDir, tenantId, id)); } catch { return null; }
}
