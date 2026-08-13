// Browser-side speech-token provider: fetches /api/speech/token, caches the
// result, and transparently re-fetches once the cached token is ~8 minutes old
// (Azure tokens live 10; the route advertises 540s). invalidate() forces a
// refresh after 401-type SDK failures.

export interface SpeechToken {
  token: string;
  region: string;
}

const REFRESH_AFTER_MS = 8 * 60 * 1000;

export class TokenProvider {
  private cached: { value: SpeechToken; fetchedAt: number } | null = null;
  private inflight: Promise<SpeechToken> | null = null;

  async get(): Promise<SpeechToken> {
    if (this.cached && Date.now() - this.cached.fetchedAt < REFRESH_AFTER_MS) {
      return this.cached.value;
    }
    if (!this.inflight) {
      this.inflight = this.fetchFresh().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /** Drop the cache (e.g. the SDK reported an auth failure) — the next get() hits the route. */
  invalidate(): void {
    this.cached = null;
  }

  private async fetchFresh(): Promise<SpeechToken> {
    const res = await fetch("/api/speech/token", { method: "POST" });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(detail || `Speech token request failed (HTTP ${res.status}).`);
    }
    const data = (await res.json()) as { token: string; region: string };
    this.cached = { value: { token: data.token, region: data.region }, fetchedAt: Date.now() };
    return this.cached.value;
  }
}
