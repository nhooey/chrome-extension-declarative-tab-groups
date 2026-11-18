# Checks by hand

The automated tests run the extension against an in-memory Chrome and the host and the command as processes, but no test drives a real Chrome. These checks cover what only a real Chrome shows. Each is a step to do and the result to expect.

They assume the package is installed, the extension is loaded from its stable path, and `declarative-tab-groups status` exits 0, unless a check says otherwise. "Reading" stands for any group title. "The worker's console" is the extension's service-worker console, which **Inspect views: service worker** on its card at `chrome://extensions` opens; a check that calls Chrome there calls it as the extension does.

## Tab strip

| Step                                                                                                                                   | Expected                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Save the group "Reading" in Chrome's tab group menu, then run `declarative-tab-groups set --group Reading https://example.com/`.       | The saved group holds the status page and example.com, and stays saved.                        |
| With Chrome in the background, run `set` with `--create-window` for a new group while no window can hold it.                           | A new window holds the group; Chrome is not raised or activated and the Space does not switch. |
| Repeat that while another app is full screen in its own Space.                                                                         | The full-screen app stays in front, in its Space.                                              |
| In a window behind another, make a page of the group the active tab, then `set` the group without that page, with the status page off. | The window stays behind; nothing is raised.                                                    |
| Collapse the group, then `set` it.                                                                                                     | The group stays collapsed.                                                                     |
| With a tab of the group active, run `chrome.tabs.create({ active: false, url: "https://example.com/" })` in the worker's console.      | The tab opens at the window's end, outside the group.                                          |
| With a tab to the right of the group, run `chrome.tabs.group({ groupId, tabIds: [tabId] })` for it in the worker's console.            | The tab joins the group at its end.                                                            |
| Run `chrome.tabs.move(tabId, { index })` for a tab of the group, to an index within the group, in the worker's console.                | The tab moves and stays in the group.                                                          |
| Hold a tab mid-drag, and run `set` on its group.                                                                                       | The command exits 1 with `busy`, or succeeds once the drag ends.                               |
| With Tab Group Sync on, make two saved groups titled "Reading", open both, and run `set --group Reading`.                              | The command exits 1 with `ambiguous-group` and neither group changes.                          |

## Form check

| Step                                                                                                              | Expected                                                                                              |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| In a page of the group, type into a comment box and leave it unsubmitted, then `set` the group without that page. | The tab stays open; the command lists it and exits 3.                                                 |
| In a page of the group, only click into a field and out of it, then `set` without that page.                      | The tab closes.                                                                                       |
| Let Chrome autofill a form in a page of the group, without typing, then `set` without that page.                  | The tab closes.                                                                                       |
| `set` the group without a page that is still loading.                                                             | The page is checked for unsubmitted text, then closed or kept by what it holds.                       |
| Let Chrome freeze or discard a background tab of the group (see `chrome://discards`), then `set` without it.      | The tab closes, and the command reports it as closed without the unsubmitted-form check.              |
| With "Allow access to file URLs" off, `set` the group with a `file://` URL; then turn it on and repeat.           | Off: the command exits 1 with `invalid-request` and nothing changes. On: the file opens in the group. |
| With "Allow access to file URLs" on, type into a form in a `file://` page of the group, then `set` without it.    | The tab stays open and is listed.                                                                     |

## Browser guard

| Step                                                                                                                                                | Expected                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Load the unpacked extension in Brave, or another Chromium browser, and run `declarative-tab-groups status`.                                         | The extension does nothing in that browser: it opens no connection, and no tab or group changes. |
| In Brave, run `chrome.runtime.connectNative("io.github.nhooey.declarative_tab_groups").onMessage.addListener(console.log)` in the worker's console. | It logs the host's hello, `{ hello: { refused: "not-google-chrome" } }`, and the host exits.     |
| Quit Google Chrome, and start it from the Dock; then from a copy in `~/Applications`; then let it update and relaunch.                              | Each time, within about 30 seconds, `status` exits 0.                                            |

## Connection

| Step                                                                                                             | Expected                                                                        |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Find the host's process with `pgrep -f declarative-tab-groups-host` and stop it with `kill` and that process ID. | Within about 30 seconds the extension starts a new host, and `status` exits 0.  |
| Quit Chrome.                                                                                                     | The host exits, and its socket file is gone.                                    |
| Load the extension in a second Chrome profile as well.                                                           | The second profile's host refuses with `socket-in-use`; `status` still exits 0. |
| `set` a group with URLs whose request line is 1,000,000 bytes long.                                              | The request reaches the extension and the group holds the pages.                |

## Status page

| Step                                                                                                                            | Expected                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| In a window behind another, `set` a group so that it closes the window's active tab, with the status page on.                   | The status page becomes that window's active tab; the window stays behind. |
| Create a group whose status page becomes the active tab at once.                                                                | It becomes active without a flicker of another tab.                        |
| Watch the status page while a `set` of several slow pages runs.                                                                 | It redraws as each step and each line changes state.                       |
| Turn the options page's checkbox off, then run `set` with no `--status-page` option.                                            | That request leaves the status page out, and closes the one the group had. |
| View the status page with motion on, with Reduce Motion on in macOS's Accessibility settings, and in light and dark appearance. | It animates only with motion on, and reads well in both appearances.       |
| While a `set` runs, stop the extension's service worker from `chrome://serviceworker-internals`.                                | The status page shows the request as failed.                               |

## Install

| Step                                                                                                                                                   | Expected                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Load the extension with "Load unpacked" from its stable path, update the package, run `install` again, then collect garbage in Nix and restart Chrome. | The extension still loads, at the new package's version, and `status` exits 0. |
