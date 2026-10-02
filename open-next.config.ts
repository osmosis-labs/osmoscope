import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// No incremental cache is configured: the app has no ISR or unstable_cache
// (every API route is force-dynamic), so there is nothing for it to store.
export default defineCloudflareConfig({});
