# The declarative-tab-groups protocol

A local program sets or reads a named Chrome tab group by sending JSON requests to the host over a Unix socket. The `declarative-tab-groups` command speaks this protocol for you; this document is for a program that speaks it directly. It describes protocol 1.

## Transport

- **Socket:** a Unix stream socket at `${XDG_STATE_HOME:-$HOME/.local/state}/declarative-tab-groups/host.sock`, in a folder only the user can enter. When `DECLARATIVE_TAB_GROUPS_SOCKET` is set, it names the socket's path instead.
- **Framing:** UTF-8 text, one JSON object per line each way, each line ended by `\n`. An object that repeats a key counts the key's last value, as JavaScript's `JSON.parse` reads it.
- **Order:** each request line is answered by one response line, on the same connection, in the order the requests were sent. A client may send several requests before reading the responses, and may keep the connection open for more. Requests on one group, from any clients, are carried out one at a time, in the order they arrive.
- **Size:** a request line is at most 1,000,000 bytes, without its `\n`. That leaves room for the host's envelope under Chrome's cap of 1 MB (1,048,576 bytes) on a native message to the extension. A longer line is answered with `invalid-request`.

## Versions

Every request and every response has `protocol`, the version of this protocol it follows, which is `1`. A change that breaks a client raises it. Every message has exactly the fields this document lists for it.

Every response carries `protocol: 1`, failures included, so a client of another version learns which one the host speaks.

## Requests

Every request is one JSON object with these fields, and the fields of its command:

| Field      | Type   | Meaning                                |
| ---------- | ------ | -------------------------------------- |
| `protocol` | number | `1`.                                   |
| `command`  | string | The command: `set`, `get` or `status`. |

A request is checked in this order, and the first fault found is the one answered:

1. A line longer than the size limit under [Transport](#transport): `invalid-request`.
2. A line that is not one JSON object: `invalid-request`.
3. A `protocol` missing or other than `1`, the first thing checked in any line that is one JSON object: `unsupported-protocol`.
4. A `command` missing or not one of the commands: `invalid-request`.
5. A field the command does not have: `invalid-request`, naming the field.
6. A required field missing: `invalid-request`, naming the field.
7. A field of the wrong type or value: `invalid-request`, naming the field. The commands' tables give each field's type and allowed values.

### `set`

Makes a named tab group hold exactly the given pages.

| Field          | Type             | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `protocol`     | number           | `1`.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `command`      | string           | `"set"`.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `group`        | string           | The group's title: not empty after trimming, and holding no control character (U+0000 to U+001F, or U+007F). It is matched exactly as given: case and whitespace count.                                                                                                                                                                                                                                                              |
| `urls`         | array of strings | The pages the group holds, in order; it may be empty. Each URL holds no character at or below U+0020 (so no space or control character), no U+007F and no backslash; begins with `http://`, `https://` or `file://`, the scheme in any ASCII case; and parses as a URL. A `file://` URL needs the extension's "Allow access to file URLs" setting on; while it is off, the request fails with `invalid-request` and changes nothing. |
| `color`        | string           | Optional. The group's colour: `grey`, `blue`, `red`, `yellow`, `green`, `pink`, `purple`, `cyan` or `orange`.                                                                                                                                                                                                                                                                                                                        |
| `createWindow` | boolean          | Optional, `false` when absent. When the group does not exist and no Chrome window can hold it, `true` opens a window for it, not focused, instead of failing.                                                                                                                                                                                                                                                                        |
| `statusPage`   | boolean          | Optional. `true` or `false` turns the group's status page on or off for this request. When absent, the extension's own setting decides, and that setting is on unless the user turned it off. With the status page on, the group's first tab is the extension's status page, ahead of the pages of `urls`.                                                                                                                           |

After a successful `set`, the group holds one fresh tab per URL, in the order of `urls`, after its status page when that is on. The extension never focuses or raises a window and never makes a page of `urls` the active tab; when a `set` closes the tab that is active in its window, the group's status page becomes the active tab in its place while the status page is on, and while it is off Chrome itself picks the window's next active tab, which may be one of the new pages. A tab of the group that holds an unsubmitted form is kept open rather than closed, and the response lists it in `kept`.

```json request
{
  "protocol": 1,
  "command": "set",
  "group": "Reading",
  "urls": ["https://example.com/", "file:///tmp/notes.html"],
  "color": "blue",
  "statusPage": true
}
```

The success response:

| Field            | Type                 | Meaning                                                                                 |
| ---------------- | -------------------- | --------------------------------------------------------------------------------------- |
| `protocol`       | number               | `1`.                                                                                    |
| `ok`             | boolean              | `true`.                                                                                 |
| `command`        | string               | `"set"`.                                                                                |
| `group.title`    | string               | The group's title.                                                                      |
| `group.windowId` | non-negative integer | The Chrome window ID of the window holding the group.                                   |
| `group.created`  | boolean              | Whether this request created the group.                                                 |
| `opened`         | non-negative integer | How many tabs this request opened.                                                      |
| `closed`         | non-negative integer | How many tabs this request closed.                                                      |
| `kept`           | array of objects     | The tabs left open because they hold an unsubmitted form, each `{ "url", "title" }`.    |
| `unchecked`      | non-negative integer | How many tabs were closed without the unsubmitted-form check being able to run on them. |
| `loading`        | non-negative integer | How many of the opened tabs were still loading when the response was sent.              |

`opened` and `closed` count the pages of `urls` and the group's other pages, never the extension's own pages: the status page, or the page shown for an empty group.

```json response
{
  "protocol": 1,
  "ok": true,
  "command": "set",
  "group": { "title": "Reading", "windowId": 1754, "created": false },
  "opened": 3,
  "closed": 4,
  "kept": [{ "url": "https://example.org/compose", "title": "New message" }],
  "unchecked": 1,
  "loading": 2
}
```

### `get`

Reads a named tab group's tabs.

| Field      | Type   | Meaning                                              |
| ---------- | ------ | ---------------------------------------------------- |
| `protocol` | number | `1`.                                                 |
| `command`  | string | `"get"`.                                             |
| `group`    | string | The group's title, with the same rules as for `set`. |

```json request
{ "protocol": 1, "command": "get", "group": "Reading" }
```

The success response:

| Field            | Type                 | Meaning                                                                                                                                         |
| ---------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol`       | number               | `1`.                                                                                                                                            |
| `ok`             | boolean              | `true`.                                                                                                                                         |
| `command`        | string               | `"get"`.                                                                                                                                        |
| `group.title`    | string               | The group's title.                                                                                                                              |
| `group.windowId` | non-negative integer | The Chrome window ID of the window holding the group.                                                                                           |
| `tabs`           | array of objects     | The group's tabs, in order, each `{ "url", "title" }`, without the extension's own page: the status page, or the page shown for an empty group. |

```json response
{
  "protocol": 1,
  "ok": true,
  "command": "get",
  "group": { "title": "Reading", "windowId": 1754 },
  "tabs": [
    { "url": "https://example.com/", "title": "Example Domain" },
    { "url": "file:///tmp/notes.html", "title": "Notes" }
  ]
}
```

### `status`

Reports the versions of the extension and of Chrome, which also shows that the whole path to the extension works.

| Field      | Type   | Meaning     |
| ---------- | ------ | ----------- |
| `protocol` | number | `1`.        |
| `command`  | string | `"status"`. |

```json request
{ "protocol": 1, "command": "status" }
```

The success response:

| Field       | Type    | Meaning                       |
| ----------- | ------- | ----------------------------- |
| `protocol`  | number  | `1`.                          |
| `ok`        | boolean | `true`.                       |
| `command`   | string  | `"status"`.                   |
| `extension` | string  | The extension's version.      |
| `chrome`    | string  | The version of Google Chrome. |

```json response
{
  "protocol": 1,
  "ok": true,
  "command": "status",
  "extension": "0.1.0",
  "chrome": "142.0.7444.176"
}
```

## Failures

Any request can be answered with a failure instead of its success response:

| Field           | Type    | Meaning                                                  |
| --------------- | ------- | -------------------------------------------------------- |
| `protocol`      | number  | `1`.                                                     |
| `ok`            | boolean | `false`.                                                 |
| `error.code`    | string  | One of the error codes below; a client branches on this. |
| `error.message` | string  | A sentence for a person, naming the faulty field if any. |

```json response
{
  "protocol": 1,
  "ok": false,
  "error": {
    "code": "invalid-request",
    "message": "field \"urls[1]\" must begin with http://, https://, file://"
  }
}
```

### Error codes

| Code                   | Meaning                                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid-request`      | The request line is too long or is not one JSON object, or a field is unknown, missing, or of the wrong type or value.                                |
| `unsupported-protocol` | The request's `protocol` is missing or is not the version the host speaks.                                                                            |
| `ambiguous-group`      | More than one tab group has the requested title, so the request cannot tell which one is meant.                                                       |
| `no-group`             | No tab group has the requested title.                                                                                                                 |
| `no-window`            | `set` would create the group, no Chrome window can hold it, and `createWindow` is not `true`.                                                         |
| `busy`                 | Chrome refused to change the tab strip for longer than the tool waits, as it does while the user is dragging a tab; the request can be sent again.    |
| `not-connected`        | The host has no connection to the extension, such as when Chrome is not running; the command also reports it when no host is listening on the socket. |
| `not-google-chrome`    | The browser running the extension is not Google Chrome, which this tool requires.                                                                     |
| `internal`             | The tool hit a fault it did not expect, such as a malformed message between its own parts.                                                            |

## The native-messaging envelope

This section is internal to the tool: a client of the socket never sees these messages. The host and the extension exchange them over Chrome's native-messaging port, which carries the requests of every connected client at once.

- **Hello:** the host's first message on the port says whether it serves.
  - `{ "hello": { "protocol": 1 } }`: it serves the socket, speaking this protocol.
  - `{ "hello": { "refused": "not-google-chrome" } }`: the browser that started it is not Google Chrome.
  - `{ "hello": { "refused": "socket-in-use" } }`: another host already serves the socket.
- **Host to extension:** `{ "id", "request" }`, a client's request with an `id`, a non-empty string the host chooses, unique among the requests still unanswered.
- **Extension to host:** `{ "id", "response" }`, the response to the request with the same `id`.

```json host-message
{ "hello": { "protocol": 1 } }
```

```json host-message
{ "hello": { "refused": "socket-in-use" } }
```

```json host-message
{
  "id": "7",
  "request": { "protocol": 1, "command": "get", "group": "Reading" }
}
```

```json extension-message
{
  "id": "7",
  "response": {
    "protocol": 1,
    "ok": false,
    "error": {
      "code": "no-group",
      "message": "no tab group is titled \"Reading\""
    }
  }
}
```
