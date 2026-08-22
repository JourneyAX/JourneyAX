'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AdvisorAnswers, BodyEstimate, FitPreferenceLevel, GarmentSpec, SizingChart,
  ZONE_LABEL, ZoneFit, verdictLabel,
} from '@/lib/advisor-types';
import { advise } from '@/services/fit/advisor';
import { REFERENCE_BRANDS, toInches } from '@/services/fit/body-model';
import FitSilhouette from './FitSilhouette';
import BodyModel3D from './BodyModel3D';
import FitTuner from './FitTuner';
import SizeAcrossRange from './SizeAcrossRange';
import { BodyZone } from '@/lib/advisor-types';
import { loadProfile, saveProfile, clearProfile, describeProfile } from '@/services/fit/profile';
import './fit-advisor.css';

/**
 * "What's my size?" — the shopper-facing advisor.
 *
 * Two mountings, one flow:
 *   · FitAdvisor      — a launcher plus a modal, for a product page.
 *   · FitAdvisorFlow  — the bare steps, for the JourneyAX right-hand panel,
 *                       where the panel is already the surface and a dialog
 *                       on top of it would be a box inside a box.
 *
 * The design constraint either way is that nobody came here to fill in a
 * form. Three questions, large targets, and an answer that explains itself.
 * A shopper who does not believe the answer will ignore it, which is why
 * the fit bars and the "between sizes" admission are load-bearing.
 */

type Step = 'route' | 'body' | 'reference' | 'preference' | 'result';

const PREFERENCES: { id: FitPreferenceLevel; label: string; blurb: string }[] = [
  { id: 'snug', label: 'Close-fitting', blurb: 'Follows the body' },
  { id: 'regular', label: 'Regular', blurb: 'How it is designed to sit' },
  { id: 'relaxed', label: 'Roomy', blurb: 'Extra room to move' },
];

const CHARTS: { id: SizingChart; label: string }[] = [
  { id: 'womens', label: "Women's sizing" },
  { id: 'mens', label: "Men's sizing" },
  { id: 'unisex', label: 'Either / not sure' },
];

// ── The flow ───────────────────────────────────────────────────────────

export function FitAdvisorFlow({
  garment,
  onUseSize,
  onDone,
  ctaLabel = (size: string) => `Use size ${size}`,
}: {
  garment: GarmentSpec;
  /**
   * `detail` carries the body estimate and per-zone fit behind the chosen
   * size. Optional so existing callers are unaffected, but the try-on panel
   * needs it: drawing a garment on a body we did not actually estimate would
   * make try-on a decoration rather than a view of this shopper.
   */
  onUseSize?: (
    size: string,
    summary: string,
    detail?: { body: BodyEstimate; zones: ZoneFit[] }
  ) => void;
  /** Called after the shopper picks, so a host can close itself. */
  onDone?: () => void;
  ctaLabel?: (size: string) => string;
}) {
  const [step, setStep] = useState<Step>('route');
  const [answers, setAnswers] = useState<AdvisorAnswers>({});
  const [feet, setFeet] = useState('');
  const [inches, setInches] = useState('');
  const [weight, setWeight] = useState('');
  const [age, setAge] = useState('');
  const [focusZone, setFocusZone] = useState<BodyZone | null>(null);
  const [remember, setRemember] = useState(false);
  const saved = useMemo(() => loadProfile(), []);

  // Recomputed on render rather than memoised: the inputs are four small
  // numbers and the calculation is arithmetic, so caching it would cost more
  // than it saves and would risk showing a stale answer after a garment swap.
  const result = step === 'result' ? advise(garment, answers) : null;

  const reset = () => {
    setStep('route'); setAnswers({});
    setFeet(''); setInches(''); setWeight(''); setAge('');
    setFocusZone(null);
  };

  // A corrected measurement flows straight back through resolveBody, so the
  // size, the avatar and the confidence all move together as it is dragged.
  const setOverride = useCallback((zone: 'chest' | 'waist' | 'hip' | 'inseam', value: number) => {
    setAnswers(a => ({ ...a, overrides: { ...a.overrides, [zone]: value } }));
  }, []);
  const clearOverrides = useCallback(() => {
    setAnswers(a => ({ ...a, overrides: undefined }));
  }, []);

  const useSaved = () => {
    if (!saved) return;
    setAnswers(saved);
    setFeet(saved.heightIn ? String(Math.floor(saved.heightIn / 12)) : '');
    setInches(saved.heightIn ? String(Math.round(saved.heightIn % 12)) : '');
    setWeight(saved.weightLb ? String(saved.weightLb) : '');
    setAge(saved.age ? String(saved.age) : '');
    setRemember(true);
    setStep(saved.preference ? 'result' : 'preference');
  };

  const bodyReady = !!feet && !!weight && Number(feet) > 0 && Number(weight) > 0;

  const submitBody = () => {
    setAnswers(a => ({
      ...a,
      heightIn: toInches(Number(feet), Number(inches || 0)),
      weightLb: Number(weight),
      age: age ? Number(age) : undefined,
      reference: undefined,
    }));
    setStep('preference');
  };

  const pick = (size: string) => {
    const zones = result?.recommended?.zones ?? [];
    const summary = zones.length
      ? `${size} — ${zones.map(z => `${ZONE_LABEL[z.zone].toLowerCase()} ${verdictLabel(z.zone, z.verdict).toLowerCase()}`).join(', ')}`
      : size;
    if (remember) saveProfile(answers); else clearProfile();
    const chosen = result?.recommended?.size === size
      ? result?.recommended
      : result?.alternates.find(a => a.size === size);
    onUseSize?.(
      size,
      summary,
      result && chosen ? { body: result.body, zones: chosen.zones } : undefined
    );
    onDone?.();
  };

  // Three visible stages. A shopper who cannot see how much is left is a
  // shopper who abandons at the first question.
  const stage = step === 'result' ? 3 : step === 'preference' ? 2 : step === 'route' ? 0 : 1;

  return (
    <>
      {stage > 0 && (
        <div className="adv-steps" aria-hidden>
          {[1, 2, 3].map(n => (
            <span
              key={n}
              className={`adv-steps__dot${n < stage ? ' is-done' : n === stage ? ' is-now' : ''}`}
            />
          ))}
        </div>
      )}
      <div className="adv__garment">{garment.styleName}</div>

      {/* ── 1. Which route ───────────────────────────────────────────── */}
      {step === 'route' && (
        <div className="adv__body">
          <p className="adv__lead">
            {saved ? 'Pick up where you left off, or start fresh.' : 'Two ways to do this. Both take about ten seconds.'}
          </p>
          {saved && (
            <button className="adv-choice adv-choice--saved" onClick={useSaved}>
              <span className="adv-choice__title">Use my saved measurements</span>
              <span className="adv-choice__sub">{describeProfile(saved)} — straight to the answer</span>
            </button>
          )}
          <button className="adv-choice" onClick={() => setStep('body')}>
            <span className="adv-choice__title">Use my height and weight</span>
            <span className="adv-choice__sub">The more accurate of the two</span>
          </button>
          <button className="adv-choice" onClick={() => setStep('reference')}>
            <span className="adv-choice__title">I know my size in another brand</span>
            <span className="adv-choice__sub">Tell us what already fits you</span>
          </button>
          <p className="adv__fineprint">
            Used to pick a size and nothing else. No photos, no scanning, nothing stored
            unless you ask us to remember it.
          </p>
        </div>
      )}

      {/* ── 2a. Height and weight ────────────────────────────────────── */}
      {step === 'body' && (
        <div className="adv__body">
          <label className="adv-field">
            <span className="adv-field__label">How tall are you?</span>
            <div className="adv-field__row">
              <input
                className="adv-input" inputMode="numeric" value={feet}
                onChange={e => setFeet(e.target.value.replace(/\D/g, '').slice(0, 1))}
                placeholder="5" aria-label="Feet"
              />
              <span className="adv-unit">ft</span>
              <input
                className="adv-input" inputMode="numeric" value={inches}
                onChange={e => setInches(e.target.value.replace(/\D/g, '').slice(0, 2))}
                placeholder="7" aria-label="Inches"
              />
              <span className="adv-unit">in</span>
            </div>
          </label>

          <label className="adv-field">
            <span className="adv-field__label">And your weight?</span>
            <div className="adv-field__row">
              <input
                className="adv-input" inputMode="numeric" value={weight}
                onChange={e => setWeight(e.target.value.replace(/\D/g, '').slice(0, 3))}
                placeholder="150" aria-label="Pounds"
              />
              <span className="adv-unit">lb</span>
            </div>
          </label>

          <label className="adv-field">
            <span className="adv-field__label">
              Age <span className="adv-field__opt">optional</span>
            </span>
            <div className="adv-field__row">
              <input
                className="adv-input" inputMode="numeric" value={age}
                onChange={e => setAge(e.target.value.replace(/\D/g, '').slice(0, 2))}
                placeholder="32" aria-label="Age"
              />
              <span className="adv-unit">years</span>
            </div>
          </label>

          <div className="adv-field">
            <span className="adv-field__label">Which sizing do you normally buy?</span>
            <div className="adv-pills">
              {CHARTS.map(c => (
                <button
                  key={c.id}
                  className={`adv-pill${(answers.chart ?? garment.chart) === c.id ? ' is-on' : ''}`}
                  onClick={() => setAnswers(a => ({ ...a, chart: c.id }))}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <div className="adv__actions">
            <button className="adv-btn adv-btn--ghost" onClick={() => setStep('route')}>Back</button>
            <button className="adv-btn adv-btn--primary" disabled={!bodyReady} onClick={submitBody}>
              Continue
            </button>
          </div>
        </div>
      )}

      {/* ── 2b. Reference brand ──────────────────────────────────────── */}
      {step === 'reference' && (
        <div className="adv__body">
          <p className="adv__lead">Pick something you own that fits you well.</p>
          {REFERENCE_BRANDS.map(b => (
            <div key={b.id} className="adv-ref">
              <div className="adv-ref__name">{b.name}</div>
              <div className="adv-ref__sizes">
                {Object.keys(b.chestBySize).map(s => (
                  <button
                    key={s}
                    className={`adv-size${
                      answers.reference?.brandId === b.id && answers.reference?.size === s ? ' is-on' : ''
                    }`}
                    onClick={() => setAnswers(a => ({
                      ...a, reference: { brandId: b.id, size: s },
                      heightIn: undefined, weightLb: undefined,
                    }))}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="adv__actions">
            <button className="adv-btn adv-btn--ghost" onClick={() => setStep('route')}>Back</button>
            <button
              className="adv-btn adv-btn--primary"
              disabled={!answers.reference}
              onClick={() => setStep('preference')}
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {/* ── 3. Preference ────────────────────────────────────────────── */}
      {step === 'preference' && (
        <div className="adv__body">
          <p className="adv__lead">How do you like things to fit?</p>
          {PREFERENCES.map(p => (
            <button
              key={p.id}
              className="adv-choice"
              onClick={() => { setAnswers(a => ({ ...a, preference: p.id })); setStep('result'); }}
            >
              <span className="adv-choice__title">{p.label}</span>
              <span className="adv-choice__sub">{p.blurb}</span>
            </button>
          ))}
          <div className="adv__actions">
            <button
              className="adv-btn adv-btn--ghost"
              onClick={() => setStep(answers.reference ? 'reference' : 'body')}
            >
              Back
            </button>
          </div>
        </div>
      )}

      {/* ── 4. The answer ────────────────────────────────────────────── */}
      {step === 'result' && (
        <div className="adv__body">
          {!result?.recommended ? (
            <p className="adv__lead">
              We could not work out a size from that. Try the height and weight route.
            </p>
          ) : (
            <>
              <div className="adv-answer">
                <div className="adv-answer__size">{result.recommended.size}</div>
                <div className="adv-answer__side">
                  <div className={`adv-answer__band adv-answer__band--${result.band}`}>
                    {result.band === 'high' ? 'Confident'
                      : result.band === 'medium' ? 'Fairly confident' : 'Best guess'}
                  </div>
                  <div className="adv-answer__verdict">{result.recommended.verdict}</div>
                </div>
              </div>

              {/* The avatar is built from these measurements, not scaled from
                  a stock model, so the gap between body and garment IS the
                  ease. The flat diagram is the fallback when WebGL is not
                  available at all. */}
              {/* The avatar is built from these measurements, not scaled from
                  a stock model, so the gap between body and garment IS the
                  ease. The flat diagram stands in where WebGL is missing. */}
              <BodyModel3D
                body={{
                  heightIn: answers.heightIn ?? 68,
                  chestIn: result.body.chest ?? 38,
                  waistIn: result.body.waist ?? 32,
                  hipIn: result.body.hip ?? 39,
                }}
                zones={result.recommended.zones}
                category={garment.category}
                stretchIn={garment.stretchIn}
                silhouette={garment.silhouette}
                size={result.recommended.size}
                focus={focusZone}
                fallback={
                  <FitSilhouette
                    body={result.body}
                    zones={result.recommended.zones}
                    category={garment.category}
                    chart={answers.chart ?? garment.chart}
                    size={result.recommended.size}
                  />
                }
              />

              <FitBars zones={result.recommended.zones} />

              <FitTuner
                body={result.body}
                zones={garment.zones}
                overrides={answers.overrides ?? {}}
                onChange={setOverride}
                onFocus={setFocusZone}
                onReset={clearOverrides}
              />

              <ul className="adv-reasons">
                {result.reasons.map(r => <li key={r}>{r}</li>)}
              </ul>

              {result.caveats.map(c => <div key={c} className="adv-caveat">{c}</div>)}

              {result.alternates.length > 0 && (
                <div className="adv-alts">
                  <div className="adv-alts__label">If you would rather</div>
                  {result.alternates.map(alt => (
                    <button key={alt.size} className="adv-alt" onClick={() => pick(alt.size)}>
                      <span className="adv-alt__size">{alt.size}</span>
                      <span className="adv-alt__why">{alt.verdict}</span>
                    </button>
                  ))}
                </div>
              )}

              <SizeAcrossRange current={garment} answers={answers} />

              <label className="adv-remember">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={e => setRemember(e.target.checked)}
                />
                <span>
                  <strong>Remember my measurements</strong>
                  <span className="adv-remember__sub">
                    Kept on this device only. Clear it any time.
                  </span>
                </span>
              </label>

              <div className="adv__actions">
                <button className="adv-btn adv-btn--ghost" onClick={reset}>Start again</button>
                <button
                  className="adv-btn adv-btn--primary"
                  onClick={() => pick(result.recommended!.size)}
                >
                  {ctaLabel(result.recommended.size)}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

// ── Modal mounting, for a product page ─────────────────────────────────

export default function FitAdvisor({
  garment,
  onUseSize,
}: {
  garment: GarmentSpec;
  onUseSize?: (size: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [nonce, setNonce] = useState(0); // remount the flow on each open
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button className="adv-launch" onClick={() => { setNonce(n => n + 1); setOpen(true); }}>
        <span className="adv-launch__icon" aria-hidden>⌖</span>
        What’s my size?
      </button>

      {open && (
        <div className="adv-scrim" onClick={e => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div
            className="adv"
            role="dialog"
            aria-modal="true"
            aria-label="Find your size"
            tabIndex={-1}
            ref={dialogRef}
          >
            <header className="adv__head">
              <div>
                <div className="adv__eyebrow">Fit Advisor</div>
                <h2 className="adv__title">Find your size</h2>
              </div>
              <button className="adv__close" onClick={() => setOpen(false)} aria-label="Close">×</button>
            </header>

            <FitAdvisorFlow
              key={nonce}
              garment={garment}
              onUseSize={size => onUseSize?.(size)}
              onDone={() => setOpen(false)}
            />
          </div>
        </div>
      )}
    </>
  );
}

/** The tight ↔ loose bars. The bit shoppers actually look at. */
export function FitBars({ zones }: { zones: ZoneFit[] }) {
  return (
    <div className="adv-bars">
      {zones.map(z => (
        <div className="adv-bar" key={z.zone}>
          <div className="adv-bar__top">
            <span className="adv-bar__zone">{ZONE_LABEL[z.zone]}</span>
            <span className={`adv-bar__verdict adv-bar__verdict--${z.verdict}`}>
              {verdictLabel(z.zone, z.verdict)}
            </span>
          </div>
          <div className="adv-bar__track">
            <span className="adv-bar__target" aria-hidden />
            <span className="adv-bar__marker" style={{ left: `${z.position * 100}%` }} aria-hidden />
          </div>
          <div className="adv-bar__ends">
            <span>{z.zone === 'inseam' ? 'Shorter' : 'Tighter'}</span>
            <span>{z.zone === 'inseam' ? 'Longer' : 'Looser'}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
