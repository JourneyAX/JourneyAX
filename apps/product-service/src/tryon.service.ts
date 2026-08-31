import { Injectable, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import OpenAI, { toFile } from 'openai';

export interface TryOnInput {
  personDataUrl: string;      // data:image/...;base64,  (the shopper's uploaded photo)
  garmentImageUrl: string;    // product image URL from the catalogue
  garmentName?: string;
  garmentColor?: string;
}

export interface TryOnResult { imageDataUrl: string; provider: string; }

const INSTRUCTION = (name?: string, color?: string) =>
  `Apply the garment shown in the SECOND image onto the person in the FIRST image. ` +
  `Preserve the person's face, hair, body shape, pose, skin tone, background and lighting exactly — do not change their identity. ` +
  `Reproduce the garment's exact colour${color ? ` (${color})` : ''}, neckline, sleeves, pattern, length and material appearance. ` +
  `${name ? `The garment is a "${name}". ` : ''}` +
  `Render a photorealistic result with natural fit and draping. Output only the edited photo.`;

/** OpenAI images.edit only accepts image/jpeg|png|webp. Catalogue images often
 *  advertise the nonstandard "image/jpg" (and some send octet-stream); map to a
 *  supported type + matching extension so gpt-image-1 doesn't 400. */
function normImage(mime: string): { type: string; ext: string } {
  const x = (mime || '').toLowerCase().split(';')[0].trim();
  if (x === 'image/jpg' || x === 'image/jpeg') return { type: 'image/jpeg', ext: 'jpg' };
  if (x === 'image/webp') return { type: 'image/webp', ext: 'webp' };
  return { type: 'image/png', ext: 'png' };
}

function dataUrlToBuffer(dataUrl: string): { buf: Buffer; mime: string } {
  const m = dataUrl.match(/^data:([^;]+);base64,([\s\S]*)$/);
  if (!m) throw new BadRequestException('personImage must be a base64 data URL');
  return { buf: Buffer.from(m[2], 'base64'), mime: m[1] };
}

async function fetchGarment(url: string): Promise<{ buf: Buffer; mime: string }> {
  const r = await fetch(url);
  if (!r.ok) throw new BadRequestException(`garment image fetch failed: ${r.status}`);
  const mime = r.headers.get('content-type') || 'image/jpeg';
  return { buf: Buffer.from(await r.arrayBuffer()), mime };
}

@Injectable()
export class TryOnService {
  private tryOnProvider(): 'gemini' | 'openai' | null {
    if ((process.env.GEMINI_API_KEY || '').length > 10) return 'gemini';
    if ((process.env.OPENAI_API_KEY || '').length > 10) return 'openai';
    return null;
  }

  /**
   * CDL "design it in chat": generate a NEW garment concept image from a text
   * brief (nano-banana / Gemini 2.5 Flash Image, OpenAI gpt-image-1 fallback).
   * Optionally conditions on a reference image (a prior concept the customer is
   * iterating on) so "make the sleeves brighter" edits the existing look. This
   * is the "free concept" front door — the concept is later analysed + matched
   * to a real make-able template (garment ≠ design).
   *
   * Genuine runtime fallback: `tryOnProvider()` only decides which key EXISTS,
   * not which one actually WORKS this call — a key can be present but exhausted
   * (monthly spend cap), rate-limited, or down. Gemini is preferred (nano-banana
   * quality/cost), but a failure there — not just a missing key — now falls
   * through to OpenAI when it's configured, instead of the whole request dying
   * on a provider that happened to go first.
   */
  async generateFromPrompt(prompt: string, referenceDataUrl?: string): Promise<TryOnResult> {
    const hasGemini = (process.env.GEMINI_API_KEY || '').length > 10;
    const hasOpenAI = (process.env.OPENAI_API_KEY || '').length > 10;
    if (!hasGemini && !hasOpenAI) {
      throw new InternalServerErrorException('No image model key configured (set GEMINI_API_KEY or OPENAI_API_KEY).');
    }
    const ref = referenceDataUrl ? dataUrlToBuffer(referenceDataUrl) : undefined;
    if (!hasGemini) return this.openaiGenerate(prompt, ref);
    try {
      return await this.geminiGenerate(prompt, ref);
    } catch (e: any) {
      if (!hasOpenAI) throw e;
      // eslint-disable-next-line no-console
      console.warn(`[TryOnService] gemini generateFromPrompt failed, falling back to openai: ${e?.message || e}`);
      return this.openaiGenerate(prompt, ref);
    }
  }

  private async geminiGenerate(prompt: string, ref?: { buf: Buffer; mime: string }): Promise<TryOnResult> {
    const key = process.env.GEMINI_API_KEY!;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${key}`;
    const parts: any[] = [{ text: prompt }];
    if (ref) parts.push({ inline_data: { mime_type: ref.mime, data: ref.buf.toString('base64') } });
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts }] }) });
    if (!r.ok) throw new InternalServerErrorException(`gemini image failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j: any = await r.json();
    const part = j?.candidates?.[0]?.content?.parts?.find((p: any) => p.inline_data || p.inlineData);
    const inl = part?.inline_data || part?.inlineData;
    if (!inl?.data) throw new InternalServerErrorException('gemini returned no image');
    return { imageDataUrl: `data:${inl.mime_type || inl.mimeType || 'image/png'};base64,${inl.data}`, provider: 'gemini:2.5-flash-image' };
  }

  private async openaiGenerate(prompt: string, ref?: { buf: Buffer; mime: string }): Promise<TryOnResult> {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    try {
      if (ref) {
        const refFile = await toFile(ref.buf, 'concept.png', { type: ref.mime });
        const res = await client.images.edit({ model: 'gpt-image-1', image: [refFile] as any, prompt, size: '1024x1024', input_fidelity: 'high' as any });
        const b64 = res.data?.[0]?.b64_json;
        if (!b64) throw new InternalServerErrorException('image model returned no image');
        return { imageDataUrl: `data:image/png;base64,${b64}`, provider: 'openai:gpt-image-1' };
      }
      const res = await client.images.generate({ model: 'gpt-image-1', prompt, size: '1024x1024' });
      const b64 = res.data?.[0]?.b64_json;
      if (!b64) throw new InternalServerErrorException('image model returned no image');
      return { imageDataUrl: `data:image/png;base64,${b64}`, provider: 'openai:gpt-image-1' };
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error('[TryOnService] openaiGenerate failed:', e?.message || e, e?.status, e?.error || '');
      throw e;
    }
  }

  /**
   * CDL faithful proof: reproduce the customer's DESIGN (artwork, all-over
   * pattern, logo, colours, number) onto OUR garment silhouette, so the proof
   * actually looks like their design — something a flat photo mapped onto the
   * mesh's cut-piece UV atlas cannot do. `garmentImageUrl` is our make-able
   * template's photo (the shape/producible reference); `artworkDataUrl` is the
   * customer's uploaded design (data URL or http URL).
   */
  async applyArtworkToGarment(garmentImageUrl: string, artworkDataUrl: string): Promise<TryOnResult> {
    const provider = this.tryOnProvider();
    if (!provider) throw new InternalServerErrorException('No image model key configured (set GEMINI_API_KEY or OPENAI_API_KEY).');
    const garment = await fetchGarment(garmentImageUrl);
    const artwork = /^data:/.test(artworkDataUrl) ? dataUrlToBuffer(artworkDataUrl) : await fetchGarment(artworkDataUrl);
    const prompt =
      'The FIRST image is a blank team jersey (our garment shape). The SECOND image is the customer\'s DESIGN. ' +
      'Reproduce the SECOND image\'s design FAITHFULLY onto the FIRST image\'s garment — this is the whole point: ' +
      'keep the SECOND image\'s exact all-over pattern and artwork, its exact colours, its exact logo/mascot/crest AND the exact team wordmark text (spelled identically and legible), and the player number in the same position. ' +
      'Do NOT invent, blur, restyle or simplify the logo or text — it must read exactly like the customer\'s design. ' +
      'Adopt only the FIRST image\'s garment shape, cut, collar and camera view. Make it look like a real photograph of that jersey printed with this design. Output only the jersey image.';
    // Faithful proof composes a STRUCTURED design (logo + wordmark + layout) onto
    // the garment. A compositing image model (GPT-image / gpt-image-1) preserves
    // that far better than a texture/diffusion model, so prefer it here when an
    // OpenAI key exists. Override with CDL_PROOF_MODEL=gemini if ever needed.
    const useOpenAI = (process.env.OPENAI_API_KEY || '').length > 10
      && (process.env.CDL_PROOF_MODEL || 'gpt-image').toLowerCase() !== 'gemini';
    if (useOpenAI) return this.openaiTryOn(garment, artwork, prompt, '1024x1024');
    if (provider === 'gemini') return this.geminiTryOn(garment, artwork, prompt);
    return this.openaiTryOn(garment, artwork, prompt, '1024x1024');
  }

  /**
   * Faithful design as a FLAT texture (for 3D). GPT-image reproduces the design
   * as a flat, front-filling print — NO garment outline, folds or shadows — so it
   * can be projected onto the real 3D mesh's front in three.js. This is how we get
   * "faithful AND 3D": the compositing model keeps the logo/wordmark/pattern, and
   * the mesh keeps it rotatable.
   */
  async makeFlatDesign(artworkDataUrl: string): Promise<TryOnResult> {
    if ((process.env.OPENAI_API_KEY || '').length < 10) {
      throw new InternalServerErrorException('OPENAI_API_KEY required for the flat design texture.');
    }
    const art = /^data:/.test(artworkDataUrl) ? dataUrlToBuffer(artworkDataUrl) : await fetchGarment(artworkDataUrl);
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const n = normImage(art.mime);
    const file = await toFile(art.buf, `design.${n.ext}`, { type: n.type });
    const prompt =
      'Reproduce this EXACT design as a single FLAT front panel showing the COMPLETE design from top to bottom with NOTHING cropped or zoomed — the entire layout must be fully visible and centred. ' +
      'Keep the exact colours, the logo/mascot/crest, the team wordmark text spelled identically and legible, the number, and the exact pattern and placement. ' +
      'Lay it out flat, as if the garment front were unfolded into a flat rectangle. ' +
      'Do NOT draw a jersey/garment outline, collar, sleeves, folds, shadows, mannequin or background. Do not crop, do not zoom in — fit the whole design inside the frame with a little margin.';
    const res = await client.images.edit({
      model: 'gpt-image-1', image: [file] as any, prompt, size: '1024x1024', input_fidelity: 'high' as any,
    });
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) throw new InternalServerErrorException('flat design: model returned no image');
    return { imageDataUrl: `data:image/png;base64,${b64}`, provider: 'openai:gpt-image-1' };
  }

  async generateTryOn(input: TryOnInput): Promise<TryOnResult> {
    const provider = this.tryOnProvider();
    if (!provider) throw new InternalServerErrorException('No image model key configured (set GEMINI_API_KEY or OPENAI_API_KEY).');
    const person = dataUrlToBuffer(input.personDataUrl);
    const garment = await fetchGarment(input.garmentImageUrl);
    const prompt = INSTRUCTION(input.garmentName, input.garmentColor);

    if (provider === 'gemini') return this.geminiTryOn(person, garment, prompt);
    return this.openaiTryOn(person, garment, prompt);
  }

  private async openaiTryOn(person: { buf: Buffer; mime: string }, garment: { buf: Buffer; mime: string }, prompt: string, size: '1024x1024' | '1024x1536' = '1024x1536'): Promise<TryOnResult> {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const pm = normImage(person.mime), gm = normImage(garment.mime);
    const personFile = await toFile(person.buf, `person.${pm.ext}`, { type: pm.type });
    const garmentFile = await toFile(garment.buf, `garment.${gm.ext}`, { type: gm.type });
    const res = await client.images.edit({
      model: 'gpt-image-1',
      image: [personFile, garmentFile] as any,   // gpt-image-1 accepts multiple reference images
      prompt,
      size,
      input_fidelity: 'high' as any,              // keep the reference details (design / face)
    });
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) throw new InternalServerErrorException('image model returned no image');
    return { imageDataUrl: `data:image/png;base64,${b64}`, provider: 'openai:gpt-image-1' };
  }

  // Native Gemini 2.5 Flash Image ("nano banana") path — active when a GEMINI_API_KEY
  // is set. Uses the REST generateContent endpoint so we need no extra SDK dependency.
  private async geminiTryOn(person: { buf: Buffer; mime: string }, garment: { buf: Buffer; mime: string }, prompt: string): Promise<TryOnResult> {
    const key = process.env.GEMINI_API_KEY!;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${key}`;
    const body = {
      contents: [{ parts: [
        { text: prompt },
        { inline_data: { mime_type: person.mime, data: person.buf.toString('base64') } },
        { inline_data: { mime_type: garment.mime, data: garment.buf.toString('base64') } },
      ] }],
    };
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new InternalServerErrorException(`gemini image failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j: any = await r.json();
    const part = j?.candidates?.[0]?.content?.parts?.find((p: any) => p.inline_data || p.inlineData);
    const inl = part?.inline_data || part?.inlineData;
    if (!inl?.data) throw new InternalServerErrorException('gemini returned no image');
    return { imageDataUrl: `data:${inl.mime_type || inl.mimeType || 'image/png'};base64,${inl.data}`, provider: 'gemini:2.5-flash-image' };
  }
}
