# declarative-tab-groups

A Manifest V3 Google Chrome extension, a native-messaging host and a command, `declarative-tab-groups`, that let any local program set the exact tabs of a named Chrome tab group: the program gives the group's title and an ordered list of URLs, and the group then holds exactly those pages, in that order, with no window raised or focused. It is for Google Chrome on macOS only.

A program that talks to the host directly follows [the protocol reference](docs/protocol.md).

## The extension

The extension's service worker connects to the native host and carries out each request on Chrome's tab strip: it reads the named group, closes the pages that should go, opens the requested ones, and answers with what it did. A tab holding a form the user has not submitted stays open.

It never focuses or raises a window, and every tab it opens is a background tab: it never makes a requested page the active tab. When a request closes the tab that is active in its window, its group's [status page](#the-status-page) takes that tab's place while the status page is on; while it is off, Chrome itself picks the window's next active tab, which may be one of the new pages. It runs only in Google Chrome, and not in incognito windows; in any other browser, Chromium-based ones included, it does nothing at all.

## The status page

Each group the extension sets holds the extension's status page as its first tab. The page shows what the extension is doing to the group:

- **While a request runs:** a checklist of its steps (checking the tabs for unsubmitted forms, closing, opening each URL, waiting for the pages to load), with a line for each tab or URL that changes state as the step goes.
- **Once the group is ready:** the group's title, how many pages it holds or that it is empty, and when it was last set, above the finished checklist of the latest request, which stays until the next request starts.

So no page of a request needs to become the active tab to show that something happened, and the group keeps a tab while its other pages are replaced.

The status page is on unless it is turned off:

- **For every group:** the extension's options page has one checkbox for it, on by default.
- **For one request:** the request's `statusPage` field, `true` or `false`, overrides that setting.

With it off, the group holds only the request's pages, a request closes a status page the group already has, and an empty group holds a plain page of the extension's own, which names the group.

Each page of the extension's own names its group. A request closes any that names another group, such as one opened before the group was renamed or dragged in from another group, and opens the group's own in its place. A request that never finished, because its deadline passed or the extension's service worker stopped, shows on the status page as failed.

The status page is the only tab the extension ever makes active, and only when the window's active tab is one the request is about to close: the status page then takes its place, where Chrome would otherwise make a neighbouring tab active. Nothing is made active when the active tab is outside the group, is kept for its unsubmitted form, or is not being closed.
