import test from "node:test";
import assert from "node:assert/strict";
import {
  WAVEFORM_MIN_BAR_HEIGHT,
  WAVEFORM_MAX_BAR_HEIGHT,
  WAVEFORM_VIEWBOX_HEIGHT,
  computeRmsVolume,
  computeSpeechBandLevels,
  computeBarHeightsFromAnalyser,
  computeBarHeightsFromSpeechEnergy,
  smoothBarHeights,
  applyBarHeightsToSvg
} from "../public/voice-waveform.mjs";

function makeSineTimeDomain(length, amplitude) {
  const buf = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const sample = Math.sin((i / length) * Math.PI * 8) * amplitude;
    buf[i] = Math.max(0, Math.min(255, Math.round(128 + sample * 127)));
  }
  return buf;
}

test("computeRmsVolume returns 0 for silence and scales monotonically with real audio amplitude", () => {
  const silence = new Uint8Array(256).fill(128);
  const quiet = makeSineTimeDomain(256, 0.08);
  const medium = makeSineTimeDomain(256, 0.25);
  const loud = makeSineTimeDomain(256, 0.85);

  const vSilence = computeRmsVolume(silence);
  const vQuiet = computeRmsVolume(quiet);
  const vMedium = computeRmsVolume(medium);
  const vLoud = computeRmsVolume(loud);

  assert.equal(vSilence, 0);
  assert.ok(vQuiet > 0.05 && vQuiet < vMedium, `quiet (${vQuiet}) should be below medium (${vMedium})`);
  assert.ok(vMedium < vLoud, `medium (${vMedium}) should be below loud (${vLoud})`);
  assert.ok(vLoud <= 1 && vLoud >= 0.85, `loud (${vLoud}) should be high and clamped to <= 1`);
});

test("computeSpeechBandLevels maps human vocal frequency bins cleanly into 5 bands", () => {
  const freq = new Uint8Array(128).fill(0);
  // Boost band 2 (bins 6..10) strongly and band 0 (bins 1..2) moderately
  freq[1] = 100;
  freq[2] = 100;
  for (let b = 6; b <= 10; b++) freq[b] = 230;

  const bands = computeSpeechBandLevels(freq, 5);
  assert.equal(bands.length, 5);
  assert.ok(bands[0] > 0.2 && bands[0] < 0.6, `band 0 should reflect moderate low energy (${bands[0]})`);
  assert.ok(bands[2] > 0.8, `band 2 should reflect strong vocal formant energy (${bands[2]})`);
  assert.equal(bands[4], 0, "quiet upper band should remain at 0");
});

test("computeBarHeightsFromAnalyser keeps bars at resting minimum in silence with no fake oscillation", () => {
  const silenceTime = new Uint8Array(256).fill(128);
  const silenceFreq = new Uint8Array(128).fill(0);

  const frameA = computeBarHeightsFromAnalyser({
    timeDomainData: silenceTime,
    frequencyData: silenceFreq
  });
  const frameB = computeBarHeightsFromAnalyser({
    timeDomainData: silenceTime,
    frequencyData: silenceFreq
  });

  assert.equal(frameA.volume, 0);
  assert.equal(frameA.bars.length, 5);
  for (let i = 0; i < 5; i++) {
    assert.equal(frameA.bars[i].height, WAVEFORM_MIN_BAR_HEIGHT);
    assert.equal(frameA.bars[i].height, frameB.bars[i].height);
    assert.ok(
      Math.abs(frameA.bars[i].y + frameA.bars[i].height / 2 - WAVEFORM_VIEWBOX_HEIGHT / 2) < 1e-6,
      "each bar must remain vertically centered"
    );
  }
});

test("computeBarHeightsFromAnalyser scales bar heights dynamically with real volume and frequency bands", () => {
  const quietTime = makeSineTimeDomain(256, 0.1);
  const quietFreq = new Uint8Array(128).fill(28);

  const loudTime = makeSineTimeDomain(256, 0.75);
  const loudFreq = new Uint8Array(128).fill(0);
  for (let b = 1; b <= 26; b++) loudFreq[b] = b >= 6 && b <= 10 ? 240 : 150;

  const quietRes = computeBarHeightsFromAnalyser({ timeDomainData: quietTime, frequencyData: quietFreq });
  const loudRes = computeBarHeightsFromAnalyser({ timeDomainData: loudTime, frequencyData: loudFreq });

  assert.ok(loudRes.volume > quietRes.volume, "loud audio must report higher volume");
  for (let i = 0; i < 5; i++) {
    assert.ok(
      loudRes.bars[i].height > quietRes.bars[i].height,
      `bar ${i} should grow taller on louder audio (${loudRes.bars[i].height} vs ${quietRes.bars[i].height})`
    );
    assert.ok(
      loudRes.bars[i].height >= WAVEFORM_MIN_BAR_HEIGHT && loudRes.bars[i].height <= WAVEFORM_MAX_BAR_HEIGHT,
      "bar height must remain within viewBox bounds"
    );
    assert.ok(
      Math.abs(loudRes.bars[i].y + loudRes.bars[i].height / 2 - WAVEFORM_VIEWBOX_HEIGHT / 2) < 1e-6,
      "bar must remain centered inside viewBox"
    );
  }
  assert.ok(
    loudRes.bars[2].height > loudRes.bars[0].height,
    "center vocal band with stronger FFT energy should peak above outer bands"
  );
});

test("smoothBarHeights rises quickly on attack and decays smoothly on release", () => {
  const prev = [3, 3, 3, 3, 3];
  const spike = [13, 13, 13, 13, 13];
  const rising = smoothBarHeights(prev, spike, { attack: 0.6, release: 0.2 });
  assert.equal(rising[0], 9);

  const falling = smoothBarHeights(spike, prev, { attack: 0.6, release: 0.2 });
  assert.equal(falling[0], 11);
});

test("applyBarHeightsToSvg sets numeric height and vertically centered y attributes on SVG rects", () => {
  const attrs = Array.from({ length: 5 }, () => ({}));
  const mockRects = attrs.map((store) => ({
    setAttribute(name, value) {
      store[name] = value;
    }
  }));

  applyBarHeightsToSvg(mockRects, [2.6, 6.0, 12.0, 8.0, 4.0]);

  assert.equal(attrs[0].height, "2.60");
  assert.equal(attrs[0].y, "6.70");
  assert.equal(attrs[2].height, "12.00");
  assert.equal(attrs[2].y, "2.00");
});

test("computeBarHeightsFromSpeechEnergy provides bounded centered fallback heights", () => {
  const res = computeBarHeightsFromSpeechEnergy({ energy: 0.8, phase: 1.2 });
  assert.equal(res.bars.length, 5);
  for (const bar of res.bars) {
    assert.ok(bar.height >= WAVEFORM_MIN_BAR_HEIGHT && bar.height <= WAVEFORM_MAX_BAR_HEIGHT);
    assert.ok(Math.abs(bar.y + bar.height / 2 - WAVEFORM_VIEWBOX_HEIGHT / 2) < 1e-6);
  }
});
