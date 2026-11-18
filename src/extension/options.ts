// The options page's script: shows the stored setting in its checkbox and
// stores the box's state whenever the user changes it.

import { readSettings, type SettingsStorage } from "./settings.ts";

const storage: SettingsStorage = {
  get: (defaults) => chrome.storage.local.get(defaults),
  set: (items) => chrome.storage.local.set(items),
};

const box = document.getElementById("status-page");

if (box instanceof HTMLInputElement) {
  void readSettings(storage).then(({ statusPage }) => {
    box.checked = statusPage;
    box.disabled = false;
  });
  box.addEventListener("change", () => {
    void storage.set({ statusPage: box.checked });
  });
}
