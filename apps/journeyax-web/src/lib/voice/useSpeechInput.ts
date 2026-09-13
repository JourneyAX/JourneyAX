'use client';

/**
 * Phase 1 voice input (docs/v3-card-cms-architecture.md) — browser
 * SpeechRecognition only, no server round-trip, no TTS. Interim results
 * stream back so the caller can show them inline; a final result is handed
 * back once and the caller decides whether to send it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

interface UseSpeechInputOptions {
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void;
  lang?: string;
}

export function useSpeechInput({ onInterim, onFinal, lang = 'en-US' }: UseSpeechInputOptions) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    const Ctor = typeof window !== 'undefined' ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : null;
    setSupported(!!Ctor);
    if (!Ctor) return;
    const rec = new Ctor();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = lang;
    rec.onresult = (e: any) => {
      let finalText = '';
      let interimText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += chunk;
        else interimText += chunk;
      }
      if (interimText) onInterim?.(interimText);
      if (finalText) onFinal?.(finalText.trim());
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    return () => { try { rec.stop(); } catch { /* noop */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  const start = useCallback(() => {
    if (!recognitionRef.current || listening) return;
    try { recognitionRef.current.start(); setListening(true); } catch { /* already started */ }
  }, [listening]);

  const stop = useCallback(() => {
    try { recognitionRef.current?.stop(); } catch { /* noop */ }
    setListening(false);
  }, []);

  return { supported, listening, start, stop, toggle: () => (listening ? stop() : start()) };
}
