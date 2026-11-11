// OpenNext adapter configuration for the Cloudflare Workers build.
// No incremental cache is configured: every GridIQ page renders on the client
// from the API, so there is nothing to revalidate.
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({});
