# Changelog

## [0.3.0](https://github.com/kbhatnagar1506/agentcompile-js/compare/v0.2.0...v0.3.0) (2026-10-07)


### Features

* retry failed capture batches with backoff; default decision budget 5 s ([#12](https://github.com/kbhatnagar1506/agentcompile-js/issues/12)) ([aec0206](https://github.com/kbhatnagar1506/agentcompile-js/commit/aec0206ff22f613392fea2b89aaca6633a83a3e0))

## [0.2.0](https://github.com/kbhatnagar1506/agentcompile-js/compare/v0.1.0...v0.2.0) (2026-10-06)


### Features

* a bounded decision, a breaker, withResponse/asResponse, fail open on what a compiled answer can't honour ([#9](https://github.com/kbhatnagar1506/agentcompile-js/issues/9)) ([a81b31e](https://github.com/kbhatnagar1506/agentcompile-js/commit/a81b31e268b5a3365322005b2f427dcdc06eb8f6))
* capture streamed answers whole; customer ids; outcome() ([#8](https://github.com/kbhatnagar1506/agentcompile-js/issues/8)) ([4644e5c](https://github.com/kbhatnagar1506/agentcompile-js/commit/4644e5c8b655f3a4332e17356b57411de74605e6))
* capture the Responses API, and any framework through captureFetch ([#11](https://github.com/kbhatnagar1506/agentcompile-js/issues/11)) ([7e89b97](https://github.com/kbhatnagar1506/agentcompile-js/commit/7e89b972452f9c53b804a42cc0fd764326e8d02d))
* scrub captured calls on this machine before they are sent ([#6](https://github.com/kbhatnagar1506/agentcompile-js/issues/6)) ([ef75daa](https://github.com/kbhatnagar1506/agentcompile-js/commit/ef75daa37f69d1980484c6f74f97414798ce1eba))


### Bug Fixes

* a batch put back on a full capture queue drops the oldest, counted ([#10](https://github.com/kbhatnagar1506/agentcompile-js/issues/10)) ([9672a3a](https://github.com/kbhatnagar1506/agentcompile-js/commit/9672a3a1c0bb2796eee0f68c18ec3abe922505e2))
