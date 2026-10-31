// Purpose: the one Chromium launch for scripts/ux screenshots, so two captures of one state are the same pixels.
// Chromium's partial raster repaints only the invalidated part of a tile; anti-aliased edges such as rounded corners then
// depend on the page's repaint history, and an A/A preview differed by 1 in a channel. Full raster removes that input.
// UX_CHROME_CHANNEL=chrome uses the installed Chrome when Playwright's build is absent.
export const launchOptions = (options = {}) => ({
  headless: true,
  args: ['--disable-partial-raster'],
  ...(process.env.UX_CHROME_CHANNEL ? { channel: process.env.UX_CHROME_CHANNEL } : {}),
  ...options,
});
