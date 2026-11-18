# declarative-tab-groups

A Manifest V3 Google Chrome extension, a native-messaging host and a command, `declarative-tab-groups`, that let any local program set the exact tabs of a named Chrome tab group: the program gives the group's title and an ordered list of URLs, and the group then holds exactly those pages, in that order, with no window raised or focused. It is for Google Chrome on macOS only.

A program that talks to the host directly follows [the protocol reference](docs/protocol.md).
