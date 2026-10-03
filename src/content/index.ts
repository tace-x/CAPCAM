import { createSiteContext } from "./site-context";

/** Site context is computed without reading page content or sending commands. */
export const currentSiteContext = createSiteContext(globalThis.location.hostname);
