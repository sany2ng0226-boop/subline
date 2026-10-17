/** RMS of the exact PCM block passed to ASR, mapped from -60…0 dBFS to 0…1. */
export function audioLevel(samples: Float32Array): number {
  if (!samples.length) return 0;
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  const rms = Math.sqrt(energy / samples.length);
  return Number.isFinite(rms) && rms > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 60)) : 0;
}
