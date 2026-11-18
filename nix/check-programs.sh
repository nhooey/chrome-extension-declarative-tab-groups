# Runs the installed programs of $package on the flake's own Node: the
# command's --help and --version exit 0, and the host, started here rather
# than by Google Chrome, refuses with the not-google-chrome hello. The
# build command of the flake's `programs` check.
set -eu

"$package/bin/declarative-tab-groups" --help >/dev/null
"$package/bin/declarative-tab-groups" --version

# The host checks its parent before its argument, so it needs no origin to
# refuse; the socket path keeps it out of any real state folder.
export DECLARATIVE_TAB_GROUPS_SOCKET="$TMPDIR/s/h.sock"
if "$package/libexec/declarative-tab-groups-host" </dev/null >hello; then
  echo "the host served outside Google Chrome" >&2
  exit 1
fi
expected='{"hello":{"refused":"not-google-chrome"}}'
actual="$(tail -c +5 hello)"
if [ "$actual" != "$expected" ]; then
  echo "the host said $actual, not $expected" >&2
  exit 1
fi
touch "$out"
