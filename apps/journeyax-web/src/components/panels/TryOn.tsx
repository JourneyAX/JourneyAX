'use client';
import { useRef, useState } from 'react';

interface TryOnProps { garmentImageUrl?: string; garmentName?: string; garmentColor?: string; }

// Virtual try-on: shopper uploads a photo, we composite the garment onto it (nano-banana
// / OpenAI). Framed as an AI PREVIEW ("see how it may look"), never a fit guarantee.
export default function TryOn({ garmentImageUrl, garmentName, garmentColor }: TryOnProps) {
  const [open, setOpen] = useState(false);
  const [person, setPerson] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!garmentImageUrl) return null;

  const pick = (f?: File | null) => {
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { setError('Please use a photo under 8MB.'); return; }
    const r = new FileReader();
    r.onload = () => { setPerson(String(r.result)); setResult(null); setError(null); };
    r.readAsDataURL(f);
  };

  const run = async () => {
    if (!person) return;
    setLoading(true); setError(null); setResult(null);
    try {
      const res = await fetch('/api/tryon', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personImage: person, garmentImageUrl, garmentName, garmentColor }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'Preview failed');
      setResult(j.image);
    } catch (e: any) { setError(e?.message || 'Could not generate the preview.'); }
    finally { setLoading(false); }
  };

  if (!open) {
    return (
      <button type="button" className="tryon__cta" onClick={() => setOpen(true)}>
        ✨ Try it on <span className="tryon__beta">beta</span>
      </button>
    );
  }

  return (
    <div className="tryon">
      <div className="tryon__head">
        <span className="tryon__title">Try it on</span>
        <button type="button" className="tryon__close" onClick={() => setOpen(false)}>✕</button>
      </div>

      {!result && (
        <>
          <p className="tryon__hint">Upload a clear, front-facing photo and we&apos;ll show how this may look on you.</p>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
          <div className="tryon__uploadrow">
            <button type="button" className="tryon__choose" onClick={() => fileRef.current?.click()}>
              {person ? 'Choose a different photo' : 'Choose your photo'}
            </button>
            {person && <img src={person} alt="you" className="tryon__thumb" />}
          </div>
          {person && (
            <button type="button" className="tryon__go" onClick={run} disabled={loading}>
              {loading ? 'Styling you…' : 'See it on me'}
            </button>
          )}
        </>
      )}

      {result && (
        <div className="tryon__result">
          <img src={result} alt="AI try-on preview" className="tryon__resultimg" />
          <button type="button" className="tryon__again" onClick={() => { setResult(null); setPerson(null); }}>Try another photo</button>
        </div>
      )}

      {error && <div className="tryon__error">{error}</div>}
      <p className="tryon__disclaimer">
        AI preview — a visual guide, not a guarantee of exact fit or size. Your photo is used only to create this preview.
      </p>
    </div>
  );
}
