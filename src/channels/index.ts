// Core channel adapters self-register by being imported here.
// Region- and vertical-specific adapters live in plugins/ and are opt-in via
// LEADSCOUT_PLUGINS (see src/plugins.ts and plugins/README.md).

import "./ch-websearch-discovery.js";
import "./company-intel.js";
import "./devforums.js";
import "./opendata.js";
import "./podcasts.js";
import "./youtube.js";
import { loadPlugins } from "../plugins.js";

/** Which opt-in plugins this process loaded (top-level await: ready on import). */
export const pluginReport = await loadPlugins();
