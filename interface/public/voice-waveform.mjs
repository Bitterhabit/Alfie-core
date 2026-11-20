export const WAVEFORM_VIEWBOX_HEIGHT = 16;
export const WAVEFORM_MIN_BAR_HEIGHT = 2.6;
export const WAVEFORM_MAX_BAR_HEIGHT = 14.4;
export const WAVEFORM_BAR_COUNT = 5;
export const WAVEFORM_RESTING_HEIGHTS = [2.6, 3.2, 3.8, 3.2, 2.6];
export const WAVEFORM_REDUCED_MOTION_HEIGHTS = [5.4, 9.6, 13.0, 9.2, 5.4];

// 5 vocal-spectrum bin windows calibrated for fftSize = 256 (128 bins, ~187.5 Hz/bin at 48 kHz)
// spanning ~185 Hz (fundamental) through ~4.5 kHz (vocal formants & consonant presence).
const VOCAL_BAND_RANGES_128 = [
  [1, 2],
  [3, 5],
  [6, 10],
  [11, 17],
  [18, 26]
];

const BAR_SYMMETRY_WEIGHTS = [0.82, 0.96, 1.08, 0.96, 0.82];
const FALLBACK_BAR_PHASES = [0.0, 1.15, 2.35, 3.45, 4.6];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Computes a normalized [0, 1] real-time audio volume level from an AnalyserNode
 * time-domain buffer (Uint8Array from getByteTimeDomainData or Float32Array from
 * getFloatTimeDomainData) using RMS amplitude with a noise-floor gate and
 * perceptual speech gain curve.
 */
export function computeRmsVolume(timeDomainData) {
  if (!timeDomainData || !timeDomainData.length) return 0;

  const isFloat = timeDomainData instanceof Float32Array;
  let sumSquares = 0;
  for (let i = 0; i < timeDomainData.length; i++) {
    const sample = isFloat ? timeDomainData[i] : (timeDomainData[i] - 128) / 128;
    sumSquares += sample * sample;
  }

  const rms = Math.sqrt(sumSquares / timeDomainData.length);
  const noiseFloor = 0.012;
  if (rms <= noiseFloor) return 0;

  const normalized = (rms - noiseFloor) * 3.4;
  return clamp(Math.pow(normalized, 0.72), 0, 1);
}

/**
 * Extracts normalized [0, 1] frequency band levels across human speech frequencies
 * from an AnalyserNode getByteFrequencyData() buffer.
 */
export function computeSpeechBandLevels(frequencyData, barCount = WAVEFORM_BAR_COUNT) {
  const count = Math.max(1, barCount);
  const levels = new Array(count).fill(0);
  if (!frequencyData || !frequencyData.length) return levels;

  const binCount = frequencyData.length;
  const scale = binCount / 128;

  for (let i = 0; i < count; i++) {
    const range = VOCAL_BAND_RANGES_128[i] || [
      Math.floor((i / count) * 26) + 1,
      Math.floor(((i + 1) / count) * 26) + 1
    ];
    const start = clamp(Math.floor(range[0] * scale), 0, binCount - 1);
    const end = clamp(Math.max(start, Math.ceil(range[1] * scale)), start, binCount - 1);

    let sum = 0;
    let bins = 0;
    for (let b = start; b <= end; b++) {
      sum += frequencyData[b] || 0;
      bins++;
    }
    const avg = bins > 0 ? sum / bins / 255 : 0;
    const trimmed = avg <= 0.04 ? 0 : (avg - 0.04) / 0.96;
    levels[i] = clamp(Math.pow(trimmed, 0.85), 0, 1);
  }

  return levels;
}

/**
 * Computes centered SVG <rect> metrics ({ height, y }) for each waveform bar directly
 * from real-time AnalyserNode time-domain volume and vocal frequency bands.
 */
export function computeBarHeightsFromAnalyser({
  timeDomainData,
  frequencyData,
  barCount = WAVEFORM_BAR_COUNT,
  minHeight = WAVEFORM_MIN_BAR_HEIGHT,
  maxHeight = WAVEFORM_MAX_BAR_HEIGHT,
  viewBoxHeight = WAVEFORM_VIEWBOX_HEIGHT
} = {}) {
  const count = Math.max(1, barCount);
  const rmsVolume = computeRmsVolume(timeDomainData);
  const bands = computeSpeechBandLevels(frequencyData, count);
  const bandPeak = bands.reduce((acc, val) => (val > acc ? val : acc), 0);
  const effectiveVolume = clamp(Math.max(rmsVolume, bandPeak * 0.82), 0, 1);
  const span = Math.max(0, maxHeight - minHeight);

  const bars = [];
  for (let i = 0; i < count; i++) {
    let height = minHeight;
    if (effectiveVolume > 0.005) {
      const weight = BAR_SYMMETRY_WEIGHTS[i] ?? 0.92;
      const bandEnergy = bands[i] ?? effectiveVolume;
      // Blend overall real-time RMS volume with per-band speech spectrum energy
      const combined = clamp(effectiveVolume * 0.62 * weight + bandEnergy * 0.52, 0, 1);
      height = clamp(minHeight + combined * span, minHeight, maxHeight);
    }
    const y = (viewBoxHeight - height) / 2;
    bars.push({ height, y });
  }

  return {
    volume: effectiveVolume,
    rmsVolume,
    bands,
    bars
  };
}

/**
 * Fallback height calculation when secondary getUserMedia/AnalyserNode is unavailable;
 * driven by Web Speech API audio/speech stream events.
 */
export function computeBarHeightsFromSpeechEnergy({
  energy = 0,
  barCount = WAVEFORM_BAR_COUNT,
  phase = 0,
  minHeight = WAVEFORM_MIN_BAR_HEIGHT,
  maxHeight = WAVEFORM_MAX_BAR_HEIGHT,
  viewBoxHeight = WAVEFORM_VIEWBOX_HEIGHT
} = {}) {
  const count = Math.max(1, barCount);
  const clampedEnergy = clamp(energy, 0, 1);
  const span = Math.max(0, maxHeight - minHeight);
  const bars = [];

  for (let i = 0; i < count; i++) {
    const barPhase = FALLBACK_BAR_PHASES[i] ?? i * 1.1;
    const weight = BAR_SYMMETRY_WEIGHTS[i] ?? 0.92;
    const waveA = 0.5 + 0.5 * Math.sin(phase * 1.55 + barPhase);
    const waveB = 0.5 + 0.5 * Math.sin(phase * 2.45 - barPhase * 0.7);
    const level = clamp(clampedEnergy * weight * (0.45 * waveA + 0.4 * waveB + 0.15), 0, 1);
    const height = clamp(minHeight + level * span, minHeight, maxHeight);
    const y = (viewBoxHeight - height) / 2;
    bars.push({ height, y });
  }

  return {
    volume: clampedEnergy,
    bars
  };
}

/**
 * Applies asymmetric VU-meter ballistic smoothing: fast attack on volume spikes,
 * smooth controlled release as audio subsides.
 */
export function smoothBarHeights(previousHeights, targetHeights, { attack = 0.58, release = 0.24 } = {}) {
  return targetHeights.map((target, index) => {
    const prev = typeof previousHeights?.[index] === "number" ? previousHeights[index] : target;
    const factor = target >= prev ? attack : release;
    return prev + (target - prev) * factor;
  });
}

/**
 * Applies computed bar heights directly to SVG <rect> height and centered y attributes,
 * preserving undistorted rounded pill caps (rx).
 */
export function applyBarHeightsToSvg(barElements, heights, viewBoxHeight = WAVEFORM_VIEWBOX_HEIGHT) {
  if (!barElements || !barElements.length) return;
  for (let i = 0; i < barElements.length; i++) {
    const bar = barElements[i];
    const height = clamp(
      typeof heights?.[i] === "number" ? heights[i] : WAVEFORM_MIN_BAR_HEIGHT,
      WAVEFORM_MIN_BAR_HEIGHT,
      WAVEFORM_MAX_BAR_HEIGHT
    );
    const y = (viewBoxHeight - height) / 2;
    bar.setAttribute("height", height.toFixed(2));
    bar.setAttribute("y", y.toFixed(2));
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.AlfieVoiceWaveform = {
    WAVEFORM_VIEWBOX_HEIGHT,
    WAVEFORM_MIN_BAR_HEIGHT,
    WAVEFORM_MAX_BAR_HEIGHT,
    WAVEFORM_BAR_COUNT,
    WAVEFORM_RESTING_HEIGHTS,
    WAVEFORM_REDUCED_MOTION_HEIGHTS,
    computeRmsVolume,
    computeSpeechBandLevels,
    computeBarHeightsFromAnalyser,
    computeBarHeightsFromSpeechEnergy,
    smoothBarHeights,
    applyBarHeightsToSvg
  };
}
