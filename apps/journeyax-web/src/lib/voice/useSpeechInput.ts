'use client';

/**
 * Phase 1 voice input (docs/v3-card-cms-architecture.md) — browser
 * SpeechRecognition only, no server round-trip, no TTS. Interim results
 * stream back so the caller can show them inline; a final result is handed
 * back once and the caller decides whether to send it.
 *
 * Listening stays on until stop() or cancel(). Chromium ends a session on its
 * own after a pause; we restart it while the customer still wants the mic open.
 * Phrases stay buffered until stop() so the composer can show a waveform, then
 * "Transcribing", then the words.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type SpeechInputError = 'not-allowed' | 'no-speech' | 'audio-capture' | 'network';

interface UseSpeechInputOptions {
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void;
  lang?: string;
}

export function useSpeechInput({ onInterim, onFinal, lang = 'en-US' }: UseSpeechInputOptions) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  const [error, setError] = useState<SpeechInputError | null>(null);
  const recognitionRef = useRef<any>(null);
  const keepAliveRef = useRef(false);
  const discardRef = useRef(false);
  const finalRef = useRef('');
  const interimRef = useRef('');
  const resolveStopRef = useRef<((text: string) => void) | null>(null);
  const callbacksRef = useRef({ onInterim, onFinal });
  callbacksRef.current = { onInterim, onFinal };

  const takeTranscript = () => {
    const text = `${finalRef.current} ${interimRef.current}`.replace(/\s+/g, ' ').trim();
    finalRef.current = '';
    interimRef.current = '';
    return text;
  };

  useEffect(() => {
    const Ctor = typeof window !== 'undefined' ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : null;
    setSupported(!!Ctor);
    if (!Ctor) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = lang;
    rec.onresult = (e: any) => {
      if (recognitionRef.current !== rec) return;
      let finalText = '';
      let interimText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += chunk;
        else interimText += chunk;
      }
      if (finalText.trim()) {
        finalRef.current = `${finalRef.current} ${finalText}`.replace(/\s+/g, ' ').trim();
        interimRef.current = '';
        callbacksRef.current.onFinal?.(finalText.trim());
      }
      if (interimText) {
        interimRef.current = interimText;
        callbacksRef.current.onInterim?.(interimText);
      }
    };
    rec.onend = () => {
      if (recognitionRef.current !== rec) return;
      if (resolveStopRef.current) {
        const resolve = resolveStopRef.current;
        resolveStopRef.current = null;
        const discarded = discardRef.current;
        discardRef.current = false;
        resolve(discarded ? '' : takeTranscript());
        setListening(false);
        return;
      }
      if (!keepAliveRef.current) {
        setListening(false);
        return;
      }
      try { rec.start(); } catch { keepAliveRef.current = false; setListening(false); }
    };
    rec.onerror = (e: any) => {
      const code = e?.error as string;
      if (code === 'aborted') return;
      if (code === 'no-speech') {
        setError('no-speech');
        return;
      }
      keepAliveRef.current = false;
      setListening(false);
      if (code === 'not-allowed' || code === 'audio-capture' || code === 'network') setError(code);
    };
    recognitionRef.current = rec;
    return () => {
      keepAliveRef.current = false;
      try { rec.stop(); } catch { /* noop */ }
    };
  }, [lang]);

  const start = useCallback(() => {
    if (!recognitionRef.current || keepAliveRef.current) return;
    setError(null);
    keepAliveRef.current = true;
    try { recognitionRef.current.start(); setListening(true); } catch { keepAliveRef.current = false; }
  }, []);

  const stop = useCallback(() => new Promise<string>((resolve) => {
    if (!keepAliveRef.current && !recognitionRef.current) {
      resolve('');
      return;
    }
    keepAliveRef.current = false;
    discardRef.current = false;
    resolveStopRef.current = resolve;
    try { recognitionRef.current?.stop(); }
    catch {
      resolveStopRef.current = null;
      resolve(takeTranscript());
      setListening(false);
    }
  }), []);

  const cancel = useCallback(() => {
    keepAliveRef.current = false;
    discardRef.current = true;
    finalRef.current = '';
    interimRef.current = '';
    try { recognitionRef.current?.stop(); } catch { /* noop */ }
    setListening(false);
  }, []);

  return { supported, listening, error, start, stop, cancel };
}
