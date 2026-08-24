/**
 * fft.ts — a small, self-contained radix-2 FFT used for audio alignment.
 *
 * The audio-sync engine needs cross-correlation of two loudness envelopes to
 * estimate the relative time offset between a pair of clips. Rather than the
 * O(N·M) brute-force correlation over every possible shift, we compute the full
 * cross-correlation in frequency space via the convolution theorem:
 *
 *     cross-correlation(a,b) == IFFT( FFT(a) · conj(FFT(b)) )
 *
 * This module provides an in-place, iterative (non-recursive) Cooley–Tukey FFT
 * that runs in O(L log L) where L is the zero-padded power-of-two length. It
 * handles only real-valued inputs (our envelopes are real), represented as a
 * real array + an imaginary array that callers zero before use.
 *
 * The conj() companion of the FFT (used to compute cross-correlation) is exposed
 * directly as a full crossCorrelate() helper in align.ts.
 */

/** Next power of two >= n. Throws for n <= 0. */
export function nextPow2(n: number): number {
  if (n < 1) throw new Error("nextPow2: n must be >= 1");
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * In-place iterative radix-2 FFT.
 * `re` and `im` must be Float64Array of the same length L, a power of two.
 * On return they hold the complex spectrum: X[k] = Σ_n x[n]·e^(-2πi·nk/L).
 */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error("fft: length must be a power of two");

  // Bit-reversal permutation: rearranges inputs so the iterative butterflies
  // can run in-place in natural (bit-reversed-first) order.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  // Butterfly stages: each merges two half-length transforms into one full one.
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len; // twiddle angle for this stage
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1; // running twiddle factor w^k
      let curIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + half];
        const bIm = im[i + k + half];
        // v = b·w
        const vRe = bRe * curRe - bIm * curIm;
        const vIm = bRe * curIm + bIm * curRe;
        re[i + k] = aRe + vRe; // butterfly top
        im[i + k] = aIm + vIm;
        re[i + k + half] = aRe - vRe; // butterfly bottom
        im[i + k + half] = aIm - vIm;
        // advance twiddle: w^(k+1) = w^k · w
        const nxtRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nxtRe;
      }
    }
  }
}

/**
 * Inverse FFT (in place). Uses the `conj → fft → conj → scale` trick so we reuse
 * the forward transform unchanged.
 */
export function ifft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i]; // conjugate input
  fft(re, im);
  for (let i = 0; i < n; i++) {
    im[i] = -im[i]; // conjugate again
    re[i] /= n; // and normalize
    im[i] /= n;
  }
}
