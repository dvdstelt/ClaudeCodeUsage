// Pin GI library versions. Imported (for its side effect) before any `gi://Soup`
// import so the version is set before the typelib is first loaded. ESM evaluates
// imported modules in source order, so this must be imported first.
imports.gi.versions.Soup = '3.0';
