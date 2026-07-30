/**
 * In-process metrics registry.
 *
 * Exposes a Prometheus-compatible text endpoint without pulling in a client
 * library. The set of metrics a game server needs is small and specific — tick
 * duration, connected sockets, active matches — and the counters are read from
 * inside the simulation loop, so keeping the increment path to a plain object
 * property write is worth more than the generality of a full library.
 */

export interface HistogramSnapshot {
  count: number;
  sum: number;
  min: number;
  max: number;
  /** Approximate p95, computed from a fixed reservoir. */
  p95: number;
}

/**
 * Fixed-size ring buffer of samples.
 *
 * A ring rather than a growing array because this is written to every tick for
 * the lifetime of the process; an unbounded array would be a slow memory leak
 * that only shows up on long-lived production servers.
 */
class Histogram {
  private readonly samples: Float64Array;
  private cursor = 0;
  private filled = 0;
  private total = 0;
  private observations = 0;
  private minimum = Number.POSITIVE_INFINITY;
  private maximum = Number.NEGATIVE_INFINITY;

  constructor(capacity = 512) {
    this.samples = new Float64Array(capacity);
  }

  observe(value: number): void {
    this.samples[this.cursor] = value;
    this.cursor = (this.cursor + 1) % this.samples.length;
    if (this.filled < this.samples.length) this.filled++;
    this.total += value;
    this.observations++;
    if (value < this.minimum) this.minimum = value;
    if (value > this.maximum) this.maximum = value;
  }

  snapshot(): HistogramSnapshot {
    if (this.observations === 0) {
      return { count: 0, sum: 0, min: 0, max: 0, p95: 0 };
    }
    const window = Array.from(this.samples.subarray(0, this.filled)).sort((a, b) => a - b);
    const index = Math.min(window.length - 1, Math.floor(window.length * 0.95));
    return {
      count: this.observations,
      sum: this.total,
      min: this.minimum,
      max: this.maximum,
      p95: window[index] ?? 0,
    };
  }
}

class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, Histogram>();

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  observe(name: string, value: number): void {
    let histogram = this.histograms.get(name);
    if (!histogram) {
      histogram = new Histogram();
      this.histograms.set(name, histogram);
    }
    histogram.observe(value);
  }

  getCounter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  getGauge(name: string): number {
    return this.gauges.get(name) ?? 0;
  }

  getHistogram(name: string): HistogramSnapshot | undefined {
    return this.histograms.get(name)?.snapshot();
  }

  /** JSON view, for the debug endpoint and tests. */
  toJSON(): Record<string, unknown> {
    const histograms: Record<string, HistogramSnapshot> = {};
    for (const [name, histogram] of this.histograms) {
      histograms[name] = histogram.snapshot();
    }
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms,
    };
  }

  /** Prometheus exposition format. */
  toPrometheus(): string {
    const lines: string[] = [];

    for (const [name, value] of this.counters) {
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name} ${value}`);
    }
    for (const [name, value] of this.gauges) {
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${value}`);
    }
    for (const [name, histogram] of this.histograms) {
      const snapshot = histogram.snapshot();
      lines.push(`# TYPE ${name} summary`);
      lines.push(`${name}{quantile="0.95"} ${snapshot.p95}`);
      lines.push(`${name}_sum ${snapshot.sum}`);
      lines.push(`${name}_count ${snapshot.count}`);
      lines.push(`${name}_min ${snapshot.min}`);
      lines.push(`${name}_max ${snapshot.max}`);
    }

    return `${lines.join('\n')}\n`;
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

export const metrics = new MetricsRegistry();

/** Canonical metric names, so producers and dashboards cannot drift apart. */
export const Metric = {
  socketConnections: 'borderfall_socket_connections_total',
  socketDisconnections: 'borderfall_socket_disconnections_total',
  socketsActive: 'borderfall_sockets_active',
  commandsReceived: 'borderfall_commands_received_total',
  commandsRejected: 'borderfall_commands_rejected_total',
  matchesActive: 'borderfall_matches_active',
  playersActive: 'borderfall_players_active',
  tickDurationMs: 'borderfall_tick_duration_ms',
  tickDroppedMs: 'borderfall_tick_dropped_ms_total',
  broadcastBytes: 'borderfall_broadcast_bytes_total',
} as const;
