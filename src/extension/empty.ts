// The empty page's script: names the group from the page's `?group=`
// query. Extension pages may not run inline script, so it is a file.

const group = new URLSearchParams(location.search).get("group");
const name = document.getElementById("group");

if (group !== null && group !== "") {
  document.title = `${group} (empty)`;
  if (name !== null) {
    name.textContent = group;
  }
}
