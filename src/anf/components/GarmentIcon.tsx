'use client';

import { Category } from '../types';

// Simple line-art garment silhouettes so product cards render without any
// external image dependency.
export default function GarmentIcon({
  category,
  color = '#1b2a3a',
}: {
  category: Category;
  color?: string;
}) {
  const stroke = '#ffffff';
  const common = {
    fill: color,
    stroke,
    strokeWidth: 2,
    strokeLinejoin: 'round' as const,
    strokeLinecap: 'round' as const,
  };

  if (category === 'Bottoms') {
    return (
      <svg viewBox="0 0 120 120" width="100%" height="100%" role="img" aria-label="Bottoms">
        <path {...common} d="M42 20h36l6 78h-22l-8-46-8 46H24z" />
        <path stroke={stroke} strokeWidth="2" d="M42 24h36" fill="none" />
      </svg>
    );
  }

  if (category === 'Outerwear') {
    return (
      <svg viewBox="0 0 120 120" width="100%" height="100%" role="img" aria-label="Outerwear">
        <path {...common} d="M44 22 30 34l-12 8 8 16 10-5v46h48V53l10 5 8-16-12-8-14-12-11 9z" />
        <path stroke={stroke} strokeWidth="2" fill="none" d="M60 31v64" />
      </svg>
    );
  }

  if (category === 'Dresses') {
    return (
      <svg viewBox="0 0 120 120" width="100%" height="100%" role="img" aria-label="Dress">
        <path {...common} d="M46 20h28l-6 20 18 58H34l18-58z" />
        <path stroke={stroke} strokeWidth="2" fill="none" d="M52 40h16" />
      </svg>
    );
  }

  // Tops (tee / knit / shirt)
  return (
    <svg viewBox="0 0 120 120" width="100%" height="100%" role="img" aria-label="Top">
      <path {...common} d="M44 24 26 34l8 20 10-4v40h32V50l10 4 8-20-18-10-8 8-12 0z" />
      <path stroke={stroke} strokeWidth="2" fill="none" d="M52 24c2 6 14 6 16 0" />
    </svg>
  );
}
