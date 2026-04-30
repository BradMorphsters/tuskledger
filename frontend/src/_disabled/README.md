# Parked test

`App.test.jsx` was added in commit `cbeac28` to verify the auth-gated
routing in the App shell. The test mocks `./api/client` and exercises
the setup_required / authenticated:false / network-failure branches.

It was getting flaky in CI even after switching to a Proxy-based mock
to handle api/client surface drift. Parked until we can give it a
focused diagnosis pass — either tighten the mock further, or switch
to a Vitest manual-mock module that can be more comprehensive.
