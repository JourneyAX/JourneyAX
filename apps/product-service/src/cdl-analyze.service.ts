import { BadRequestException, Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { CdlTemplateService } from './cdl-template.service';

/**
 * CDL Step 2 — Analyze the uploaded design (AI vision).
 *
 * Looks at the customer's uploaded jersey/garment image and reads the GARMENT
 * (silhouette, collar, closure) — NOT the graphic theme — into a structured shape
 * the match service can use. Classifies into the template library's OWN vocabulary
 * (its real sports / garment types) so the downstream match actually lands.
 *
 * Gemini 2.5 Flash (vision → JSON) is the default; OpenAI vision is the fallback.
 * Same key discovery as tryon.service (GEMINI_API_KEY, else OPENAI_API_KEY).
 */

export interface AnalyzeInput {
  imageUrl?: string;
  imageBase64?: string;   // raw base64 or a data: URL
  sizes?: string[];       // sizes the order needs (forwarded to match)
}

/** One extracted colour: a human name AND a real hex code, plus where it sits. */
export interface PaletteColour {
  name: string;   // e.g. "purple"
  hex: string;    // e.g. "#5b2a86" — normalised #rrggbb
  role: string;   // "primary" | "secondary" | "accent" | "text" | "outline"
}

export interface DesignAnalysis {
  sport: string;
  garmentType: string;
  division: string;
  keywords: string[];
  /** Named colours WITH hex codes — the editable swatch set for the design. */
  palette: PaletteColour[];
  /** Back-compat: bare colour names (derived from palette). */
  colors: string[];
  elements: { logo: boolean; name: boolean; number: boolean; allOverPattern: boolean };
  /** Legible lettering read off the design — used to pre-fill the configurator. */
  text: { teamName?: string; number?: string };
  /** One-line read of the design's look — the "design aesthetics" the customer asked for. */
  aesthetic: string;
  summary: string;
  provider: string;
}

/** Coerce any colour value the model returns into #rrggbb, or '' if unreadable. */
function normHex(x: any): string {
  const s = String(x || '').trim();
  const m = s.match(/#?([0-9a-fA-F]{6})\b/) || s.match(/#?([0-9a-fA-F]{3})\b/);
  if (!m) return '';
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return `#${h.toLowerCase()}`;
}

async function loadImage(input: AnalyzeInput): Promise<{ b64: string; mime: string }> {
  if (input.imageBase64) {
    const m = input.imageBase64.match(/^data:([^;]+);base64,([\s\S]*)$/);
    if (m) return { mime: m[1], b64: m[2] };
    return { mime: 'image/png', b64: input.imageBase64 };
  }
  if (input.imageUrl) {
    const r = await fetch(input.imageUrl);
    if (!r.ok) throw new BadRequestException(`image fetch failed: ${r.status}`);
    const mime = r.headers.get('content-type') || 'image/png';
    const buf = Buffer.from(await r.arrayBuffer());
    return { mime, b64: buf.toString('base64') };
  }
  throw new BadRequestException('Provide imageUrl or imageBase64.');
}

@Injectable()
export class CdlAnalyzeService {
  private readonly log = new Logger('CdlAnalyzeService');

  constructor(@Inject(CdlTemplateService) private readonly cdl: CdlTemplateService) {}

  /** Prompt built from the LIVE library vocabulary so the model classifies into our terms. */
  private prompt(): string {
    const f = this.cdl.facets();
    return [
      'You are a sportswear production analyst. Look at this uploaded custom jersey/garment DESIGN image and classify the GARMENT — its silhouette, collar and closure — NOT the graphic theme or artwork style.',
      'Return ONLY a JSON object with exactly these fields:',
      '{',
      `  "sport": pick the closest from [${f.sports.join(', ')}] (UPPERCASE),`,
      `  "garmentType": pick from [${f.garmentTypes.join(', ')}] (usually TOP or BOTTOM),`,
      '  "division": one of ["Adult","Youth","Ladies","Girls"] (Adult if unsure),',
      '  "keywords": array of construction/style words you SEE, e.g. "full-button","lace-up collar","v-neck","crew neck","raglan sleeve","set-in sleeve","sleeveless","henley","short sleeve","long sleeve",',
      '  "palette": array of the actual colours in the design, each { "name": human colour name, "hex": exact "#RRGGBB" you sample from the image, "role": one of "primary"|"secondary"|"accent"|"text"|"outline" }. Read the REAL hex off the pixels — do not guess a generic value. Order by prominence, 3–6 entries.',
      '  "elements": { "logo": boolean, "name": boolean, "number": boolean, "allOverPattern": boolean },',
      '  "text": { "teamName": the team/word lettering you can READ on it or "" , "number": the jersey number you can READ or "" },',
      '  "aesthetic": one short phrase for the design\'s LOOK/STYLE (e.g. "aggressive distressed grunge", "clean minimalist", "retro varsity"),',
      '  "summary": one short sentence describing the garment',
      '}',
      'Judge the garment TYPE by its cut/collar/closure, not by the design printed on it. Sample the palette hex values from the actual pixels.',
    ].join('\n');
  }

  async analyze(input: AnalyzeInput): Promise<DesignAnalysis> {
    const img = await loadImage(input);
    const geminiKey = process.env.GEMINI_API_KEY || '';
    const openaiKey = process.env.OPENAI_API_KEY || '';
    if (geminiKey.length > 10) return this.geminiAnalyze(img, geminiKey);
    if (openaiKey.length > 10) return this.openaiAnalyze(img, openaiKey);
    throw new InternalServerErrorException('No vision model key configured (set GEMINI_API_KEY or OPENAI_API_KEY).');
  }

  private coerce(raw: any, provider: string): DesignAnalysis {
    const arr = (x: any): string[] => (Array.isArray(x) ? x.map((v) => String(v)) : []);
    const el = raw?.elements || {};

    // Prefer the structured palette; tolerate a legacy bare-string colours array.
    const roles = ['primary', 'secondary', 'accent', 'text', 'outline'];
    const rawPal = Array.isArray(raw?.palette) ? raw.palette : [];
    const palette: PaletteColour[] = rawPal
      .map((c: any, i: number): PaletteColour => ({
        name: String(c?.name || '').trim() || `colour ${i + 1}`,
        hex: normHex(c?.hex),
        role: roles.includes(String(c?.role)) ? String(c.role) : (i === 0 ? 'primary' : i === 1 ? 'secondary' : 'accent'),
      }))
      .filter((c: PaletteColour) => c.hex);   // a swatch with no code is useless
    // Fall back to names-only if the model gave us the legacy shape.
    const colors = palette.length ? palette.map((c) => c.name) : arr(raw?.colors);

    return {
      sport: String(raw?.sport || '').toUpperCase().trim(),
      garmentType: String(raw?.garmentType || '').toUpperCase().trim(),
      division: String(raw?.division || 'Adult').trim(),
      keywords: arr(raw?.keywords),
      palette,
      colors,
      elements: {
        logo: !!el.logo, name: !!el.name, number: !!el.number, allOverPattern: !!el.allOverPattern,
      },
      text: {
        teamName: String(raw?.text?.teamName || '').trim() || undefined,
        number: String(raw?.text?.number || '').trim() || undefined,
      },
      aesthetic: String(raw?.aesthetic || '').trim(),
      summary: String(raw?.summary || '').trim(),
      provider,
    };
  }

  private async geminiAnalyze(img: { b64: string; mime: string }, key: string): Promise<DesignAnalysis> {
    const model = process.env.CDL_VISION_MODEL || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const body = {
      contents: [{ parts: [{ text: this.prompt() }, { inline_data: { mime_type: img.mime, data: img.b64 } }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
    };
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new InternalServerErrorException(`gemini analyze failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j: any = await r.json();
    const text = (j?.candidates?.[0]?.content?.parts || []).map((p: any) => p.text).filter(Boolean).join('') || '{}';
    let raw: any = {}; try { raw = JSON.parse(text); } catch { /* keep {} */ }
    return this.coerce(raw, `gemini:${model}`);
  }

  private async openaiAnalyze(img: { b64: string; mime: string }, key: string): Promise<DesignAnalysis> {
    const client = new OpenAI({ apiKey: key });
    const model = process.env.CDL_VISION_MODEL_OPENAI || 'gpt-4o-mini';
    const resp = await client.chat.completions.create({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: this.prompt() },
          { type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.b64}` } },
        ] as any,
      }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });
    let raw: any = {}; try { raw = JSON.parse(resp.choices[0]?.message?.content || '{}'); } catch { /* keep {} */ }
    return this.coerce(raw, `openai:${model}`);
  }
}
