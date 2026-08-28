/**
 * Wrapper around `chrome.windows.*` for creating / closing the
 * dedicated Agent Window each session owns.
 *
 * Kept behind an interface so the SessionManager can be unit-tested
 * with a fake chrome.windows implementation (see
 * `__tests__/manager.test.ts`).
 */

export interface AgentWindowApi {
  create(url: string, opts?: AgentWindowCreateOptions): Promise<number>;
  remove(windowId: number): Promise<void>;
  /**
   * Guarantee the Agent Window has an active, CDP-navigable tab.
   * `chrome://` pages (including the New Tab page) reject `Page.navigate`,
   * so sessions bootstrap with `about:blank` instead.
   */
  ensureActiveTab(windowId: number, url: string): Promise<void>;
}

/** Fixed browser tab selected when a session attaches to the current tab. */
export interface CurrentTabTarget {
  windowId: number;
  tabId: number;
  url?: string;
}

/** Browser lookup kept injectable so current-tab startup is unit-testable. */
export interface CurrentTabApi {
  getLastFocusedActiveTab(): Promise<CurrentTabTarget>;
  createWorkTab?(windowId: number, url: string): Promise<CurrentTabTarget>;
  removeWorkTab?(tabId: number): Promise<void>;
}

/** Creation hints for a new Agent Window. */
export interface AgentWindowCreateOptions {
  /** Optional outer size in CSS pixels. */
  size?: { width: number; height: number };
  /** Defaults to true so existing sessions keep visible Agent Windows. */
  focused?: boolean;
}

/** Initial tab URL for every new session's Agent Window. */
export const AGENT_WINDOW_HOME = "about:blank";
/** CDP-accessible bootstrap page used when a current tab is restricted. */
export const CURRENT_TAB_WORK_HOME = "about:blank";

const CDP_BLOCKED_PROTOCOLS = new Set([
  "chrome:",
  "chrome-extension:",
  "chrome-search:",
  "chrome-untrusted:",
  "devtools:",
  "file:",
  "view-source:",
  "edge:",
  "brave:",
  "vivaldi:",
  "opera:",
]);

/** Return the blocked URL scheme, or null when page CDP may attach. */
export function cdpBlockedUrlReason(url: string | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (CDP_BLOCKED_PROTOCOLS.has(parsed.protocol)) return parsed.protocol;
  if (parsed.protocol === "about:" && parsed.pathname !== "blank") return "about:";
  if (
    parsed.protocol === "https:" &&
    (parsed.hostname === "chromewebstore.google.com" ||
      (parsed.hostname === "chrome.google.com" && parsed.pathname.startsWith("/webstore")))
  ) {
    return "chrome_web_store";
  }
  return null;
}

export const chromeAgentWindowApi: AgentWindowApi = {
  async create(url: string, opts: AgentWindowCreateOptions = {}): Promise<number> {
    const win = await chrome.windows.create({
      type: "normal",
      focused: opts.focused ?? true,
      url,
      ...(opts.size ? { width: opts.size.width, height: opts.size.height } : {}),
    });
    if (typeof win?.id !== "number") {
      throw new Error("[bh] chrome.windows.create returned no window id");
    }
    return win.id;
  },
  async remove(windowId: number): Promise<void> {
    // Callers decide whether a missing/failed removal is benign. In
    // particular, transactional session-start cleanup must be able to
    // surface a window it could not remove instead of reporting a false
    // cancellation success while the Agent Window remains open.
    await chrome.windows.remove(windowId);
  },
  async ensureActiveTab(windowId: number, url: string): Promise<void> {
    const tabs = await chrome.tabs.query({ windowId });
    const first = tabs.find((t) => typeof t.id === "number");
    if (first?.id) {
      if (!first.active) {
        await chrome.tabs.update(first.id, { active: true });
      }
      return;
    }
    await chrome.tabs.create({ windowId, url, active: true });
  },
};

export const chromeCurrentTabApi: CurrentTabApi = {
  async getLastFocusedActiveTab(): Promise<CurrentTabTarget> {
    const win = await chrome.windows.getLastFocused({
      populate: true,
      windowTypes: ["normal"],
    });
    if (typeof win.id !== "number") {
      throw new Error("[bh] chrome.windows.getLastFocused returned no window id");
    }
    const tab = win.tabs?.find((candidate) => candidate.active && typeof candidate.id === "number");
    if (!tab || typeof tab.id !== "number") {
      throw new Error(`[bh] no active tab in last-focused window ${win.id}`);
    }
    return { windowId: win.id, tabId: tab.id, url: tab.url ?? tab.pendingUrl };
  },
  async createWorkTab(windowId: number, url: string): Promise<CurrentTabTarget> {
    const tab = await chrome.tabs.create({ windowId, url, active: true });
    if (typeof tab.id !== "number") {
      throw new Error("[bh] chrome.tabs.create returned no tab id");
    }
    return {
      windowId: typeof tab.windowId === "number" ? tab.windowId : windowId,
      tabId: tab.id,
      url: tab.url ?? tab.pendingUrl ?? url,
    };
  },
  async removeWorkTab(tabId: number): Promise<void> {
    await chrome.tabs.remove(tabId);
  },
};
