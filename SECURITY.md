# Security Policy

## API keys

Never commit a real provider key. Browser-supplied keys are stored in `sessionStorage`, sent only to the self-hosted backend for generation requests, and are not written to history or output files.

If a key has appeared in source code or Git history, removing the text is not enough. Revoke the key at the provider, create a new one, and review usage and billing records.

## Public deployment

- Keep `ALLOW_PRIVATE_PROVIDER_HOSTS=0` and `ALLOW_INSECURE_PROVIDER_HTTP=0`.
- Restrict `ALLOWED_ORIGINS` to the deployed frontend origin when frontend and backend are separated.
- Add authentication, rate limits, quotas, and persistent storage before offering a shared paid service.
- Do not log `X-Provider-Api-Key`, request headers, or complete request bodies.

## Reporting

Before publishing the repository, replace this section with a private security contact or enable GitHub private vulnerability reporting.
