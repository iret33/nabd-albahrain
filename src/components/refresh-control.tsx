import type { ComponentProps } from "react";
import { loadPublicRefreshConfig } from "@/lib/sync/config";
import { RefreshButton } from "@/components/refresh-button";

/**
 * Where a page places the refresh button: renders it only when the public
 * refresh is enabled on this server (`PUBLIC_REFRESH_ENABLED`, read per
 * request: the root layout is `force-dynamic`).
 *
 * `RefreshButton` itself starts out enabled and only learns the kill switch
 * from its first `/api/freshness` probe, so a page that rendered it
 * unconditionally shipped two live-looking buttons in the HTML, which vanished
 * after the probe (layout shift), and which stayed as dead buttons in a browser
 * without JavaScript. Deciding on the server removes both. The button keeps its
 * own probe and 503 handling, for a switch flipped while a page stays open.
 */
export function RefreshControl(props: ComponentProps<typeof RefreshButton>) {
  if (!loadPublicRefreshConfig().enabled) return null;
  return <RefreshButton {...props} />;
}
