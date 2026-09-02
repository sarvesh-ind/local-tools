# local-tools

**Local testing only. Do not ship. Delete this directory before handing off a template.**

This folder sits outside every template directory on purpose, so it can never be
picked up when a template is zipped. Nothing here is referenced by
`Salesforce_-_NetSuite__Advanced_` or any other template.

## delete-all-flows.js

integrator.io refuses to delete an integration while it still owns flows. This
deletes every flow of one integration in a single run, and optionally the
integration itself, so a template install can be torn down and reinstalled
without clicking through 55 flows.

Requires Node 18 or newer (uses the built-in `fetch`). No dependencies.

### Setup

Generate a token in integrator.io under **Resources > API Tokens**, then export it.
Never commit the token or paste it into a file in this repo.

```bash
export CELIGO_API_TOKEN=<your_api_token>
```

### Usage

Dry run first. Without `--confirm` nothing is deleted; it only prints what it
would delete.

```bash
node delete-all-flows.js --integration-name "Salesforce - NetSuite (Advanced)"
```

Delete the flows once the list looks right:

```bash
node delete-all-flows.js --integration-name "Salesforce - NetSuite (Advanced)" --confirm
```

Delete the flows and then the integration:

```bash
node delete-all-flows.js --integration-name "Salesforce - NetSuite (Advanced)" --confirm --delete-integration
```

Target by id instead of name when several integrations share a name:

```bash
node delete-all-flows.js --integration-id 6a4f62c335f58cd73c4ac478 --confirm
```

### Options

| Flag | Meaning |
| --- | --- |
| `--integration-id <id>` | Target integration by 24-character id. |
| `--integration-name <name>` | Target integration by exact name. |
| `--confirm` | Actually delete. Omit for a dry run. |
| `--delete-integration` | Delete the integration after its flows are gone. |
| `-h`, `--help` | Show usage. |

### Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `CELIGO_API_TOKEN` | yes | none | Bearer token. Validated at startup; the run exits non-zero if it is missing. |
| `CELIGO_API_BASE_URL` | no | `https://api.integrator.io` | Use `https://api.eu.integrator.io` for the EU data center. |
| `CELIGO_REQUEST_TIMEOUT_MS` | no | `30000` | Per-request timeout. |
| `CELIGO_DELETE_CONCURRENCY` | no | `4` | Flows deleted in parallel per batch. |
| `CELIGO_MAX_RETRIES` | no | `3` | Retries for `429` and `5xx` responses. |

### Behavior notes

- Dry run is the default, so an accidental run cannot delete anything.
- Deletes run in small batches and back off on `429`, honoring `Retry-After`.
- A failed flow delete does not stop the run; every failure is reported in the
  summary and the process exits non-zero.
- If any flow fails to delete, the integration is left alone even when
  `--delete-integration` was passed.
- The token is never logged. API failures report only the status code, since
  response bodies can echo request context.
- Exports, imports, connections and scripts are left in place. integrator.io
  only requires flows to be removed before deleting an integration.

### Tests

```bash
node --test
```

Covers config validation, argument parsing, flow selection, integration name
resolution, batch deletion including partial failure, and retry backoff. No
network access.
