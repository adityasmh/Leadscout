// src/pipeline-channels.ts
// Order L54G-pipeline-channels: pass channel dependencies from the pipeline into
// research and resolve. Live use stays OFF by default via env switch; when deps are
// absent the pipeline behaves exactly as before.
import type { ChannelDeps } from "./channels/types.js";

export const CHANNELS_LIVE_ENV = "LEADSCOUT_CHANNELS_LIVE";

export type ChannelDepsResult = { deps?: ChannelDeps; note?: string };

export async function channelDepsForJob(
  injected: ChannelDeps | null | undefined,
  env: Record<string, string | undefined> = process.env,
): Promise<ChannelDepsResult> {
  try {
    if (injected === null) return {};
    if (injected !== undefined) {
      await import("./channels/index.js");
      return { deps: injected };
    }
    if (env[CHANNELS_LIVE_ENV] === "1") {
      await import("./channels/index.js");
      const live = await import("./channels/live-deps.js");
      return { deps: await live.makeLiveDeps(env) };
    }
    return {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { note: `channels unavailable: ${message}` };
  }
}
