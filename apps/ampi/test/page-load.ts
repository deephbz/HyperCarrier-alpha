import type { Page } from "playwright";

// A test page loads while the runner's other test files load theirs. On a busy runner one page took 7 s to load and
// 3.5 s more to paint (taskpolicy -b, three files at once), so a short default timeout failed the test before its
// first assertion. Page load and first paint get this budget; waits for the page's own behaviour keep the file's
// short default.
export const PAGE_LOAD_MS = 20_000;

/** Gives navigation (goto, reload) the page-load budget. setDefaultTimeout does not override it. */
export const loadBudget = (page: Page) => page.setDefaultNavigationTimeout(PAGE_LOAD_MS);
