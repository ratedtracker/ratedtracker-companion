"use strict";

// No privileged bridge is exposed to the page. The renderer reaches the local
// read-only API over http://127.0.0.1 exactly as a normal browser would, so the
// loaded site needs no desktop-specific code path.
