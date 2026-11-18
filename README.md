# declarative-tab-groups

A Manifest V3 Google Chrome extension, a native-messaging host and a command, `declarative-tab-groups`, that let any local program set the exact tabs of a named Chrome tab group: the program gives the group's title and an ordered list of URLs, and the group then holds exactly those pages, in that order, with no window raised or focused. It is for Google Chrome on macOS only.

A program that talks to the host directly follows [the protocol reference](docs/protocol.md).

## The extension

The extension's service worker connects to the native host and carries out each request on Chrome's tab strip: it reads the named group, closes the pages that should go, opens the requested ones, and answers with what it did. A tab holding a form the user has not submitted stays open. An empty group keeps one page of the extension's own, which names the group.

It never focuses or raises a window, and every tab it opens is a background tab: it never makes a requested page the active tab. When a request closes the tab that is active in its window, Chrome itself picks the window's next active tab, which may be one of the new pages. It runs only in Google Chrome, and not in incognito windows; in any other browser, Chromium-based ones included, it does nothing at all.
