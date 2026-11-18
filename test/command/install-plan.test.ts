import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type Entry,
  type InstallView,
  type Link,
  linksTo,
  type Place,
  placeList,
  places,
  planInstall,
  planUninstall,
  refusals,
} from "../../src/command/install-plan.ts";
import { packageRootOf } from "../../src/command/layout.ts";

const HOST_FOLDER =
  "/home/u/Library/Application Support/Google/Chrome/NativeMessagingHosts";
const HOST_LINK = `${HOST_FOLDER}/io.github.nhooey.declarative_tab_groups.json`;
const EXTENSION_LINK = "/home/u/.local/share/declarative-tab-groups/extension";
const PACKAGE = "/nix/store/new-declarative-tab-groups-0.2.0";
const OLD_PACKAGE = "/nix/store/old-declarative-tab-groups-0.1.0";
const HOST_MANIFEST = `${PACKAGE}/share/declarative-tab-groups/native-messaging-host/io.github.nhooey.declarative_tab_groups.json`;
const EXTENSION = `${PACKAGE}/share/declarative-tab-groups/extension`;

const missing: Entry = { kind: "missing" };
const folder: Entry = { kind: "folder" };
const other: Entry = { kind: "other" };
const linkTo = (target: string): Entry => ({ kind: "link", target });

const at = (() => {
  const found = places({ HOME: "/home/u" });
  assert.ok(found.ok);
  return found.value;
})();

const [hostLink, extensionLink] = linksTo(PACKAGE, placeList(at)) as [
  Link,
  Link,
];

/** A view of a link whose folder and target are there, with `entry` at its path. */
const view = (link: Link, entry: Entry): InstallView => ({
  link,
  at: entry,
  folder,
  target: link === extensionLink ? folder : other,
});

describe("places", () => {
  it("puts the host manifest in Google Chrome's folder and the extension under the data folder", () => {
    assert.deepEqual(at, {
      hostManifest: {
        path: HOST_LINK,
        folder: HOST_FOLDER,
        mark: "share/declarative-tab-groups/native-messaging-host/io.github.nhooey.declarative_tab_groups.json",
      },
      extension: {
        path: EXTENSION_LINK,
        folder: "/home/u/.local/share/declarative-tab-groups",
        mark: "share/declarative-tab-groups/extension",
      },
    });
    assert.deepEqual(
      [hostLink.target, extensionLink.target],
      [HOST_MANIFEST, EXTENSION],
    );
  });

  it("takes XDG_DATA_HOME when it is absolute, and ignores it otherwise", () => {
    const xdg = places({ HOME: "/home/u", XDG_DATA_HOME: "/data" });
    assert.ok(xdg.ok);
    assert.equal(
      xdg.value.extension.path,
      "/data/declarative-tab-groups/extension",
    );
    assert.equal(xdg.value.hostManifest.path, HOST_LINK);
    const relative = places({ HOME: "/home/u", XDG_DATA_HOME: "data" });
    assert.ok(relative.ok);
    assert.equal(relative.value.extension.path, EXTENSION_LINK);
  });

  it("needs an absolute HOME", () => {
    assert.deepEqual(places({}), {
      ok: false,
      error: "HOME must be an absolute path",
    });
    assert.equal(places({ HOME: "u" }).ok, false);
  });
});

describe("packageRootOf", () => {
  it("finds the root from the command's place in the package, and nothing elsewhere", () => {
    assert.equal(
      packageRootOf(
        `${PACKAGE}/lib/declarative-tab-groups/declarative-tab-groups.mjs`,
      ),
      PACKAGE,
    );
    assert.equal(packageRootOf("/src/command/main.ts"), null);
    assert.equal(packageRootOf(`${PACKAGE}/bin/declarative-tab-groups`), null);
  });
});

describe("planInstall", () => {
  it("links both when nothing is there", () => {
    assert.deepEqual(
      planInstall([view(hostLink, missing), view(extensionLink, missing)]),
      [
        { kind: "link", path: HOST_LINK, target: HOST_MANIFEST },
        { kind: "link", path: EXTENSION_LINK, target: EXTENSION },
      ],
    );
  });

  it("keeps a link that is already right", () => {
    assert.deepEqual(
      planInstall([
        view(hostLink, linkTo(HOST_MANIFEST)),
        view(extensionLink, linkTo(EXTENSION)),
      ]),
      [
        { kind: "keep-link", path: HOST_LINK, target: HOST_MANIFEST },
        { kind: "keep-link", path: EXTENSION_LINK, target: EXTENSION },
      ],
    );
  });

  it("replaces a link to an older package", () => {
    const previous = `${OLD_PACKAGE}/share/declarative-tab-groups/extension`;
    assert.deepEqual(planInstall([view(extensionLink, linkTo(previous))]), [
      {
        kind: "replace-link",
        path: EXTENSION_LINK,
        target: EXTENSION,
        previous,
      },
    ]);
  });

  it("refuses a regular file, a folder or a foreign link", () => {
    const cases: readonly (readonly [Entry, string])[] = [
      [other, "is a file, not this tool's link"],
      [folder, "is a folder, not this tool's link"],
      [
        linkTo("/nix/store/x-home-manager-files/extension"),
        "is a link to /nix/store/x-home-manager-files/extension, which is not this tool's",
      ],
      [
        linkTo("share/declarative-tab-groups/extension"),
        "is a link to share/declarative-tab-groups/extension, which is not this tool's",
      ],
    ];
    for (const [entry, reason] of cases) {
      const steps = planInstall([
        view(hostLink, missing),
        view(extensionLink, entry),
      ]);
      assert.deepEqual(refusals(steps), [
        { kind: "refuse", path: EXTENSION_LINK, reason },
      ]);
    }
  });

  it("makes a missing folder first, once for the links it holds", () => {
    const missingFolder = (link: Link): InstallView => ({
      ...view(link, missing),
      folder: missing,
    });
    const sameFolder: Link = {
      ...extensionLink,
      path: `${extensionLink.folder}/other`,
    };
    assert.deepEqual(
      planInstall([missingFolder(extensionLink), missingFolder(sameFolder)]),
      [
        { kind: "make-folder", path: extensionLink.folder },
        { kind: "link", path: EXTENSION_LINK, target: EXTENSION },
        { kind: "link", path: sameFolder.path, target: EXTENSION },
      ],
    );
  });

  it("refuses a folder that is a file, and a target missing from the package", () => {
    assert.deepEqual(
      refusals(planInstall([{ ...view(hostLink, missing), folder: other }])),
      [
        {
          kind: "refuse",
          path: HOST_FOLDER,
          reason: "is not a folder, and cannot be made one",
        },
      ],
    );
    assert.deepEqual(
      planInstall([{ ...view(hostLink, missing), target: missing }]),
      [
        {
          kind: "refuse",
          path: HOST_MANIFEST,
          reason: "is missing from the package",
        },
      ],
    );
  });

  it("has no refusal in a plan that may be carried out", () => {
    assert.deepEqual(
      refusals(
        planInstall([view(hostLink, missing), view(extensionLink, missing)]),
      ),
      [],
    );
  });
});

describe("planUninstall", () => {
  const uninstall = (entry: Entry) =>
    planUninstall([{ place: at.extension as Place, at: entry }]);

  it("removes this tool's link, to this package or an older one", () => {
    for (const target of [
      EXTENSION,
      `${OLD_PACKAGE}/share/declarative-tab-groups/extension`,
    ]) {
      assert.deepEqual(uninstall(linkTo(target)), [
        { kind: "remove-link", path: EXTENSION_LINK, target },
      ]);
    }
  });

  it("leaves anything else, and says why", () => {
    assert.deepEqual(uninstall(other), [
      {
        kind: "leave",
        path: EXTENSION_LINK,
        reason: "is a file, not this tool's link",
      },
    ]);
    assert.deepEqual(uninstall(folder), [
      {
        kind: "leave",
        path: EXTENSION_LINK,
        reason: "is a folder, not this tool's link",
      },
    ]);
    assert.deepEqual(uninstall(linkTo("/elsewhere")), [
      {
        kind: "leave",
        path: EXTENSION_LINK,
        reason: "is a link to /elsewhere, which is not this tool's",
      },
    ]);
  });

  it("finds nothing to do where nothing is", () => {
    assert.deepEqual(uninstall(missing), [
      { kind: "absent", path: EXTENSION_LINK },
    ]);
  });
});
