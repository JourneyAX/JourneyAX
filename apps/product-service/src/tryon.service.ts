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

  async generateTryOn(input: TryOnInput): Promise<TryOnResult> {
    const provider = this.tryOnProvider();
    if (!provider) throw new InternalServerErrorException('No image model key configured (set GEMINI_API_KEY or OPENAI_API_KEY).');
    const person = dataUrlToBuffer(input.personDataUrl);
    const garment = await fetchGarment(input.garmentImageUrl);
    const prompt = INSTRUCTION(input.garmentName, input.garmentColor);

    if (provider === 'gemini') return this.geminiTryOn(person, garment, prompt);
    return this.openaiTryOn(person, garment, prompt);
  }

  private async openaiTryOn(person: { buf: Buffer; mime: string }, garment: { buf: Buffer; mime: string }, prompt: string): Promise<TryOnResult> {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const personFile = await toFile(person.buf, 'person.png', { type: person.mime });
    const garmentFile = await toFile(garment.buf, 'garment.png', { type: garment.mime });
    const res = await client.images.edit({
      model: 'gpt-image-1',
      image: [personFile, garmentFile] as any,   // gpt-image-1 accepts multiple reference images
      prompt,
      size: '1024x1536',
      input_fidelity: 'high' as any,              // keep the shopper's face/details
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
