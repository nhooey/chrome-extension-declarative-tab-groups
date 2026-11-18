# Runs the installed programs of $package on the flake's own Node: the
# command's --help and --version exit 0, its install --dry-run finds the
# package's files from its own location, the host's manifest is right, and
# the host, started here rather than by Google Chrome, refuses with the
# not-google-chrome hello. The build command of the flake's `programs`
# check, with the sources the manifest check reads in $src.
set -eu

"$package/bin/declarative-tab-groups" --help >/dev/null
"$package/bin/declarative-tab-groups" --version

node "$src/scripts/check-host-manifest.ts" "$package"

if [ "$(uname -s)" = Darwin ]; then
  HOME="$TMPDIR/home" XDG_DATA_HOME='' \
    "$package/bin/declarative-tab-groups" install --dry-run >install
  for target in native-messaging-host extension; do
    if ! grep -qF -- "-> $package/share/declarative-tab-groups/$target" install; then
      echo "install --dry-run does not link $target from $package:" >&2
      cat install >&2
      exit 1
    fi
  done
  if [ -e "$TMPDIR/home" ]; then
    echo "install --dry-run changed $TMPDIR/home" >&2
    exit 1
  fi
fi

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
