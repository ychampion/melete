# Trusted connectors

This directory implements files, web, email, calendar and the test destination.
The configured registry does not register a knowledge connector; that catalog
feature is **not claimed**.

`registry rejects duplicate connections and returns a stable connection order`
checks registration. `file boundary rejects parent traversal, absolute paths,
alternate streams and device names` checks local paths; `redirects repeat
compartment and DNS checks, with no request to the denied destination` checks
web requests.

File checks use portable filesystem APIs and do not establish a kernel boundary
against another process racing directory replacement. Live container enforcement
is **written, not run**. Mail and calendar use local protocol fixtures; general
live-account compatibility is **not claimed**.

[CONNECTORS](../../../../docs/CONNECTORS.md) contains the implementation table,
named tests and executable verification command.
