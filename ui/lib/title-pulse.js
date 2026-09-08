'use strict';

// Only the per-window title context changes on each frame. No settings writes,
// broker calls, sounds, focus changes or native handle discovery on this timer.
class TitlePulse {
  constructor(write, {interval = 800, schedule = setTimeout, cancel = clearTimeout, onError = () => {}} = {}) {
    this.write = write; this.interval = interval; this.schedule = schedule; this.cancel = cancel; this.onError = onError;
    this.prefix = ''; this.enabled = false; this.phase = true; this.timer = null;
    this.generation = 0; this.disposed = false; this.lastResult = null; this.pending = null;
  }
  update(prefix, enabled) {
    enabled = !!enabled && !!prefix;
    if (this.disposed) return Promise.resolve({applied: false});
    if (prefix === this.prefix && enabled === this.enabled && (this.pending || this.lastResult?.applied)) {
      return this.pending || Promise.resolve(this.lastResult);
    }
    this.clearTimer(); this.prefix = prefix; this.enabled = enabled; this.phase = true;
    const generation = ++this.generation;
    return this.frame(generation);
  }
  async frame(generation) {
    const value = this.phase ? this.prefix : this.prefix.replace(/^[🟡🔴]+/u, '⚪');
    const pending = Promise.resolve().then(() => this.write(value));
    this.pending = pending;
    try {
      const result = await pending;
      if (this.disposed || generation !== this.generation) return result;
      this.lastResult = result;
      if (result?.applied && this.enabled) {
        this.timer = this.schedule(() => {
          this.timer = null;
          if (this.disposed || generation !== this.generation) return;
          this.phase = !this.phase;
          this.frame(generation).catch(this.onError);
        }, this.interval);
        this.timer?.unref?.();
      }
      return result;
    } catch (error) {
      if (generation === this.generation) this.lastResult = null;
      throw error;
    } finally { if (this.pending === pending) this.pending = null; }
  }
  clearTimer() { if (this.timer !== null) this.cancel(this.timer); this.timer = null; }
  dispose() { this.disposed = true; ++this.generation; this.clearTimer(); }
}
module.exports = {TitlePulse};
