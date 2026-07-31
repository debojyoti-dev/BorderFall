/**
 * Min-heap over tile references, backed by flat typed arrays.
 *
 * Conquest pops the cheapest border tile thousands of times per second across
 * every active attack in the match. A heap of `{ref, priority}` objects would
 * allocate one object per push and scatter them across the heap, so the hot
 * loop would be pointer-chasing garbage. Two parallel typed arrays keep the
 * whole structure contiguous and allocation-free once warmed.
 *
 * Capacity grows geometrically and never shrinks: an attack that once spanned a
 * long front will probably do so again, and re-growing every tick would undo
 * the point.
 */
export class TileHeap {
  private refs: Int32Array;
  private priorities: Float64Array;
  private size = 0;

  constructor(initialCapacity = 1024) {
    const capacity = Math.max(16, initialCapacity);
    this.refs = new Int32Array(capacity);
    this.priorities = new Float64Array(capacity);
  }

  get length(): number {
    return this.size;
  }

  get isEmpty(): boolean {
    return this.size === 0;
  }

  clear(): void {
    this.size = 0;
  }

  push(ref: number, priority: number): void {
    if (this.size === this.refs.length) this.grow();

    let index = this.size++;
    this.refs[index] = ref;
    this.priorities[index] = priority;

    // Sift up.
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if ((this.priorities[parent] as number) <= priority) break;
      this.refs[index] = this.refs[parent] as number;
      this.priorities[index] = this.priorities[parent] as number;
      index = parent;
    }
    this.refs[index] = ref;
    this.priorities[index] = priority;
  }

  /** Removes and returns the lowest-priority ref, or `-1` when empty. */
  pop(): number {
    if (this.size === 0) return -1;

    const top = this.refs[0] as number;
    this.size--;
    if (this.size === 0) return top;

    const ref = this.refs[this.size] as number;
    const priority = this.priorities[this.size] as number;

    // Sift down.
    let index = 0;
    const half = this.size >> 1;
    while (index < half) {
      let child = (index << 1) + 1;
      const right = child + 1;
      if (
        right < this.size &&
        (this.priorities[right] as number) < (this.priorities[child] as number)
      ) {
        child = right;
      }
      if ((this.priorities[child] as number) >= priority) break;
      this.refs[index] = this.refs[child] as number;
      this.priorities[index] = this.priorities[child] as number;
      index = child;
    }
    this.refs[index] = ref;
    this.priorities[index] = priority;
    return top;
  }

  /** Lowest-priority ref without removing it, or `-1` when empty. */
  peek(): number {
    return this.size === 0 ? -1 : (this.refs[0] as number);
  }

  private grow(): void {
    const nextCapacity = this.refs.length * 2;

    const refs = new Int32Array(nextCapacity);
    refs.set(this.refs);
    this.refs = refs;

    const priorities = new Float64Array(nextCapacity);
    priorities.set(this.priorities);
    this.priorities = priorities;
  }
}
