"use strict";
// A workflow reference pins a version: "team-build@v2". A bare name means the newest version.
// The orchestrator reads references by the same rule.

const WorkflowRef = (() => {
  // parse splits a reference: "name@vN" gives { name, version: N }; a bare name has version 0.
  function parse(ref) {
    const text = String(ref ?? "");
    const found = /^(.*)@v([1-9][0-9]*)$/.exec(text);
    return found ? { name: found[1], version: Number(found[2]) } : { name: text, version: 0 };
  }

  // format writes a reference: the bare name when the version is 0 (the newest).
  const format = (name, version = 0) => (Number(version) > 0 ? `${name}@v${Math.floor(Number(version))}` : String(name ?? ""));

  // nameOf is the workflow name of a reference, without its version.
  const nameOf = (ref) => parse(ref).name;

  // newest is the highest version a definition lists ("versions": [1, 2, 3]); a definition
  // without the list has its own version, and one that was never stored has 0.
  function newest(def) {
    const listed = (Array.isArray(def?.versions) ? def.versions : []).map(Number).filter((n) => n > 0);
    return listed.length ? Math.max(...listed) : Number(def?.version) > 0 ? Number(def.version) : 0;
  }

  // find returns the definition a reference names among the newest definitions: the newest one
  // for a bare name or for a pin to the newest version, else undefined (an older version is not
  // in that list and has to be loaded).
  function find(defs, ref) {
    const { name, version } = parse(ref);
    const def = (Array.isArray(defs) ? defs : []).find((w) => w && w.name === name);
    return def && (!version || version === newest(def)) ? def : undefined;
  }

  return { parse, format, nameOf, newest, find };
})();
