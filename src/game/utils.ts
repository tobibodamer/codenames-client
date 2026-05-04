/**
 * game/utils.ts
 *
 * Utility functions used internally by CNDuetGame moves.
 * Ported/stubbed from the codenames.game bundle (`o` module).
 */

// ─── Text sanitization ────────────────────────────────────────────────────────

export function sanitizeTextInput(text: string, maxLength: number): string {
  if (typeof text !== 'string') return '';
  return text.trim().substring(0, maxLength);
}

export function sanitizeClueNumberInput(value: unknown): number {
  const n = Number(value);
  if (isNaN(n) || n < 0) return 0;
  return Math.floor(n);
}

// ─── Array helpers ────────────────────────────────────────────────────────────

/**
 * Splits `arr` into two parts: `count` randomly selected items, and the rest.
 * Returns [selected, rest].
 */
export function getRandomSelectedAndRest<T>(
  arr: T[],
  count: number
): [T[], T[]] {
  if (arr.length < count) {
    throw new Error(
      `getRandomSelectedAndRest: need ${count} items but only have ${arr.length}`
    );
  }
  const copy = [...arr];
  shuffleArray(copy);
  return [copy.slice(0, count), copy.slice(count)];
}

export function shuffleArray<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ─── Timer (no-op stub — timer logic is server-authoritative) ─────────────────

// Timer state is managed server-side via pauseTimer / startTimer moves.
// The client never needs to compute timer values locally.
export function updateTimerValue(_env: unknown, _tags: string[]): void {
  // intentionally empty — server drives timer
}