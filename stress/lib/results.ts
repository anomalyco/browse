import fs from "node:fs"
import path from "node:path"

export class Jsonl {
  readonly file: string
  constructor(dir: string, name: string) { this.file = path.join(dir, name) }
  write(record: Record<string, unknown>) {
    fs.appendFileSync(this.file, `${JSON.stringify({ t: new Date().toISOString(), ...record })}\n`)
  }
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}

/** Least-squares slope of y over x (per unit of x). */
export function slope(points: [number, number][]): number {
  const n = points.length
  if (n < 2) return 0
  const mx = points.reduce((s, [x]) => s + x, 0) / n
  const my = points.reduce((s, [, y]) => s + y, 0) / n
  let num = 0
  let den = 0
  for (const [x, y] of points) { num += (x - mx) * (y - my); den += (x - mx) ** 2 }
  return den === 0 ? 0 : num / den
}

export function oneLine(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/\s+/g, " ").slice(0, 300)
}

export function mdEscape(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ")
}
