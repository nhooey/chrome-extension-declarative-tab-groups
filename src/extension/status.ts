// The status page's script: reads the progress of the group its `?group=`
// query names from `chrome.storage.session`, and draws it again whenever
// the service worker writes it. It keeps no state of its own, so a reload
// shows the same thing. Extension pages may not run inline script, so it
// is a file.

import { progressKey, readProgress } from "./progress-store.ts";
import { drawStatus, type StatusDocument } from "./status-dom.ts";
import { view } from "./view.ts";

const group = new URLSearchParams(location.search).get("group") ?? "";

// The DOM's `appendChild` and `insertBefore` are generic over `Node`, which
// the narrowed types, free of the DOM library so that Node can test them,
// cannot name; the document has every member they list.
const page = document as unknown as StatusDocument;

const formatTime = (time: number): string =>
  new Date(time).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });

const draw = async (): Promise<void> => {
  const progress = await readProgress(
    { get: (key) => chrome.storage.session.get(key) },
    group,
  );
  drawStatus(page, view(progress), formatTime);
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && Object.hasOwn(changes, progressKey(group))) {
    void draw();
  }
});

void draw();
