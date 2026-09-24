'use client';

import { useEffect, useState } from 'react';

const BARS = 72;
const SAMPLE_MS = 90;

/** Live mic level, newest sample on the right. Empty until the mic opens. */
export function useMicWaveform(active: boolean) {
  const [levels, setLevels] = useState<number[]>([]);

  useEffect(() => {
    if (!active) {
      setLevels([]);
      return;
    }
    let dead = false;
    let timer: number | undefined;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    const history: number[] = [];

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (dead) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sum += v * v;
          }
          history.push(Math.min(1, Math.sqrt(sum / data.length) * 5));
          if (history.length > BARS) history.shift();
          setLevels(history.slice());
          timer = window.setTimeout(tick, SAMPLE_MS);
        };
        timer = window.setTimeout(tick, SAMPLE_MS);
      } catch {
        /* dotted baseline still shows */
      }
    })();

    return () => {
      dead = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
    };
  }, [active]);

  return levels;
}
