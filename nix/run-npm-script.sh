# Runs the package.json script $script in a writable copy of $src, with the
# flake's build of the npm dependencies ($nodeModules) as its node_modules.
# The build command of the flake's npm checks.
cp -R "$src" source
chmod -R u+w source
cd source
ln -s "$nodeModules" node_modules
export HOME="$TMPDIR/home"
npm run --silent "$script"
touch "$out"
